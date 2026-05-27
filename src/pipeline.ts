import { once } from "node:events";
import { createWriteStream, readFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stderr } from "node:process";
import { Readable, Writable } from "node:stream";
import PQueue from "p-queue";
import picocolors from "picocolors";
import { z } from "zod";
import {
  loadConfig,
  type Config,
  type ExtractionFieldType,
  type ExtractionConfig,
  type LLMConfig as AppLLMConfig,
  type ResearchConfig,
} from "./config.js";
import { LLMClient, type LLMConfig } from "./llm.js";
import {
  formatQuery,
  formatSearchResults,
  searchWeb,
  type SearchResult,
} from "./search.js";

export interface PipelineOptions {
  config: string;
  inputPath?: string;
  outputPath?: string;
  skipFields: string[];
  workers: number;
  dryRun: boolean;
  verbose: number;
  stdin?: Readable;
  stdout?: Writable;
  llmClient?: Pick<LLMClient, "extract">;
  searchFn?: typeof searchWeb;
}

export interface PipelineRecord {
  [key: string]: unknown;
  id?: string | number;
  _id?: string | number;
}

interface InputData {
  rawContent: string;
  records: PipelineRecord[];
}

interface ProcessResult {
  record: PipelineRecord;
  success: boolean;
  error?: string;
  skipped?: boolean;
}

const extractionFieldValidators: Record<
  ExtractionFieldType,
  z.ZodType<unknown>
> = {
  string: z.string(),
  number: z.number(),
  boolean: z.boolean(),
  integer: z.number().int(),
  array: z.array(z.unknown()),
  object: z.record(z.string(), z.unknown()),
  null: z.null(),
  unknown: z.unknown(),
  any: z.any(),
};

function formatRecordId(record: PipelineRecord, index: number): string {
  if (record.id !== undefined) {
    return String(record.id);
  }

  if (record._id !== undefined) {
    return String(record._id);
  }

  return `#${index + 1}`;
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return true;
}

export function shouldSkipRecord(
  record: PipelineRecord,
  skipFields: string[],
): boolean {
  if (skipFields.length === 0) {
    return false;
  }

  return skipFields.every((field) => hasMeaningfulValue(record[field]));
}

function logMessage(
  message: string,
  verbosity: number,
  minLevel: number,
): void {
  if (verbosity >= minLevel) {
    stderr.write(`${message}\n`);
  }
}

function logProgress(
  current: number,
  total: number,
  recordId: string,
  verbosity: number,
): void {
  if (verbosity >= 1) {
    const prefix = picocolors.dim(`[${current}/${total}]`);
    const action = picocolors.cyan("Processing");
    stderr.write(`${prefix} ${action} ${recordId}\n`);
  }
}

function logRecordError(
  recordId: string,
  error: Error,
  verbosity: number,
): void {
  const prefix = picocolors.red("[ERROR]");
  const message = verbosity >= 2 ? error.stack || error.message : error.message;
  stderr.write(`${prefix} Record ${recordId}: ${message}\n`);
}

function createRateLimitedQueue(
  requestsPerMinute: number,
  concurrency: number,
): PQueue {
  return new PQueue({
    concurrency,
    intervalCap: requestsPerMinute,
    interval: 60_000,
    carryoverConcurrencyCount: true,
  });
}

function createExtractionOutputSchema(
  extractionConfig: ExtractionConfig,
): z.ZodObject<Record<string, z.ZodType<unknown>>> {
  const shape = Object.fromEntries(
    Object.entries(extractionConfig.schema).map(([key, value]) => [
      key,
      extractionFieldValidators[value.type],
    ]),
  ) as Record<string, z.ZodType<unknown>>;

  return z.object(shape).strict();
}

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function validateExtractionOutput(
  extractionSchema: z.ZodObject<Record<string, z.ZodType<unknown>>>,
  extracted: Record<string, unknown>,
): Record<string, unknown> {
  const result = extractionSchema.safeParse(extracted);

  if (!result.success) {
    throw new Error(
      `LLM response does not match extraction schema: ${formatValidationError(
        result.error,
      )}`,
    );
  }

  return result.data;
}

function parseInputContent(content: string): PipelineRecord[] {
  const trimmed = content.trim();

  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed as PipelineRecord[];
    }

    if (parsed !== null && typeof parsed === "object") {
      return [parsed as PipelineRecord];
    }

    throw new Error("Input JSON must be an object or array");
  } catch (jsonError) {
    const lines = trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const records: PipelineRecord[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
        ) {
          records.push(parsed as PipelineRecord);
          continue;
        }

        throw new Error("JSONL line must be an object");
      } catch {
        throw new Error(
          `Input is neither valid JSON nor valid JSONL: ${
            jsonError instanceof Error ? jsonError.message : String(jsonError)
          }`,
        );
      }
    }

    return records;
  }
}

async function readInputSource(
  inputPath: string | undefined,
  stdinStream: Readable | undefined,
): Promise<InputData> {
  if (inputPath) {
    const rawContent = readFileSync(inputPath, "utf-8");
    return {
      rawContent,
      records: parseInputContent(rawContent),
    };
  }

  const source = stdinStream ?? process.stdin;
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawContent = Buffer.concat(chunks).toString("utf-8");
  return {
    rawContent,
    records: parseInputContent(rawContent),
  };
}

export async function loadInputData(
  inputPath?: string,
  stdinStream?: Readable,
): Promise<PipelineRecord[]> {
  const { records } = await readInputSource(inputPath, stdinStream);
  return records;
}

export function detectJsonlFormat(content: string): boolean {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return false;
  }

  return lines.every((line) => {
    try {
      const parsed = JSON.parse(line);
      return (
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      );
    } catch {
      return false;
    }
  });
}

function shouldUseJsonlOutput(
  rawContent: string,
  inputPath: string | undefined,
  outputPath: string | undefined,
): boolean {
  if (outputPath?.toLowerCase().endsWith(".jsonl")) {
    return true;
  }

  if (outputPath?.toLowerCase().endsWith(".json")) {
    return false;
  }

  if (inputPath?.toLowerCase().endsWith(".jsonl")) {
    return true;
  }

  return detectJsonlFormat(rawContent);
}

export async function saveOutputData(
  records: PipelineRecord[],
  outputPath?: string,
  stdoutStream?: Writable,
  useJsonl = false,
): Promise<void> {
  async function writeRecords(destination: Writable): Promise<void> {
    const chunks = useJsonl
      ? records.map((record) => `${JSON.stringify(record)}\n`)
      : [JSON.stringify(records, null, 2)];

    for (const chunk of chunks) {
      const canContinue = destination.write(chunk);
      if (!canContinue) {
        await once(destination, "drain");
      }
    }
  }

  if (outputPath) {
    const tempOutputPath = join(
      dirname(outputPath),
      `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
    );
    const writeStream = createWriteStream(tempOutputPath);

    try {
      await writeRecords(writeStream);
      writeStream.end();
      await Promise.race([
        once(writeStream, "finish").then(() => undefined),
        once(writeStream, "error").then(([error]) => Promise.reject(error)),
      ]);
      await rename(tempOutputPath, outputPath);
    } catch (error) {
      writeStream.destroy();
      await rm(tempOutputPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return;
  }

  await writeRecords(stdoutStream ?? process.stdout);
}

function resolveLLMConfig(config: AppLLMConfig): LLMConfig {
  const apiKey = process.env[config.apiKeyEnv];

  if (!apiKey) {
    throw new Error(
      `Missing API key. Set the ${config.apiKeyEnv} environment variable or update llm.apiKeyEnv in the config.`,
    );
  }

  return {
    model: config.model,
    apiUrl: config.apiUrl,
    apiKey,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    requestsPerMinute: config.requestsPerMinute,
    maxConcurrency: config.maxConcurrency,
  };
}

function createExtractionPrompts(
  config: Config,
  record: PipelineRecord,
  query: string,
  searchResults: SearchResult[],
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    config.extraction.prompt.trim(),
    "",
    "Return exactly one JSON object matching this schema:",
    JSON.stringify(config.extraction.schema, null, 2),
  ].join("\n");

  const userPrompt = [
    "Input record:",
    JSON.stringify(record, null, 2),
    "",
    `Search query: ${query}`,
    "",
    "Search results:",
    formatSearchResults(searchResults),
  ].join("\n");

  return { systemPrompt, userPrompt };
}

async function processRecord(
  record: PipelineRecord,
  config: Config,
  llmClient: Pick<LLMClient, "extract"> | undefined,
  extractionSchema: z.ZodObject<Record<string, z.ZodType<unknown>>>,
  searchFn: typeof searchWeb,
  searchQueue: PQueue,
  llmQueue: PQueue,
  options: PipelineOptions,
  index: number,
  total: number,
): Promise<ProcessResult> {
  const recordId = formatRecordId(record, index);

  try {
    if (shouldSkipRecord(record, options.skipFields)) {
      logMessage(
        picocolors.yellow(
          `[${index + 1}/${total}] Skipping ${recordId} (already enriched)`,
        ),
        options.verbose,
        2,
      );
      return { record, success: true, skipped: true };
    }

    logProgress(index + 1, total, recordId, options.verbose);

    if (options.dryRun) {
      logMessage(
        picocolors.dim(`[DRY RUN] Would process ${recordId}`),
        options.verbose,
        1,
      );
      return { record, success: true };
    }

    if (!llmClient) {
      throw new Error("LLM client is not initialized");
    }

    const query = formatQuery(config.research.searchQuery, record);
    logMessage(picocolors.dim(`  Query: ${query}`), options.verbose, 2);

    const searchResults = await searchQueue.add<SearchResult[]>(() =>
      searchFn(query, {
        provider: config.research.provider,
        maxResults: config.research.maxResults,
        region: config.research.region,
        timeoutMs: config.research.timeoutMs,
        maxRetries: config.research.maxRetries,
      }),
    );
    if (!searchResults) {
      throw new Error("Search queue task did not return results");
    }
    logMessage(
      picocolors.dim(`  Found ${searchResults.length} search results`),
      options.verbose,
      2,
    );

    const { systemPrompt, userPrompt } = createExtractionPrompts(
      config,
      record,
      query,
      searchResults,
    );
    const extractionResult = await llmQueue.add<Record<string, unknown>>(() =>
      llmClient.extract(systemPrompt, userPrompt),
    );
    if (!extractionResult) {
      throw new Error("LLM queue task did not return extracted data");
    }
    const extracted = validateExtractionOutput(
      extractionSchema,
      extractionResult,
    );
    logMessage(
      picocolors.dim(`  Extracted ${Object.keys(extracted).length} fields`),
      options.verbose,
      2,
    );

    return {
      record: {
        ...record,
        ...extracted,
      },
      success: true,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logRecordError(recordId, err, options.verbose);

    return { record, success: false, error: err.message };
  }
}

export async function runPipeline(options: PipelineOptions): Promise<void> {
  logMessage(picocolors.dim("Loading configuration..."), options.verbose, 2);
  const config = loadConfig(options.config);
  logMessage(picocolors.green("Configuration loaded"), options.verbose, 2);

  logMessage(picocolors.dim("Reading input..."), options.verbose, 2);
  const { rawContent, records: inputRecords } = await readInputSource(
    options.inputPath,
    options.stdin,
  );
  logMessage(
    picocolors.green(`Loaded ${inputRecords.length} records`),
    options.verbose,
    1,
  );

  if (inputRecords.length === 0) {
    logMessage(picocolors.yellow("No records to process"), options.verbose, 1);
    return;
  }

  const useJsonl = shouldUseJsonlOutput(
    rawContent,
    options.inputPath,
    options.outputPath,
  );
  const llmClient = options.dryRun
    ? undefined
    : (options.llmClient ?? new LLMClient(resolveLLMConfig(config.llm)));
  const extractionSchema = createExtractionOutputSchema(config.extraction);
  const searchFn = options.searchFn ?? searchWeb;
  const searchQueue = createRateLimitedQueue(
    config.research.requestsPerMinute,
    config.research.maxConcurrency,
  );
  const llmQueue = createRateLimitedQueue(
    config.llm.requestsPerMinute,
    config.llm.maxConcurrency,
  );

  logMessage(
    picocolors.dim(`Processing with ${options.workers} workers...`),
    options.verbose,
    1,
  );
  logMessage(
    picocolors.dim(
      `Search throttled to ${config.research.requestsPerMinute} req/min with concurrency ${config.research.maxConcurrency}`,
    ),
    options.verbose,
    2,
  );
  logMessage(
    picocolors.dim(
      `LLM throttled to ${config.llm.requestsPerMinute} req/min with concurrency ${config.llm.maxConcurrency}`,
    ),
    options.verbose,
    2,
  );

  const queue = new PQueue({ concurrency: options.workers });
  const results: ProcessResult[] = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  const tasks = inputRecords.map((record, index) =>
    queue.add(async () => {
      const result = await processRecord(
        record,
        config,
        llmClient,
        extractionSchema,
        searchFn,
        searchQueue,
        llmQueue,
        options,
        index,
        inputRecords.length,
      );

      results[index] = result;
      processed++;

      if (result.skipped) {
        skipped++;
      } else if (result.success) {
        succeeded++;
      } else {
        failed++;
      }

      if (options.verbose >= 1 && processed % 10 === 0) {
        stderr.write(
          picocolors.dim(
            `  Progress: ${processed}/${inputRecords.length} (${succeeded} ok, ${failed} failed, ${skipped} skipped)\n`,
          ),
        );
      }
    }),
  );

  await Promise.all(tasks);

  if (failed > 0) {
    logMessage(
      picocolors.yellow(
        "Skipping output write because one or more records failed",
      ),
      options.verbose,
      1,
    );
    const error = new Error(`${failed} record(s) failed to process`);
    (error as Error & { exitCode: number }).exitCode = 1;
    throw error;
  }

  logMessage(picocolors.dim("Writing output..."), options.verbose, 2);
  await saveOutputData(
    results.map((result) => result.record),
    options.outputPath,
    options.stdout,
    useJsonl,
  );

  if (options.verbose >= 1) {
    stderr.write("\n");
    stderr.write(picocolors.bold("Pipeline complete:\n"));
    stderr.write(`  Total:     ${inputRecords.length}\n`);
    stderr.write(`  Succeeded: ${picocolors.green(String(succeeded))}\n`);
    stderr.write("  Failed:    0\n");
    stderr.write(
      `  Skipped:   ${skipped > 0 ? picocolors.yellow(String(skipped)) : "0"}\n`,
    );
  }
}

export type {
  Config,
  ExtractionConfig,
  LLMConfig as RuntimeLLMConfig,
  ResearchConfig,
};

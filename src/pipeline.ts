import { existsSync, readFileSync } from "node:fs";
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
import { LLMClient, buildJsonSchema, type LLMConfig } from "./llm.js";
import {
  formatQuery,
  formatSearchResults,
  searchWeb,
  type SearchResult,
} from "./search.js";
import { fetchPageContent, type PageContent } from "./fetcher.js";
import {
  computeRecordKey,
  createRecordWriter,
  detectJsonlFormat,
  readExistingRecords,
} from "./output.js";
export { detectJsonlFormat };

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
  fetchFn?: typeof fetchPageContent;
  /** Resume an interrupted batch by skipping records already in the output. */
  resume?: boolean;
  /** Field used to identify records for --resume (default "id"). */
  resumeKey?: string;
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

/**
 * Writes records in a single batch. Kept as a thin wrapper over the
 * RecordWriter so legacy callers (and tests) keep working while runPipeline
 * streams through the same writer implementation.
 */
export async function saveOutputData(
  records: PipelineRecord[],
  outputPath?: string,
  stdoutStream?: Writable,
  useJsonl = false,
): Promise<void> {
  const writer = createRecordWriter({
    outputPath,
    stdoutStream,
    useJsonl,
    append: false,
  });
  for (const record of records) {
    await writer.writeRecord(record);
  }
  await writer.close();
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
    structuredOutput: config.structuredOutput,
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

async function fetchResultPages(
  searchResults: SearchResult[],
  config: Config,
  fetchFn: typeof fetchPageContent,
  fetchQueue: PQueue,
  verbose: number,
): Promise<SearchResult[]> {
  if (!config.research.fetchPageContent || searchResults.length === 0) {
    return searchResults;
  }

  const fetched = await Promise.all(
    searchResults.map((result) =>
      fetchQueue
        .add<PageContent | null>(() =>
          fetchFn(result.url, {
            maxChars: config.research.maxPageChars,
            timeoutMs: config.research.pageFetchTimeoutMs,
            maxRetries: config.research.pageFetchMaxRetries,
          }).then(
            (page) => page,
            (error: unknown) => {
              logMessage(
                picocolors.yellow(
                  `  Warning: failed to fetch ${result.url}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                ),
                verbose,
                1,
              );
              return null;
            },
          ),
        )
        .catch(() => null),
    ),
  );

  return searchResults.map((result, index) => {
    const page = fetched[index];
    if (page && page.text.trim()) {
      logMessage(
        picocolors.dim(
          `  Fetched page for ${result.url}, chars=${page.text.length}`,
        ),
        verbose,
        2,
      );
      return {
        title: result.title,
        url: result.url,
        snippet: page.text,
      };
    }
    return result;
  });
}

async function processRecord(
  record: PipelineRecord,
  config: Config,
  llmClient: Pick<LLMClient, "extract"> | undefined,
  extractionSchema: z.ZodObject<Record<string, z.ZodType<unknown>>>,
  searchFn: typeof searchWeb,
  fetchFn: typeof fetchPageContent,
  searchQueue: PQueue,
  fetchQueue: PQueue,
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
        ...(config.research.fetchPageContent
          ? { maxSnippetChars: config.research.maxPageChars }
          : {}),
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

    const enrichedResults = await fetchResultPages(
      searchResults,
      config,
      fetchFn,
      fetchQueue,
      options.verbose,
    );

    const { systemPrompt, userPrompt } = createExtractionPrompts(
      config,
      record,
      query,
      enrichedResults,
    );
    const schemaJson = buildJsonSchema(config.extraction.schema);
    const extractionResult = await llmQueue.add<Record<string, unknown>>(() =>
      llmClient.extract(systemPrompt, userPrompt, schemaJson),
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

    const enrichedRecord: PipelineRecord = {
      ...record,
      ...extracted,
    };

    if (config.extraction.includeSources) {
      const sources = searchResults
        .filter((result) => typeof result.url === "string" && result.url.length > 0)
        .map((result) => ({ url: result.url, title: result.title }));
      enrichedRecord[config.extraction.sourcesField] = sources;
    }

    return {
      record: enrichedRecord,
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

  let useJsonl = shouldUseJsonlOutput(
    rawContent,
    options.inputPath,
    options.outputPath,
  );

  const resumeEnabled = options.resume === true;
  const resumeKey = options.resumeKey ?? "id";
  const completedKeys = new Set<string>();
  let appendMode = false;

  if (resumeEnabled) {
    if (!options.outputPath) {
      logMessage(
        picocolors.yellow(
          "--resume requires a file output (--output); ignoring --resume for stdout",
        ),
        options.verbose,
        1,
      );
    } else {
      if (!useJsonl) {
        useJsonl = true;
        logMessage(
          picocolors.yellow(
            `--resume requires JSONL output; switching ${options.outputPath} to JSONL`,
          ),
          options.verbose,
          1,
        );
      }

      if (existsSync(options.outputPath)) {
        const existing = readExistingRecords(options.outputPath);
        for (let i = 0; i < existing.length; i++) {
          const existingRecord = existing[i];
          if (existingRecord) {
            completedKeys.add(computeRecordKey(existingRecord, resumeKey, i));
          }
        }
        appendMode = true;
        logMessage(
          picocolors.dim(
            `--resume: ${existing.length} record(s) already in output, will skip them`,
          ),
          options.verbose,
          1,
        );
      } else {
        logMessage(
          picocolors.dim("--resume: output file not found, starting fresh"),
          options.verbose,
          1,
        );
      }
    }
  }

  const writer = createRecordWriter({
    outputPath: options.outputPath,
    stdoutStream: options.stdout,
    useJsonl,
    append: appendMode,
  });

  const llmClient = options.dryRun
    ? undefined
    : (options.llmClient ?? new LLMClient(resolveLLMConfig(config.llm)));
  const extractionSchema = createExtractionOutputSchema(config.extraction);
  const searchFn = options.searchFn ?? searchWeb;
  const fetchFn = options.fetchFn ?? fetchPageContent;
  const searchQueue = createRateLimitedQueue(
    config.research.requestsPerMinute,
    config.research.maxConcurrency,
  );
  const fetchQueue = createRateLimitedQueue(
    config.research.pageFetchRequestsPerMinute,
    config.research.pageFetchMaxConcurrency,
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

  if (config.research.fetchPageContent) {
    logMessage(
      picocolors.dim(
        `Page fetch throttled to ${config.research.pageFetchRequestsPerMinute} req/min with concurrency ${config.research.pageFetchMaxConcurrency} (max ${config.research.maxPageChars} chars)`,
      ),
      options.verbose,
      2,
    );
  }

  const queue = new PQueue({ concurrency: options.workers });
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let resumedSkipped = 0;
  let written = 0;

  const tasks = inputRecords.map((record, index) =>
    queue.add(async () => {
      if (resumeEnabled && completedKeys.size > 0) {
        const key = computeRecordKey(record, resumeKey, index);
        if (completedKeys.has(key)) {
          logMessage(
            picocolors.dim(`Skipping ${key} (already in output, --resume)`),
            options.verbose,
            1,
          );
          resumedSkipped++;
          return;
        }
      }

      const result = await processRecord(
        record,
        config,
        llmClient,
        extractionSchema,
        searchFn,
        fetchFn,
        searchQueue,
        fetchQueue,
        llmQueue,
        options,
        index,
        inputRecords.length,
      );

      processed++;

      if (result.skipped) {
        skipped++;
      } else if (result.success) {
        succeeded++;
      } else {
        failed++;
      }

      if (result.success) {
        await writer.writeRecord(result.record);
        written++;
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

  let unexpected: unknown = null;
  try {
    await Promise.all(tasks);
  } catch (error) {
    unexpected = error;
  }

  const aborted = failed > 0 || unexpected !== null;
  try {
    if (aborted && !useJsonl) {
      // JSON-array output keeps the historical abort semantics: nothing is
      // written when any record fails.
      await writer.discard();
    } else {
      // For JSONL, already-streamed records persist on abort by design; close
      // flushes the stream. On success this writes the buffered array.
      await writer.close();
    }
  } catch (closeError) {
    if (!aborted) {
      throw closeError;
    }
    // On abort, surface the original failure rather than the close error.
  }

  if (unexpected !== null) {
    throw unexpected;
  }

  if (aborted) {
    if (useJsonl) {
      logMessage(
        picocolors.yellow(
          `${written} record(s) already streamed to output; re-run with --resume to continue`,
        ),
        options.verbose,
        1,
      );
    } else {
      logMessage(
        picocolors.yellow(
          "Skipping output write because one or more records failed",
        ),
        options.verbose,
        1,
      );
    }
    const error = new Error(`${failed} record(s) failed to process`);
    (error as Error & { exitCode: number }).exitCode = 1;
    throw error;
  }

  logMessage(
    picocolors.green(`Wrote ${written} record(s) to output`),
    options.verbose,
    2,
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
    if (resumedSkipped > 0) {
      stderr.write(
        `  Resumed:   ${picocolors.dim(
          String(resumedSkipped),
        )} (skipped via --resume)\n`,
      );
    }
  }
}

export type {
  Config,
  ExtractionConfig,
  LLMConfig as RuntimeLLMConfig,
  ResearchConfig,
};
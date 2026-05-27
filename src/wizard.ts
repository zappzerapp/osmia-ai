import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { Readable, Writable } from "node:stream";
import picocolors from "picocolors";
import {
  serializeConfig,
  supportedExtractionFieldTypes,
  validateConfig,
  type Config,
  type ExtractionFieldType,
} from "./config.js";

const defaultExtractionPrompt = [
  "You enrich records using public web information.",
  "Use the search results to extract only facts that are supported by the sources.",
  "If a value cannot be determined confidently, return null or an empty value that still matches the schema.",
  "",
  "Respond ONLY as a JSON object.",
].join("\n");

export interface ConfigWizardOptions {
  outputPath?: string;
  stdin?: Readable;
  stdout?: Writable;
  cwd?: string;
  allowNonTTY?: boolean;
}

export interface ConfigWizardResult {
  path: string;
  config: Config;
  yaml: string;
}

interface PromptContext {
  stdin: Readable;
  stdout: Writable;
}

interface TTYLikeStream {
  isTTY?: boolean;
}

function createDefaultConfig(): Config {
  return validateConfig({
    llm: {
      model: "kimi-k2.5",
      apiUrl: "https://ollama.com/api/chat",
      timeout: 60000,
      maxRetries: 3,
      requestsPerMinute: 30,
      maxConcurrency: 1,
      apiKeyEnv: "OLLAMA_API_KEY",
    },
    research: {
      searchQuery: "Product {name} {sku} specifications overview",
      maxResults: 5,
      region: "de-de",
      timeoutMs: 10000,
      maxRetries: 3,
      requestsPerMinute: 30,
      maxConcurrency: 1,
    },
    extraction: {
      prompt: defaultExtractionPrompt,
      schema: {
        summary: {
          type: "string",
          description: "Short factual summary",
        },
        category: {
          type: "string",
          description: "Most likely category",
        },
      },
    },
  });
}

function writeLine(output: Writable, message = ""): void {
  output.write(`${message}\n`);
}

function isInteractiveStream(stream: TTYLikeStream | undefined): boolean {
  return stream?.isTTY === true;
}

function assertInteractiveTerminal(stdin: Readable, stdout: Writable): void {
  if (
    isInteractiveStream(stdin as Readable & TTYLikeStream) &&
    isInteractiveStream(stdout as Writable & TTYLikeStream)
  ) {
    return;
  }

  throw new Error(
    'The config wizard requires an interactive terminal. Run "osmia-ai init" directly in a TTY or pass "--config <path>" for non-interactive usage.',
  );
}

function formatPrompt(label: string, defaultValue?: string | number): string {
  return defaultValue === undefined
    ? `${label}: `
    : `${label} [${defaultValue}]: `;
}

async function promptText(
  rl: ReturnType<typeof createInterface>,
  output: Writable,
  label: string,
  options: {
    defaultValue?: string;
    allowEmpty?: boolean;
    validate?: (value: string) => string | undefined;
  } = {},
): Promise<string> {
  while (true) {
    const answer = (
      await rl.question(formatPrompt(label, options.defaultValue))
    ).trim();
    const value = answer || options.defaultValue || "";

    if (!options.allowEmpty && value.length === 0) {
      writeLine(output, picocolors.red("Please enter a value."));
      continue;
    }

    const validationMessage = options.validate?.(value);
    if (validationMessage) {
      writeLine(output, picocolors.red(validationMessage));
      continue;
    }

    return value;
  }
}

async function promptNumber(
  rl: ReturnType<typeof createInterface>,
  output: Writable,
  label: string,
  defaultValue: number,
  validate?: (value: number) => string | undefined,
): Promise<number> {
  while (true) {
    const answer = (
      await rl.question(formatPrompt(label, defaultValue))
    ).trim();
    const rawValue = answer.length === 0 ? String(defaultValue) : answer;
    const value = Number(rawValue);

    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      writeLine(output, picocolors.red("Please enter a whole number."));
      continue;
    }

    const validationMessage = validate?.(value);
    if (validationMessage) {
      writeLine(output, picocolors.red(validationMessage));
      continue;
    }

    return value;
  }
}

async function promptConfirm(
  rl: ReturnType<typeof createInterface>,
  output: Writable,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? "Y/n" : "y/N";

  while (true) {
    const answer = (await rl.question(`${label} [${suffix}]: `))
      .trim()
      .toLowerCase();

    if (answer.length === 0) {
      return defaultValue;
    }

    if (["y", "yes", "j", "ja"].includes(answer)) {
      return true;
    }

    if (["n", "no", "nein"].includes(answer)) {
      return false;
    }

    writeLine(output, picocolors.red("Please answer with yes or no."));
  }
}

async function promptMultiline(
  rl: ReturnType<typeof createInterface>,
  output: Writable,
  label: string,
  defaultValue: string,
): Promise<string> {
  const useDefault = await promptConfirm(
    rl,
    output,
    `${label} Use the default prompt`,
    true,
  );

  if (useDefault) {
    return defaultValue;
  }

  writeLine(
    output,
    `${label} Enter multiple lines and finish with a single "." line.`,
  );
  const lines: string[] = [];

  while (true) {
    const line = await rl.question("> ");
    if (line.trim() === ".") {
      break;
    }
    lines.push(line);
  }

  const value = lines.join("\n").trim();
  if (value.length === 0) {
    writeLine(
      output,
      picocolors.yellow(
        "Using the default prompt because no custom prompt was entered.",
      ),
    );
    return defaultValue;
  }

  return value;
}

async function promptFieldType(
  rl: ReturnType<typeof createInterface>,
  output: Writable,
): Promise<ExtractionFieldType> {
  writeLine(output, "Available field types:");
  supportedExtractionFieldTypes.forEach((type, index) => {
    writeLine(output, `  ${index + 1}. ${type}`);
  });

  while (true) {
    const answer = (await rl.question("Field type [string]: "))
      .trim()
      .toLowerCase();

    if (answer.length === 0) {
      return "string";
    }

    const byName = supportedExtractionFieldTypes.find(
      (type) => type === answer,
    );
    if (byName) {
      return byName;
    }

    const byIndex = Number(answer);
    if (Number.isInteger(byIndex)) {
      const type = supportedExtractionFieldTypes[byIndex - 1];
      if (type) {
        return type;
      }
    }

    writeLine(
      output,
      picocolors.red(
        `Choose one of: ${supportedExtractionFieldTypes.join(", ")}`,
      ),
    );
  }
}

async function promptSchema(
  rl: ReturnType<typeof createInterface>,
  output: Writable,
): Promise<Config["extraction"]["schema"]> {
  const schema: Config["extraction"]["schema"] = {};
  let fieldNumber = 1;

  writeLine(output);
  writeLine(output, picocolors.cyan("Extraction Schema"));
  writeLine(
    output,
    "Add fields that the LLM should return. Leave the field name empty to finish.",
  );

  while (true) {
    const fieldName = await promptText(
      rl,
      output,
      `Field ${fieldNumber} name`,
      {
        allowEmpty: fieldNumber > 1,
        validate: (value) => {
          if (value.length === 0) {
            return undefined;
          }

          if (schema[value]) {
            return "This field already exists.";
          }

          return undefined;
        },
      },
    );

    if (fieldName.length === 0) {
      break;
    }

    const type = await promptFieldType(rl, output);
    const description = await promptText(
      rl,
      output,
      "Field description (optional)",
      {
        allowEmpty: true,
      },
    );

    schema[fieldName] =
      description.length > 0 ? { type, description } : { type };
    fieldNumber += 1;
  }

  if (Object.keys(schema).length === 0) {
    writeLine(output, picocolors.red("At least one schema field is required."));
    return promptSchema(rl, output);
  }

  return schema;
}

async function collectWizardAnswers({
  stdin,
  stdout,
  outputPath,
  cwd,
}: PromptContext & {
  outputPath?: string;
  cwd: string;
}): Promise<ConfigWizardResult> {
  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean(
      (stdin as Readable & { isTTY?: boolean }).isTTY &&
      (stdout as Writable & { isTTY?: boolean }).isTTY,
    ),
  });

  const defaults = createDefaultConfig();

  try {
    writeLine(stdout, picocolors.bold("Osmia Config Wizard"));
    writeLine(stdout, "This wizard creates a YAML config for osmia-ai.");
    writeLine(stdout);

    const targetPathInput = await promptText(rl, stdout, "Config path", {
      defaultValue: outputPath ?? "config.yaml",
    });
    const resolvedPath = resolve(cwd, targetPathInput);

    if (existsSync(resolvedPath)) {
      const overwrite = await promptConfirm(
        rl,
        stdout,
        `File "${resolvedPath}" already exists. Overwrite`,
        false,
      );

      if (!overwrite) {
        throw new Error(
          "Wizard aborted because the target file already exists.",
        );
      }
    }

    writeLine(stdout);
    writeLine(stdout, picocolors.cyan("LLM"));
    const model = await promptText(rl, stdout, "Model", {
      defaultValue: defaults.llm.model,
    });
    const apiUrl = await promptText(rl, stdout, "API URL", {
      defaultValue: defaults.llm.apiUrl,
      validate: (value) => {
        try {
          new URL(value);
          return undefined;
        } catch {
          return "Please enter a valid URL.";
        }
      },
    });
    const timeout = await promptNumber(
      rl,
      stdout,
      "Timeout in ms",
      defaults.llm.timeout,
      (value) => (value > 0 ? undefined : "Timeout must be greater than 0."),
    );
    const llmRetries = await promptNumber(
      rl,
      stdout,
      "LLM max retries",
      defaults.llm.maxRetries,
      (value) => (value > 0 ? undefined : "Retries must be greater than 0."),
    );
    const llmRequestsPerMinute = await promptNumber(
      rl,
      stdout,
      "LLM requests per minute",
      defaults.llm.requestsPerMinute,
      (value) =>
        value > 0 ? undefined : "Requests per minute must be greater than 0.",
    );
    const llmConcurrency = await promptNumber(
      rl,
      stdout,
      "LLM max concurrency",
      defaults.llm.maxConcurrency,
      (value) =>
        value > 0 ? undefined : "Concurrency must be greater than 0.",
    );
    const apiKeyEnv = await promptText(rl, stdout, "API key env variable", {
      defaultValue: defaults.llm.apiKeyEnv,
    });

    writeLine(stdout);
    writeLine(stdout, picocolors.cyan("Research"));
    const searchQuery = await promptText(rl, stdout, "Search query template", {
      defaultValue: defaults.research.searchQuery,
    });
    const maxResults = await promptNumber(
      rl,
      stdout,
      "Max search results",
      defaults.research.maxResults,
      (value) =>
        value > 0 ? undefined : "Max results must be greater than 0.",
    );
    const region = await promptText(rl, stdout, "Search region", {
      defaultValue: defaults.research.region,
    });
    const searchTimeout = await promptNumber(
      rl,
      stdout,
      "Search timeout in ms",
      defaults.research.timeoutMs,
      (value) => (value > 0 ? undefined : "Timeout must be greater than 0."),
    );
    const searchRetries = await promptNumber(
      rl,
      stdout,
      "Search max retries",
      defaults.research.maxRetries,
      (value) => (value > 0 ? undefined : "Retries must be greater than 0."),
    );
    const searchRequestsPerMinute = await promptNumber(
      rl,
      stdout,
      "Search requests per minute",
      defaults.research.requestsPerMinute,
      (value) =>
        value > 0 ? undefined : "Requests per minute must be greater than 0.",
    );
    const searchConcurrency = await promptNumber(
      rl,
      stdout,
      "Search max concurrency",
      defaults.research.maxConcurrency,
      (value) =>
        value > 0 ? undefined : "Concurrency must be greater than 0.",
    );

    writeLine(stdout);
    writeLine(stdout, picocolors.cyan("Extraction"));
    const prompt = await promptMultiline(
      rl,
      stdout,
      "Extraction prompt.",
      defaults.extraction.prompt,
    );
    const schema = await promptSchema(rl, stdout);

    const config = validateConfig({
      llm: {
        model,
        apiUrl,
        timeout,
        maxRetries: llmRetries,
        requestsPerMinute: llmRequestsPerMinute,
        maxConcurrency: llmConcurrency,
        apiKeyEnv,
      },
      research: {
        searchQuery,
        maxResults,
        region,
        timeoutMs: searchTimeout,
        maxRetries: searchRetries,
        requestsPerMinute: searchRequestsPerMinute,
        maxConcurrency: searchConcurrency,
      },
      extraction: {
        prompt,
        schema,
      },
    });

    const yaml = serializeConfig(config);
    return {
      path: resolvedPath,
      config,
      yaml,
    };
  } finally {
    rl.close();
  }
}

export async function runConfigWizard(
  options: ConfigWizardOptions = {},
): Promise<ConfigWizardResult> {
  const stdin = options.stdin ?? defaultStdin;
  const stdout = options.stdout ?? defaultStdout;

  if (!options.allowNonTTY) {
    assertInteractiveTerminal(stdin, stdout);
  }

  const result = await collectWizardAnswers({
    stdin,
    stdout,
    cwd: options.cwd ?? process.cwd(),
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
  });

  mkdirSync(dirname(result.path), { recursive: true });
  writeFileSync(result.path, result.yaml, "utf-8");

  writeLine(stdout);
  writeLine(stdout, picocolors.green(`Config written to ${result.path}`));

  return result;
}

export { createDefaultConfig, defaultExtractionPrompt };

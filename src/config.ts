import { readFileSync } from "node:fs";
import { z } from "zod";
import * as YAML from "yaml";

export const supportedExtractionFieldTypes = [
  "string",
  "number",
  "boolean",
  "integer",
  "array",
  "object",
  "null",
  "unknown",
  "any",
] as const;

const extractionFieldTypeSchema = z.enum(supportedExtractionFieldTypes, {
  message: `Schema field type must be one of: ${supportedExtractionFieldTypes.join(", ")}`,
});

const schemaFieldSchema = z.object({
  type: extractionFieldTypeSchema,
  description: z.string().optional(),
});

const schemaFieldInputSchema = z.preprocess(
  (value) => (typeof value === "string" ? { type: value } : value),
  schemaFieldSchema,
);

const llmConfigInputSchema = z
  .object({
    model: z.string().min(1, "Model name is required"),
    apiUrl: z.string().url("API URL must be a valid URL").optional(),
    api_url: z.string().url("API URL must be a valid URL").optional(),
    timeout: z.number().positive().default(60000),
    maxRetries: z.number().int().positive().default(3),
    max_retries: z.number().int().positive().optional(),
    requestsPerMinute: z.number().int().positive().default(30),
    requests_per_minute: z.number().int().positive().optional(),
    maxConcurrency: z.number().int().positive().default(1),
    max_concurrency: z.number().int().positive().optional(),
    apiKeyEnv: z.string().min(1).default("OLLAMA_API_KEY"),
    api_key_env: z.string().min(1).optional(),
    structuredOutput: z.boolean().default(true),
    structured_output: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.apiUrl && !data.api_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiUrl"],
        message: "API URL is required",
      });
    }
  })
  .transform((data) => ({
    model: data.model,
    apiUrl: data.apiUrl ?? data.api_url!,
    timeout: data.timeout,
    maxRetries: data.max_retries ?? data.maxRetries,
    requestsPerMinute: data.requests_per_minute ?? data.requestsPerMinute,
    maxConcurrency: data.max_concurrency ?? data.maxConcurrency,
    apiKeyEnv: data.api_key_env ?? data.apiKeyEnv,
    structuredOutput: data.structured_output ?? data.structuredOutput,
  }));

export const searchProviders = [
  "exa",
  "duckduckgo",
  "google",
  "ollama",
] as const;
export type SearchProvider = (typeof searchProviders)[number];

const researchConfigInputSchema = z
  .object({
    searchQuery: z.string().min(1, "Search query is required").optional(),
    search_query: z.string().min(1, "Search query is required").optional(),
    provider: z.enum(searchProviders).default("exa"),
    maxResults: z.number().int().positive().default(5),
    max_results: z.number().int().positive().optional(),
    region: z.string().default("de-de"),
    timeoutMs: z.number().int().positive().default(10000),
    timeout_ms: z.number().int().positive().optional(),
    maxRetries: z.number().int().positive().default(3),
    max_retries: z.number().int().positive().optional(),
    requestsPerMinute: z.number().int().positive().default(30),
    requests_per_minute: z.number().int().positive().optional(),
    maxConcurrency: z.number().int().positive().default(1),
    max_concurrency: z.number().int().positive().optional(),
    fetchPageContent: z.boolean().default(false),
    fetch_page_content: z.boolean().optional(),
    maxPageChars: z.number().int().positive().default(8000),
    max_page_chars: z.number().int().positive().optional(),
    pageFetchTimeoutMs: z.number().int().positive().default(15000),
    page_fetch_timeout_ms: z.number().int().positive().optional(),
    pageFetchMaxRetries: z.number().int().positive().default(2),
    page_fetch_max_retries: z.number().int().positive().optional(),
    pageFetchRequestsPerMinute: z.number().int().positive().default(20),
    page_fetch_requests_per_minute: z.number().int().positive().optional(),
    pageFetchMaxConcurrency: z.number().int().positive().default(2),
    page_fetch_max_concurrency: z.number().int().positive().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.searchQuery && !data.search_query) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["searchQuery"],
        message: "Search query is required",
      });
    }
  })
  .transform((data) => ({
    searchQuery: data.searchQuery ?? data.search_query!,
    provider: data.provider,
    maxResults: data.max_results ?? data.maxResults,
    region: data.region,
    timeoutMs: data.timeout_ms ?? data.timeoutMs,
    maxRetries: data.max_retries ?? data.maxRetries,
    requestsPerMinute: data.requests_per_minute ?? data.requestsPerMinute,
    maxConcurrency: data.max_concurrency ?? data.maxConcurrency,
    fetchPageContent: data.fetch_page_content ?? data.fetchPageContent,
    maxPageChars: data.max_page_chars ?? data.maxPageChars,
    pageFetchTimeoutMs: data.page_fetch_timeout_ms ?? data.pageFetchTimeoutMs,
    pageFetchMaxRetries:
      data.page_fetch_max_retries ?? data.pageFetchMaxRetries,
    pageFetchRequestsPerMinute:
      data.page_fetch_requests_per_minute ?? data.pageFetchRequestsPerMinute,
    pageFetchMaxConcurrency:
      data.page_fetch_max_concurrency ?? data.pageFetchMaxConcurrency,
  }));

const extractionConfigInputSchema = z
  .object({
    prompt: z.string().min(1, "Prompt is required"),
    schema: z.record(z.string(), schemaFieldInputSchema),
    includeSources: z.boolean().default(false),
    include_sources: z.boolean().optional(),
    sourcesField: z.string().min(1).default("_sources"),
    sources_field: z.string().min(1).optional(),
  })
  .transform((data) => ({
    prompt: data.prompt,
    schema: data.schema,
    includeSources: data.include_sources ?? data.includeSources,
    sourcesField: data.sources_field ?? data.sourcesField,
  }));

export const llmConfigSchema = llmConfigInputSchema.pipe(
  z.object({
    model: z.string().min(1),
    apiUrl: z.string().url(),
    timeout: z.number().positive(),
    maxRetries: z.number().int().positive(),
    requestsPerMinute: z.number().int().positive(),
    maxConcurrency: z.number().int().positive(),
    apiKeyEnv: z.string().min(1),
    structuredOutput: z.boolean(),
  }),
);

export const researchConfigSchema = researchConfigInputSchema.pipe(
  z.object({
    searchQuery: z.string().min(1),
    provider: z.enum(searchProviders),
    maxResults: z.number().int().positive(),
    region: z.string(),
    timeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().positive(),
    requestsPerMinute: z.number().int().positive(),
    maxConcurrency: z.number().int().positive(),
    fetchPageContent: z.boolean(),
    maxPageChars: z.number().int().positive(),
    pageFetchTimeoutMs: z.number().int().positive(),
    pageFetchMaxRetries: z.number().int().positive(),
    pageFetchRequestsPerMinute: z.number().int().positive(),
    pageFetchMaxConcurrency: z.number().int().positive(),
  }),
);

export const extractionConfigSchema = extractionConfigInputSchema.pipe(
  z.object({
    prompt: z.string().min(1),
    schema: z.record(z.string(), schemaFieldSchema),
    includeSources: z.boolean(),
    sourcesField: z.string().min(1),
  }),
);

export const configSchema = z.object({
  llm: llmConfigSchema,
  research: researchConfigSchema,
  extraction: extractionConfigSchema,
});

export type LLMConfig = z.infer<typeof llmConfigSchema>;
export type ResearchConfig = z.infer<typeof researchConfigSchema>;
export type ExtractionConfig = z.infer<typeof extractionConfigSchema>;
export type Config = z.infer<typeof configSchema>;
export type ExtractionFieldType = z.infer<typeof extractionFieldTypeSchema>;

function formatZodError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `  - ${path}: ${issue.message}`;
  });

  return `Config validation failed:\n${issues.join("\n")}`;
}

export function validateConfig(data: unknown): Config {
  const result = configSchema.safeParse(data);

  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }

  return result.data;
}

export function loadConfig(path: string): Config {
  let fileContent: string;

  try {
    fileContent = readFileSync(path, "utf-8");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read config file at "${path}": ${cause}`);
  }

  let parsedData: unknown;

  try {
    parsedData = YAML.parse(fileContent);
  } catch (yamlError) {
    const yamlCause =
      yamlError instanceof Error ? yamlError.message : String(yamlError);
    throw new Error(`Failed to parse config file as YAML: ${yamlCause}`);
  }

  return validateConfig(parsedData);
}

export function serializeConfig(config: Config): string {
  return YAML.stringify(validateConfig(config), {
    lineWidth: 0,
  });
}

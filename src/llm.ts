import { setTimeout as sleep } from "node:timers/promises";

export interface LLMConfig {
  model: string;
  apiUrl: string;
  apiKey: string;
  timeout?: number;
  maxRetries?: number;
  requestsPerMinute?: number;
  maxConcurrency?: number;
  structuredOutput?: boolean;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly statusCode?: number,
    public readonly retryAfterMs?: number,
    public readonly retryable = true,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
interface LLMRequestPayload {
  model: string;
  format: "json" | Record<string, unknown>;
  messages: LLMMessage[];
  stream: false;
}

interface LLMResponse {
  message?: {
    content?: string;
  };
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(headerValue);
  if (Number.isNaN(retryAt)) {
    return undefined;
  }

  return Math.max(0, retryAt - Date.now());
}

function isRetryableStatus(statusCode: number): boolean {
  return (
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500
  );
}

function isRetryableLLMError(error: unknown): error is LLMError {
  if (!(error instanceof LLMError)) {
    return false;
  }

  return error.retryable;
}

function getRetryDelay(error: LLMError, attemptNumber: number): number {
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }

  return Math.min(30_000, 1000 * 2 ** (attemptNumber - 1));
}

function stripMarkdownCodeBlocks(content: string): string {
  const trimmed = content.trim();
  const codeBlockRegex = /^```(?:\w+)?\s*\n?([\s\S]*?)```$/;
  const match = codeBlockRegex.exec(trimmed);

  if (match?.[1]) {
    return match[1].trim();
  }

  return trimmed;
}

function createContentSnippet(content: string, maxLength = 240): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

function parseJSONResponse(content: string): Record<string, unknown> {
  const cleaned = stripMarkdownCodeBlocks(content);

  try {
    const parsed: unknown = JSON.parse(cleaned);

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new LLMError(
        `Expected JSON object, got ${
          parsed === null
            ? "null"
            : Array.isArray(parsed)
              ? "array"
              : typeof parsed
        }`,
        undefined,
        undefined,
        undefined,
        false,
      );
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LLMError) {
      throw error;
    }

    const isSyntaxError = error instanceof SyntaxError;
    throw new LLMError(
      `Failed to parse JSON response: ${
        error instanceof Error ? error.message : String(error)
      }. Response snippet: ${createContentSnippet(cleaned)}`,
      error,
      undefined,
      undefined,
      isSyntaxError,
    );
  }
}

export type ExtractionSchemaField = {
  type?: string;
  description?: string | undefined;
};

export type ExtractionSchema = Record<string, ExtractionSchemaField>;

/**
 * Convert an osmia extraction schema into a JSON Schema object suitable for
 * Ollama's structured outputs (`format` field). Every field is marked
 * required and `additionalProperties` is forbidden so the model is fully
 * constrained to the configured shape.
 */
export function buildJsonSchema(
  extractionSchema: ExtractionSchema,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(extractionSchema)) {
    required.push(key);
    const fieldType = field?.type;
    const property: Record<string, unknown> = {};

    switch (fieldType) {
      case "string":
      case "number":
      case "integer":
      case "boolean":
      case "null":
        property.type = fieldType;
        break;
      case "array":
        property.type = "array";
        break;
      case "object":
        property.type = "object";
        break;
      case "unknown":
      case "any":
      case undefined:
        // No constraint — accept any JSON value.
        break;
      default:
        // Unknown osmia type: leave unconstrained rather than fail.
        break;
    }

    if (field?.description) {
      property.description = field.description;
    }

    properties[key] = property;
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export class LLMClient {
  private readonly config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  async extract(
    systemPrompt: string,
    userPrompt: string,
    schemaJson?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const maxRetries = this.config.maxRetries ?? 3;

    for (
      let attemptNumber = 1;
      attemptNumber <= maxRetries + 1;
      attemptNumber += 1
    ) {
      try {
        return await this.performExtract(systemPrompt, userPrompt, schemaJson);
      } catch (error) {
        const llmError =
          error instanceof LLMError
            ? error
            : new LLMError(String(error), error);
        const retriesLeft = maxRetries - (attemptNumber - 1);

        if (!isRetryableLLMError(llmError) || retriesLeft <= 0) {
          throw llmError;
        }

        const delayMs = getRetryDelay(llmError, attemptNumber);
        console.error(
          `LLM extract attempt ${attemptNumber} failed: ${llmError.message}. ${retriesLeft} retries left. Waiting ${delayMs}ms before retrying.`,
        );
        await sleep(delayMs);
      }
    }

    throw new LLMError(
      "LLM extraction failed after exhausting retries",
      undefined,
      undefined,
      undefined,
      false,
    );
  }

  private async performExtract(
    systemPrompt: string,
    userPrompt: string,
    schemaJson?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const useStructuredOutput =
      this.config.structuredOutput !== false && schemaJson !== undefined;
    const payload: LLMRequestPayload = {
      model: this.config.model,
      format: useStructuredOutput ? schemaJson! : "json",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
    };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
    };

    let response: Response;
    try {
      response = await fetch(this.config.apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.timeout ?? 60000),
      });
    } catch (error) {
      throw new LLMError(
        `Network error during LLM API call: ${error instanceof Error ? error.message : String(error)}`,
        error,
        undefined,
        undefined,
        true,
      );
    }

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new LLMError(
        `LLM API returned status ${response.status}: ${response.statusText}${responseBody ? ` - ${responseBody.slice(0, 200)}` : ""}`,
        undefined,
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
        isRetryableStatus(response.status),
      );
    }

    let data: LLMResponse;
    try {
      data = (await response.json()) as LLMResponse;
    } catch (error) {
      throw new LLMError(
        `Failed to parse LLM API response: ${error instanceof Error ? error.message : String(error)}`,
        error,
        undefined,
        undefined,
        false,
      );
    }

    const content = data.message?.content;
    if (content === undefined || content === null) {
      throw new LLMError(
        "LLM API response missing message.content field",
        undefined,
        undefined,
        undefined,
        false,
      );
    }

    return parseJSONResponse(content);
  }
}

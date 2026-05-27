import { setTimeout as sleep } from "node:timers/promises";
import type { SearchProvider } from "./config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  provider?: SearchProvider;
  maxResults?: number;
  region?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxSnippetChars?: number;
}

export class SearchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly statusCode?: number,
    public readonly retryAfterMs?: number,
    public readonly retryable = true
  ) {
    super(message);
    this.name = "SearchError";
  }
}

/** Max characters per search result snippet injected into the LLM prompt. */
export const DEFAULT_MAX_SNIPPET_CHARS = 4000;

const DEFAULT_OPTIONS: Required<Omit<SearchOptions, "provider">> & { provider: SearchProvider } = {
  provider: "exa",
  maxResults: 5,
  region: "de-de",
  timeoutMs: 10000,
  maxRetries: 3,
  maxSnippetChars: DEFAULT_MAX_SNIPPET_CHARS,
};

export function limitSnippet(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}…`;
}

function normalizeSearchResults(
  results: SearchResult[],
  maxSnippetChars: number
): SearchResult[] {
  return results.map((result) => ({
    ...result,
    snippet: limitSnippet(result.snippet, maxSnippetChars),
  }));
}

function inferSearchStatusCode(message: string): number | undefined {
  const statusMatch = message.match(/\b(4\d{2}|5\d{2})\b/);
  if (!statusMatch) {
    return undefined;
  }

  return Number(statusMatch[1]);
}

function isSearchRateLimitMessage(message: string): boolean {
  return /(429|rate.?limit|too many requests|throttl)/i.test(message);
}

function isRetryableSearchStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function getSearchRetryDelay(error: SearchError, attemptNumber: number): number {
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }

  return Math.min(30_000, 1000 * (2 ** (attemptNumber - 1)));
}

function createTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new SearchError(`Search timed out after ${ms}ms`, undefined, undefined, undefined, true));
    }, ms);
  });
}

export function formatQuery(
  template: string,
  record: Record<string, unknown>
): string {
  if (!template.trim()) {
    throw new SearchError("Template cannot be empty");
  }

  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (!(key in record)) {
      return match;
    }

    const value = record[key];
    if (value === null || value === undefined) {
      return "";
    }

    return String(value);
  });
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No web results found.";
  }

  return results
    .map(
      (result, index) =>
        `[${index + 1}] ${result.title}\n${result.url}\n${result.snippet}`
    )
    .join("\n\n");
}

interface SearchProviderOptions extends Required<Omit<SearchOptions, "provider">> {}

interface SearchProviderImpl {
  search(query: string, options: SearchProviderOptions): Promise<SearchResult[]>;
}

function getExaApiKey(): string {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    throw new SearchError(
      "EXA_API_KEY environment variable is required for Exa provider. Get your API key at https://exa.ai",
      undefined,
      undefined,
      undefined,
      false
    );
  }
  return apiKey;
}

function getGoogleApiKey(): string {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new SearchError(
      "GOOGLE_API_KEY environment variable is required for Google provider. Get your API key at https://developers.google.com/custom-search/v1/introduction",
      undefined,
      undefined,
      undefined,
      false
    );
  }
  return apiKey;
}

function getGoogleSearchEngineId(): string {
  const cx = process.env.GOOGLE_SEARCH_ENGINE_ID;
  if (!cx) {
    throw new SearchError(
      "GOOGLE_SEARCH_ENGINE_ID environment variable is required for Google provider. Create a Custom Search Engine at https://cse.google.com",
      undefined,
      undefined,
      undefined,
      false
    );
  }
  return cx;
}

function getOllamaApiKey(): string {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    throw new SearchError(
      "OLLAMA_API_KEY environment variable is required for Ollama provider. Get your API key at https://ollama.com/settings/keys",
      undefined,
      undefined,
      undefined,
      false
    );
  }
  return apiKey;
}

const exaProvider: SearchProviderImpl = {
  async search(query: string, options: Required<Omit<SearchOptions, "provider">>): Promise<SearchResult[]> {
    const apiKey = getExaApiKey();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Exa = require("exa-js").default;
    const exa = new Exa(apiKey);

    const searchPromise = exa.searchAndContents(query, {
      numResults: options.maxResults,
      text: { maxCharacters: options.maxSnippetChars },
      useAutoprompt: true,
    });

    interface ExaResult {
      title: string | null;
      url: string;
      text?: string;
    }

    interface ExaSearchResponse {
      results: ExaResult[];
    }

    const results = (await Promise.race([
      searchPromise,
      createTimeout(options.timeoutMs),
    ])) as ExaSearchResponse;

    return results.results.map((result: ExaResult) => ({
      title: result.title ?? "Untitled",
      url: result.url,
      snippet: result.text ?? "",
    }));
  },
};

const duckduckgoProvider: SearchProviderImpl = {
  async search(query: string, options: Required<Omit<SearchOptions, "provider">>): Promise<SearchResult[]> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DDGS } = require("@phukon/duckduckgo-search");

    const ddgs = new DDGS({ timeout: options.timeoutMs });

    interface DuckDuckGoResult {
      title?: string;
      href?: string;
      body?: string;
    }

    const results = await ddgs.text({
      keywords: query,
      maxResults: options.maxResults,
      region: options.region,
    });

    return (results as DuckDuckGoResult[]).map((result) => ({
      title: result.title ?? "Untitled",
      url: result.href ?? "",
      snippet: result.body ?? "",
    }));
  },
};

const googleProvider: SearchProviderImpl = {
  async search(query: string, options: Required<Omit<SearchOptions, "provider">>): Promise<SearchResult[]> {
    const apiKey = getGoogleApiKey();
    const cx = getGoogleSearchEngineId();

    const params = new URLSearchParams({
      key: apiKey,
      cx: cx,
      q: query,
      num: String(options.maxResults),
    });

    const searchPromise = fetch(`https://www.googleapis.com/customsearch/v1?${params}`);

    interface GoogleResult {
      title?: string;
      link?: string;
      snippet?: string;
    }

    interface GoogleSearchResponse {
      items?: GoogleResult[];
      error?: { code: number; message: string };
    }

    const response = await Promise.race([
      searchPromise,
      createTimeout(options.timeoutMs),
    ]);

    if (!response.ok) {
      const text = await response.text();
      throw new SearchError(
        `Google Search API error: ${response.status} ${text}`,
        undefined,
        response.status,
        undefined,
        isRetryableSearchStatus(response.status)
      );
    }

    const data = (await response.json()) as GoogleSearchResponse;

    if (data.error) {
      throw new SearchError(
        `Google Search API error: ${data.error.message}`,
        data.error,
        data.error.code,
        undefined,
        false
      );
    }

    return (data.items ?? []).map((item) => ({
      title: item.title ?? "Untitled",
      url: item.link ?? "",
      snippet: item.snippet ?? "",
    }));
  },
};

const ollamaProvider: SearchProviderImpl = {
  async search(query: string, options: Required<Omit<SearchOptions, "provider">>): Promise<SearchResult[]> {
    const apiKey = getOllamaApiKey();

    const searchPromise = fetch("https://ollama.com/api/web_search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        max_results: options.maxResults,
      }),
    });

    interface OllamaResult {
      title: string;
      url: string;
      content: string;
    }

    interface OllamaSearchResponse {
      results: OllamaResult[];
    }

    const response = await Promise.race([
      searchPromise,
      createTimeout(options.timeoutMs),
    ]);

    if (!response.ok) {
      const text = await response.text();
      throw new SearchError(
        `Ollama Web Search API error: ${response.status} ${text}`,
        undefined,
        response.status,
        undefined,
        isRetryableSearchStatus(response.status)
      );
    }

    const data = (await response.json()) as OllamaSearchResponse;

    return data.results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.content,
    }));
  },
};

const providers: Record<SearchProvider, SearchProviderImpl> = {
  exa: exaProvider,
  duckduckgo: duckduckgoProvider,
  google: googleProvider,
  ollama: ollamaProvider,
};

function getProvider(provider: SearchProvider): SearchProviderImpl {
  const impl = providers[provider];
  if (!impl) {
    throw new SearchError(
      `Unknown search provider: ${provider}. Supported providers: exa, duckduckgo, google, ollama`,
      undefined,
      undefined,
      undefined,
      false
    );
  }
  return impl;
}

export async function searchWeb(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { provider, maxResults, region, timeoutMs, maxRetries, maxSnippetChars } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  if (!query.trim()) {
    throw new SearchError("Search query cannot be empty");
  }

  const providerImpl = getProvider(provider);

  for (let attemptNumber = 1; attemptNumber <= maxRetries + 1; attemptNumber += 1) {
    try {
      return normalizeSearchResults(
        await providerImpl.search(query, {
          maxResults,
          region,
          timeoutMs,
          maxRetries,
          maxSnippetChars,
        }),
        maxSnippetChars
      );
    } catch (error) {
      const searchError =
        error instanceof SearchError
          ? error
          : (() => {
              const message = error instanceof Error ? error.message : String(error);
              const statusCode = inferSearchStatusCode(message);
              const retryable = statusCode !== undefined
                ? isRetryableSearchStatus(statusCode)
                : isSearchRateLimitMessage(message);

              return new SearchError(
                `Search failed: ${message}`,
                error,
                statusCode,
                isSearchRateLimitMessage(message) ? Math.min(30_000, 1000 * (2 ** attemptNumber)) : undefined,
                retryable
              );
            })();
      const retriesLeft = maxRetries - (attemptNumber - 1);

      if (!searchError.retryable || retriesLeft <= 0) {
        throw searchError;
      }

      const delayMs = getSearchRetryDelay(searchError, attemptNumber);
      await sleep(delayMs);
    }
  }

  throw new SearchError("Search failed after exhausting retries", undefined, undefined, undefined, false);
}

export async function searchWithTemplate(
  template: string,
  record: Record<string, unknown>,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const query = formatQuery(template, record);
  return searchWeb(query, options);
}
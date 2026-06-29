import { setTimeout as sleep } from "node:timers/promises";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { limitSnippet } from "./search.js";

export interface PageContent {
  url: string;
  title: string;
  text: string;
}

export interface FetcherOptions {
  maxChars: number;
  timeoutMs: number;
  maxRetries: number;
}

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly statusCode?: number,
    public readonly retryAfterMs?: number,
    public readonly retryable = true,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/** Max delay between fetch retries, in milliseconds. */
const MAX_RETRY_DELAY_MS = 30_000;

/** Selectors stripped before readability to keep noise out of the extracted text. */
const NOISE_SELECTORS = ["script", "style", "nav", "footer", "header", "noscript"];

function isRetryableFetchStatus(statusCode: number): boolean {
  return (
    statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500
  );
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1000));
  }

  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.min(MAX_RETRY_DELAY_MS, dateMs - Date.now()));
  }

  return undefined;
}

function getFetchRetryDelay(
  error: FetchError,
  attemptNumber: number,
): number {
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }

  return Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** (attemptNumber - 1));
}

function isHtmlContentType(contentType: string): boolean {
  if (contentType.trim() === "") {
    return true;
  }

  const ct = contentType.toLowerCase();
  return ct.includes("text/html") || ct.includes("application/xhtml+xml");
}

function toFetchError(error: unknown, url: string): FetchError {
  if (error instanceof FetchError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const isTimeoutOrAbort = /timed?\s*out|abort/i.test(message);
  const statusCode = inferFetchStatusCode(message);
  // Network-level failures (no HTTP status) are treated as retryable; only
  // recognised non-retryable HTTP statuses (4xx outside 408/425/429) short-circuit.
  const retryable =
    isTimeoutOrAbort ||
    (statusCode === undefined ? true : isRetryableFetchStatus(statusCode));

  return new FetchError(
    `Fetch failed for ${url}: ${message}`,
    error,
    statusCode,
    undefined,
    retryable,
  );
}

function inferFetchStatusCode(message: string): number | undefined {
  const match = message.match(/\b(4\d{2}|5\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function parseHtmlToContent(
  url: string,
  html: string,
  maxChars: number,
): PageContent {
  try {
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;

    for (const selector of NOISE_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        element.remove();
      }
    }

    const article = new Readability(document).parse();

    if (article && (article.textContent?.trim() || article.title?.trim())) {
      return {
        url,
        title: article.title ?? "",
        text: limitSnippet(article.textContent ?? "", maxChars),
      };
    }

    const fallbackText = (document.body?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();

    return {
      url,
      title: document.title ?? "",
      text: limitSnippet(fallbackText, maxChars),
    };
  } catch {
    return { url, title: "", text: "" };
  }
}

export async function fetchPageContent(
  url: string,
  options: FetcherOptions,
): Promise<PageContent> {
  if (!/^https?:\/\//i.test(url)) {
    return { url, title: "", text: "" };
  }

  const { maxChars, timeoutMs, maxRetries } = options;

  for (
    let attemptNumber = 1;
    attemptNumber <= maxRetries + 1;
    attemptNumber += 1
  ) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "osmia-ai/0.3 (+https://github.com/zappzerapp/osmia-ai)",
        },
      });

      if (!response.ok) {
        throw new FetchError(
          `Fetch failed with status ${response.status} for ${url}`,
          undefined,
          response.status,
          parseRetryAfter(response.headers.get("retry-after")),
          isRetryableFetchStatus(response.status),
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!isHtmlContentType(contentType)) {
        return { url, title: "", text: "" };
      }

      const html = await response.text();
      return parseHtmlToContent(url, html, maxChars);
    } catch (error) {
      const fetchError = toFetchError(error, url);
      const retriesLeft = maxRetries - (attemptNumber - 1);

      if (!fetchError.retryable) {
        // Non-retryable HTTP errors (e.g. 404) yield empty content instead of
        // surfacing as a thrown error — page content is best-effort.
        return { url, title: "", text: "" };
      }

      if (retriesLeft <= 0) {
        throw fetchError;
      }

      const delayMs = getFetchRetryDelay(fetchError, attemptNumber);
      await sleep(delayMs);
    }
  }

  throw new FetchError(
    `Fetch failed for ${url} after exhausting retries`,
    undefined,
    undefined,
    undefined,
    false,
  );
}
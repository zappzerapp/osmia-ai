import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FetchError,
  fetchPageContent,
  type PageContent,
} from "../src/fetcher.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const ARTICLE_HTML = `<!DOCTYPE html>
<html>
  <head>
    <title>Studio Headphones Review</title>
  </head>
  <body>
    <nav>Home Products About</nav>
    <header>Header banner</header>
    <script>var noise = "should never appear";</script>
    <style>body { color: red; }</style>
    <article>
      <h1>Studio Headphones Review</h1>
      <p>These over-ear studio headphones deliver detailed sound with strong noise isolation.
      The padded headband and ear cups make long mixing sessions comfortable, and the coiled
      cable stays out of the way on a desk. Frequency response is tuned for flat monitoring
      rather than consumer bass boost, which suits production work.</p>
      <p>Battery life is not a concern because these are wired monitors. The impedance of 80 ohms
      means they pair well with portable interfaces as well as dedicated headphone amps. The
      closed-back design keeps bleed out of microphone placements during tracking.</p>
    </article>
    <footer>Copyright footer noise</footer>
  </body>
</html>`;

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

describe("fetchPageContent", () => {
  it("extracts the article title and readable text via Readability", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse(ARTICLE_HTML));

    global.fetch = fetchMock;

    const page = await fetchPageContent("https://example.com/review", {
      maxChars: 8000,
      timeoutMs: 1000,
      maxRetries: 0,
    });

    expect(page.url).toBe("https://example.com/review");
    expect(page.title).toBe("Studio Headphones Review");
    expect(page.text).toContain("over-ear studio headphones");
    // Noise selectors are stripped before readability runs.
    expect(page.text).not.toContain("should never appear");
    expect(page.text).not.toContain("Copyright footer noise");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("truncates extracted text to maxChars", async () => {
    global.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse(ARTICLE_HTML));

    const page = await fetchPageContent("https://example.com/review", {
      maxChars: 50,
      timeoutMs: 1000,
      maxRetries: 0,
    });

    expect(page.text.length).toBeLessThanOrEqual(51);
    expect(page.text.endsWith("…")).toBe(true);
  });

  it("skips non-HTML content types and returns empty text", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("%PDF-1.4 binary bytes", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );

    global.fetch = fetchMock;

    const page = await fetchPageContent("https://example.com/doc.pdf", {
      maxChars: 8000,
      timeoutMs: 1000,
      maxRetries: 0,
    });

    expect(page).toEqual<PageContent>({
      url: "https://example.com/doc.pdf",
      title: "",
      text: "",
    });
  });

  it("skips non-http(s) URLs without calling fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    global.fetch = fetchMock;

    const page = await fetchPageContent("javascript:alert(1)", {
      maxChars: 8000,
      timeoutMs: 1000,
      maxRetries: 0,
    });

    expect(page).toEqual<PageContent>({
      url: "javascript:alert(1)",
      title: "",
      text: "",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a retryable FetchError when the network keeps failing", async () => {
    global.fetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("fetch failed: connect ECONNREFUSED"));

    await expect(
      fetchPageContent("https://example.com/down", {
        maxChars: 8000,
        timeoutMs: 1000,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({
      name: "FetchError",
      retryable: true,
    });
  });

  it("returns empty content for non-retryable HTTP statuses instead of throwing", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("Not Found", {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
      }),
    );

    global.fetch = fetchMock;

    const page = await fetchPageContent("https://example.com/missing", {
      maxChars: 8000,
      timeoutMs: 1000,
      maxRetries: 2,
    });

    expect(page).toEqual<PageContent>({
      url: "https://example.com/missing",
      title: "",
      text: "",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 response and succeeds on the second attempt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "0", "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(htmlResponse(ARTICLE_HTML));

    global.fetch = fetchMock;

    const page = await fetchPageContent("https://example.com/review", {
      maxChars: 8000,
      timeoutMs: 1000,
      maxRetries: 2,
    });

    expect(page.title).toBe("Studio Headphones Review");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries on persistent 429 and throws a FetchError with statusCode 429", async () => {
    global.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "0", "content-type": "text/html" },
      }),
    );

    await expect(
      fetchPageContent("https://example.com/throttled", {
        maxChars: 8000,
        timeoutMs: 1000,
        maxRetries: 1,
      }),
    ).rejects.toMatchObject({
      name: "FetchError",
      statusCode: 429,
      retryable: true,
    });
  });

  it("falls back to stripped textContent when readability cannot parse an article", async () => {
    const bareHtml =
      '<!DOCTYPE html><html><head><title>Bare</title></head>' +
      "<body><div>Just some plain text without article structure.</div></body></html>";

    global.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse(bareHtml));

    const page = await fetchPageContent("https://example.com/bare", {
      maxChars: 8000,
      timeoutMs: 1000,
      maxRetries: 0,
    });

    expect(page.title).toBe("Bare");
    expect(page.text).toContain("Just some plain text");
  });

  it("exposes FetchError as a typed error with the search-style shape", () => {
    const error = new FetchError("boom", undefined, 500, undefined, true);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("FetchError");
    expect(error.message).toBe("boom");
    expect(error.statusCode).toBe(500);
    expect(error.retryable).toBe(true);
  });
});
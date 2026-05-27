import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMClient, LLMError } from "../src/llm.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("LLMClient", () => {
  it("retries retryable 429 responses and then succeeds", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("Too Many Requests", {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "retry-after": "0",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({ beschreibung: "Kurzbeschreibung" }),
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      );

    global.fetch = fetchMock;

    const client = new LLMClient({
      model: "kimi-k2.5",
      apiUrl: "https://example.com/api/chat",
      apiKey: "secret",
      maxRetries: 2,
      timeout: 1000,
    });

    await expect(
      client.extract("Extract fields", "Input record"),
    ).resolves.toEqual({ beschreibung: "Kurzbeschreibung" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("retries malformed JSON content and then succeeds", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: {
              content: '{"beschreibung":"Kurzbeschreibung"',
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({ beschreibung: "Kurzbeschreibung" }),
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      );

    global.fetch = fetchMock;

    const client = new LLMClient({
      model: "kimi-k2.5",
      apiUrl: "https://example.com/api/chat",
      apiKey: "secret",
      maxRetries: 2,
      timeout: 1000,
    });

    await expect(
      client.extract("Extract fields", "Input record"),
    ).resolves.toEqual({ beschreibung: "Kurzbeschreibung" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-retryable semantic parsing failures", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify(["not-an-object"]),
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    global.fetch = fetchMock;

    const client = new LLMClient({
      model: "kimi-k2.5",
      apiUrl: "https://example.com/api/chat",
      apiKey: "secret",
      maxRetries: 3,
      timeout: 1000,
    });

    await expect(
      client.extract("Extract fields", "Input record"),
    ).rejects.toBeInstanceOf(LLMError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

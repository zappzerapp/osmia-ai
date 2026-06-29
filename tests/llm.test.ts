import { afterEach, describe, expect, it, vi } from "vitest";
import { buildJsonSchema, LLMClient, LLMError } from "../src/llm.js";

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

  it("sends the JSON Schema as format when structuredOutput is enabled", async () => {
    let capturedBody: { format: unknown } | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body)) as { format: unknown };
        return new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({ beschreibung: "Kurzbeschreibung" }),
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    global.fetch = fetchMock;

    const client = new LLMClient({
      model: "kimi-k2.5",
      apiUrl: "https://example.com/api/chat",
      apiKey: "secret",
      structuredOutput: true,
      maxRetries: 1,
      timeout: 1000,
    });

    const schemaJson = buildJsonSchema({
      beschreibung: { type: "string", description: "Short summary" },
    });

    await client.extract("Extract fields", "Input record", schemaJson);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedBody).toBeDefined();
    expect(capturedBody?.format).toEqual(schemaJson);
    expect(capturedBody?.format).not.toBe("json");
  });

  it("falls back to format 'json' when structuredOutput is disabled", async () => {
    let capturedBody: { format: unknown } | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body)) as { format: unknown };
        return new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({ beschreibung: "Kurzbeschreibung" }),
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    global.fetch = fetchMock;

    const client = new LLMClient({
      model: "kimi-k2.5",
      apiUrl: "https://example.com/api/chat",
      apiKey: "secret",
      structuredOutput: false,
      maxRetries: 1,
      timeout: 1000,
    });

    const schemaJson = buildJsonSchema({
      beschreibung: { type: "string" },
    });

    await client.extract("Extract fields", "Input record", schemaJson);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedBody?.format).toBe("json");
  });
});

describe("buildJsonSchema", () => {
  it("maps osmia field types to JSON Schema types and marks all fields required", () => {
    const schema = buildJsonSchema({
      name: { type: "string", description: "Product name" },
      count: { type: "integer" },
      price: { type: "number" },
      inStock: { type: "boolean" },
      tags: { type: "array" },
      meta: { type: "object" },
      nothing: { type: "null" },
      anything: { type: "unknown" },
      whatever: { type: "any" },
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        name: { type: "string", description: "Product name" },
        count: { type: "integer" },
        price: { type: "number" },
        inStock: { type: "boolean" },
        tags: { type: "array" },
        meta: { type: "object" },
        nothing: { type: "null" },
        anything: {},
        whatever: {},
      },
      required: [
        "name",
        "count",
        "price",
        "inStock",
        "tags",
        "meta",
        "nothing",
        "anything",
        "whatever",
      ],
      additionalProperties: false,
    });
  });

  it("omits description when not provided and leaves unconstrained fields empty", () => {
    const schema = buildJsonSchema({
      plain: { type: "string" },
      free: { type: "unknown" },
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        plain: { type: "string" },
        free: {},
      },
      required: ["plain", "free"],
      additionalProperties: false,
    });
  });
});

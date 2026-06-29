import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, serializeConfig, validateConfig } from "../src/config.js";
import { createDefaultConfig } from "../src/wizard.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      // Best-effort cleanup for isolated test fixtures.
      import("node:fs").then(({ rmSync }) =>
        rmSync(tempDir, { recursive: true, force: true }),
      );
    }
  }
});

describe("config", () => {
  it("accepts camelCase config values", () => {
    const config = validateConfig({
      llm: {
        model: "kimi-k2.5",
        apiUrl: "https://ollama.com/api/chat",
      },
      research: {
        searchQuery: "{titel} info",
      },
      extraction: {
        prompt: "Extract fields",
        schema: {
          alter: {
            type: "string",
            description: "Recommended age",
          },
        },
      },
    });

    expect(config.llm.apiKeyEnv).toBe("OLLAMA_API_KEY");
    expect(config.llm.requestsPerMinute).toBe(30);
    expect(config.llm.maxConcurrency).toBe(1);
    expect(config.research.maxResults).toBe(5);
    expect(config.research.timeoutMs).toBe(10000);
    expect(config.research.maxRetries).toBe(3);
    expect(config.research.requestsPerMinute).toBe(30);
    expect(config.research.maxConcurrency).toBe(1);
    expect(config.extraction.schema.alter.type).toBe("string");
  });

  it("normalizes legacy snake_case keys and shorthand schema values", () => {
    const config = validateConfig({
      llm: {
        model: "kimi-k2.5",
        api_url: "https://ollama.com/api/chat",
        api_key_env: "CUSTOM_API_KEY",
        max_retries: 4,
        requests_per_minute: 12,
        max_concurrency: 2,
      },
      research: {
        search_query: "{titel} info",
        max_results: 8,
        region: "en-us",
        timeout_ms: 15000,
        max_retries: 5,
        requests_per_minute: 9,
        max_concurrency: 3,
      },
      extraction: {
        prompt: "Extract fields",
        schema: {
          alter: "string",
        },
      },
    });

    expect(config.llm.apiUrl).toBe("https://ollama.com/api/chat");
    expect(config.llm.apiKeyEnv).toBe("CUSTOM_API_KEY");
    expect(config.llm.maxRetries).toBe(4);
    expect(config.llm.requestsPerMinute).toBe(12);
    expect(config.llm.maxConcurrency).toBe(2);
    expect(config.research.searchQuery).toBe("{titel} info");
    expect(config.research.maxResults).toBe(8);
    expect(config.research.timeoutMs).toBe(15000);
    expect(config.research.maxRetries).toBe(5);
    expect(config.research.requestsPerMinute).toBe(9);
    expect(config.research.maxConcurrency).toBe(3);
    expect(config.extraction.schema.alter).toEqual({ type: "string" });
  });

  it("applies defaults for the page-fetch research fields when omitted", () => {
    const config = validateConfig({
      llm: {
        model: "kimi-k2.5",
        apiUrl: "https://ollama.com/api/chat",
      },
      research: {
        searchQuery: "{titel} info",
      },
      extraction: {
        prompt: "Extract fields",
        schema: {
          alter: "string",
        },
      },
    });

    expect(config.research.fetchPageContent).toBe(false);
    expect(config.research.maxPageChars).toBe(8000);
    expect(config.research.pageFetchTimeoutMs).toBe(15000);
    expect(config.research.pageFetchMaxRetries).toBe(2);
    expect(config.research.pageFetchRequestsPerMinute).toBe(20);
    expect(config.research.pageFetchMaxConcurrency).toBe(2);
  });

  it("accepts snake_case page-fetch keys and overrides camelCase defaults", () => {
    const config = validateConfig({
      llm: {
        model: "kimi-k2.5",
        apiUrl: "https://ollama.com/api/chat",
      },
      research: {
        search_query: "{titel} info",
        fetch_page_content: true,
        max_page_chars: 12000,
        page_fetch_timeout_ms: 20000,
        page_fetch_max_retries: 4,
        page_fetch_requests_per_minute: 15,
        page_fetch_max_concurrency: 3,
      },
      extraction: {
        prompt: "Extract fields",
        schema: {
          alter: "string",
        },
      },
    });

    expect(config.research.fetchPageContent).toBe(true);
    expect(config.research.maxPageChars).toBe(12000);
    expect(config.research.pageFetchTimeoutMs).toBe(20000);
    expect(config.research.pageFetchMaxRetries).toBe(4);
    expect(config.research.pageFetchRequestsPerMinute).toBe(15);
    expect(config.research.pageFetchMaxConcurrency).toBe(3);
  });

  it("rejects invalid page-fetch research field types", () => {
    expect(() =>
      validateConfig({
        llm: {
          model: "kimi-k2.5",
          apiUrl: "https://ollama.com/api/chat",
        },
        research: {
          searchQuery: "{titel} info",
          maxPageChars: 0,
        },
        extraction: {
          prompt: "Extract fields",
          schema: {
            alter: "string",
          },
        },
      }),
    ).toThrow();

    expect(() =>
      validateConfig({
        llm: {
          model: "kimi-k2.5",
          apiUrl: "https://ollama.com/api/chat",
        },
        research: {
          searchQuery: "{titel} info",
          fetchPageContent: "yes",
        },
        extraction: {
          prompt: "Extract fields",
          schema: {
            alter: "string",
          },
        },
      }),
    ).toThrow();
  });

  it("loads YAML config files from disk", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "osmia-config-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "config.yaml");

    writeFileSync(
      configPath,
      `
llm:
  model: kimi-k2.5
  apiUrl: https://ollama.com/api/chat

research:
  searchQuery: "{titel} details"

extraction:
  prompt: Extract fields
  schema:
    beschreibung:
      type: string
`,
      "utf-8",
    );

    const config = loadConfig(configPath);
    expect(config.extraction.schema.beschreibung.type).toBe("string");
  });

  it("rejects unsupported extraction schema field types", () => {
    expect(() =>
      validateConfig({
        llm: {
          model: "kimi-k2.5",
          apiUrl: "https://ollama.com/api/chat",
        },
        research: {
          searchQuery: "{titel} info",
        },
        extraction: {
          prompt: "Extract fields",
          schema: {
            alter: "date",
          },
        },
      }),
    ).toThrow(
      /Schema field type must be one of|extraction\.schema\.alter\.type/,
    );
  });

  it("serializes valid config data back to YAML", () => {
    const originalConfig = validateConfig({
      llm: {
        model: "kimi-k2.5",
        apiUrl: "https://ollama.com/api/chat",
      },
      research: {
        searchQuery: "{titel} info",
      },
      extraction: {
        prompt: "Extract fields",
        schema: {
          alter: "string",
        },
      },
    });

    const yaml = serializeConfig(originalConfig);
    const tempDir = mkdtempSync(join(tmpdir(), "osmia-config-serialize-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "config.yaml");
    writeFileSync(configPath, yaml, "utf-8");

    expect(loadConfig(configPath)).toEqual(originalConfig);
  });

  it("keeps the checked-in config template aligned with the wizard defaults", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "osmia-config-template-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "config.yaml");

    writeFileSync(
      configPath,
      readFileSync(resolve(process.cwd(), "config.yaml.template"), "utf-8"),
      "utf-8",
    );

    expect(loadConfig(configPath)).toEqual(createDefaultConfig());
  });

  it("loads every checked-in example config", () => {
    const examplesDir = resolve(process.cwd(), "examples");
    const exampleConfigs = readdirSync(examplesDir)
      .filter((fileName) => fileName.endsWith(".yaml"))
      .sort();

    expect(exampleConfigs.length).toBeGreaterThan(0);

    for (const fileName of exampleConfigs) {
      expect(() => loadConfig(join(examplesDir, fileName))).not.toThrow();
    }
  });

  it("defaults llm.structuredOutput to true when omitted", () => {
    const config = validateConfig({
      llm: {
        model: "kimi-k2.5",
        apiUrl: "https://ollama.com/api/chat",
      },
      research: {
        searchQuery: "{titel} info",
      },
      extraction: {
        prompt: "Extract fields",
        schema: {
          alter: { type: "string" },
        },
      },
    });

    expect(config.llm.structuredOutput).toBe(true);
  });

  it("accepts the snake_case structured_output key and overrides the default", () => {
    const config = validateConfig({
      llm: {
        model: "kimi-k2.5",
        apiUrl: "https://ollama.com/api/chat",
        structured_output: false,
      },
      research: {
        searchQuery: "{titel} info",
      },
      extraction: {
        prompt: "Extract fields",
        schema: {
          alter: { type: "string" },
        },
      },
    });

    expect(config.llm.structuredOutput).toBe(false);
  });

  it("lets camelCase structuredOutput override the default", () => {
    const config = validateConfig({
      llm: {
        model: "kimi-k2.5",
        apiUrl: "https://ollama.com/api/chat",
        structuredOutput: false,
      },
      research: {
        searchQuery: "{titel} info",
      },
      extraction: {
        prompt: "Extract fields",
        schema: {
          alter: { type: "string" },
        },
      },
    });

    expect(config.llm.structuredOutput).toBe(false);
  });

  it("rejects a non-boolean llm.structuredOutput value", () => {
    expect(() =>
      validateConfig({
        llm: {
          model: "kimi-k2.5",
          apiUrl: "https://ollama.com/api/chat",
          structuredOutput: "yes",
        },
        research: {
          searchQuery: "{titel} info",
        },
        extraction: {
          prompt: "Extract fields",
          schema: {
            alter: { type: "string" },
          },
        },
      }),
    ).toThrow();
  });
  it("defaults extraction.includeSources to false and sourcesField to _sources when omitted", () => {
    const config = validateConfig({
      llm: {
        model: "kimi-k2.5",
        apiUrl: "https://ollama.com/api/chat",
      },
      research: {
        searchQuery: "{titel} info",
      },
      extraction: {
        prompt: "Extract fields",
        schema: {
          alter: { type: "string" },
        },
      },
    });

    expect(config.extraction.includeSources).toBe(false);
    expect(config.extraction.sourcesField).toBe("_sources");
  });

  it("accepts the snake_case include_sources and sources_field keys", () => {
    const config = validateConfig({
      llm: {
        model: "kimi-k2.5",
        apiUrl: "https://ollama.com/api/chat",
      },
      research: {
        searchQuery: "{titel} info",
      },
      extraction: {
        prompt: "Extract fields",
        schema: {
          alter: { type: "string" },
        },
        include_sources: true,
        sources_field: "refs",
      },
    });

    expect(config.extraction.includeSources).toBe(true);
    expect(config.extraction.sourcesField).toBe("refs");
  });

  it("rejects a non-boolean extraction.includeSources value", () => {
    expect(() =>
      validateConfig({
        llm: {
          model: "kimi-k2.5",
          apiUrl: "https://ollama.com/api/chat",
        },
        research: {
          searchQuery: "{titel} info",
        },
        extraction: {
          prompt: "Extract fields",
          schema: {
            alter: { type: "string" },
          },
          includeSources: "yes",
        },
      }),
    ).toThrow();
  });
});

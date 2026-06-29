import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

const mockState = vi.hoisted(() => ({
  answers: [] as string[],
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: vi.fn(async () => {
      const answer = mockState.answers.shift();
      if (answer === undefined) {
        throw new Error("No more wizard answers available for test.");
      }
      return answer;
    }),
    close: vi.fn(),
  }),
}));

const { runConfigWizard } = await import("../src/wizard.js");

const tempDirs: string[] = [];

afterEach(() => {
  mockState.answers = [];

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

function createTempDir(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "osmia-wizard-"));
  tempDirs.push(tempDir);
  return tempDir;
}

describe("runConfigWizard", () => {
  it("creates a config file from interactive answers", async () => {
    const tempDir = createTempDir();
    const configPath = join(tempDir, "generated.yaml");
    const stdout = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(chunk.toString());
    });

    mockState.answers.push(
      "",
      "openai/gpt-4.1-mini",
      "https://example.com/api/chat",
      "45000",
      "4",
      "20",
      "2",
      "OSMIA_TEST_KEY",
      "",
      "{title} company profile",
      "7",
      "en-us",
      "8000",
      "5",
      "12",
      "3",
      "n",
      "n",
      "Extract company details from the web.",
      "Return strict JSON only.",
      ".",
      "company_name",
      "string",
      "Official company name",
      "employee_count",
      "integer",
      "Approximate number of employees",
      "",
      "n",
    );

    const result = await runConfigWizard({
      outputPath: configPath,
      stdout,
      allowNonTTY: true,
    });

    expect(result.path).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);
    expect(loadConfig(configPath)).toEqual({
      llm: {
        model: "openai/gpt-4.1-mini",
        apiUrl: "https://example.com/api/chat",
        timeout: 45000,
        maxRetries: 4,
        requestsPerMinute: 20,
        maxConcurrency: 2,
        apiKeyEnv: "OSMIA_TEST_KEY",
        structuredOutput: true,
      },
      research: {
        searchQuery: "{title} company profile",
        maxResults: 7,
        provider: "exa",
        region: "en-us",
        timeoutMs: 8000,
        maxRetries: 5,
        requestsPerMinute: 12,
        maxConcurrency: 3,
        fetchPageContent: false,
        maxPageChars: 8000,
        pageFetchTimeoutMs: 15000,
        pageFetchMaxRetries: 2,
        pageFetchRequestsPerMinute: 20,
        pageFetchMaxConcurrency: 2,
      },
      extraction: {
        prompt:
          "Extract company details from the web.\nReturn strict JSON only.",
        schema: {
          company_name: {
            type: "string",
            description: "Official company name",
          },
          employee_count: {
            type: "integer",
            description: "Approximate number of employees",
          },
        },
        includeSources: false,
        sourcesField: "_sources",
      },
    });

    expect(readFileSync(configPath, "utf-8")).toContain("company_name:");
    expect(stdoutChunks.join("")).toContain("Config written to");
  });

  it("aborts instead of overwriting an existing config without confirmation", async () => {
    const tempDir = createTempDir();
    const configPath = join(tempDir, "config.yaml");
    const stdout = new PassThrough();

    writeFileSync(
      configPath,
      'llm:\n  model: kimi-k2.5\n  apiUrl: https://ollama.com/api/chat\nresearch:\n  searchQuery: "{name}"\nextraction:\n  prompt: test\n  schema:\n    summary: string\n',
    );

    mockState.answers.push("", "n");

    await expect(
      runConfigWizard({
        outputPath: configPath,
        stdout,
        allowNonTTY: true,
      }),
    ).rejects.toThrow("Wizard aborted because the target file already exists.");
  });

  it("rejects non-interactive wizard usage by default", async () => {
    await expect(
      runConfigWizard({
        outputPath: "config.yaml",
        stdout: new PassThrough(),
      }),
    ).rejects.toThrow("The config wizard requires an interactive terminal.");
  });

  it("accepts schema field names beyond identifier-style keys", async () => {
    const tempDir = createTempDir();
    const configPath = join(tempDir, "generated.yaml");

    mockState.answers.push(
      "",
      "kimi-k2.5",
      "https://ollama.com/api/chat",
      "60000",
      "3",
      "30",
      "1",
      "OLLAMA_API_KEY",
      "",
      "Product {name}",
      "5",
      "de-de",
      "10000",
      "3",
      "30",
      "1",
      "n",
      "y",
      "short-description",
      "string",
      "Short description",
      "",
      "n",
    );

    const result = await runConfigWizard({
      outputPath: configPath,
      stdout: new PassThrough(),
      allowNonTTY: true,
    });

    expect(result.config.extraction.schema["short-description"]).toEqual({
      type: "string",
      description: "Short description",
    });
  });
});

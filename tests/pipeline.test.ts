import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectJsonlFormat,
  loadInputData,
  runPipeline,
  saveOutputData,
  shouldSkipRecord,
} from "../src/pipeline.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

function createTempDir(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "osmia-pipeline-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function silenceStderr(): () => void {
  const originalWrite = process.stderr.write;
  process.stderr.write = ((..._args: Parameters<typeof process.stderr.write>) =>
    true) as typeof process.stderr.write;

  return () => {
    process.stderr.write = originalWrite;
  };
}

describe("pipeline helpers", () => {
  it("skips only when every requested field has a meaningful value", () => {
    expect(
      shouldSkipRecord(
        {
          alter: "3+",
          beschreibung: "Kurzbeschreibung",
        },
        ["alter", "beschreibung"],
      ),
    ).toBe(true);

    expect(
      shouldSkipRecord(
        {
          alter: [],
        },
        ["alter"],
      ),
    ).toBe(false);

    expect(
      shouldSkipRecord(
        {
          alter: {},
        },
        ["alter"],
      ),
    ).toBe(false);
  });

  it("loads JSON and JSONL input records", async () => {
    const tempDir = createTempDir();
    const jsonPath = join(tempDir, "input.json");
    const jsonlPath = join(tempDir, "input.jsonl");

    writeFileSync(
      jsonPath,
      JSON.stringify([{ id: "1" }, { id: "2" }]),
      "utf-8",
    );
    writeFileSync(jsonlPath, '{"id":"1"}\n{"id":"2"}\n', "utf-8");

    await expect(loadInputData(jsonPath)).resolves.toHaveLength(2);
    await expect(loadInputData(jsonlPath)).resolves.toHaveLength(2);
    await expect(
      loadInputData(undefined, Readable.from(['{"id":"1"}\n{"id":"2"}\n'])),
    ).resolves.toHaveLength(2);
  });

  it("writes JSON output to disk", async () => {
    const tempDir = createTempDir();
    const outputPath = join(tempDir, "output.json");

    await saveOutputData([{ id: "1", name: "Item 1" }], outputPath);

    const output = readFileSync(outputPath, "utf-8");
    expect(JSON.parse(output)).toEqual([{ id: "1", name: "Item 1" }]);
  });

  it("detects JSONL content", () => {
    expect(detectJsonlFormat('{"id":"1"}\n{"id":"2"}\n')).toBe(true);
    expect(detectJsonlFormat('[{"id":"1"}]')).toBe(false);
  });
});

describe("runPipeline", () => {
  it("preserves JSONL output in dry-run mode", async () => {
    const tempDir = createTempDir();
    const configPath = join(tempDir, "config.yaml");
    const chunks: string[] = [];

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

    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });

    await runPipeline({
      config: configPath,
      skipFields: [],
      workers: 1,
      dryRun: true,
      verbose: 0,
      stdin: Readable.from([
        '{"id":"1","titel":"Eins"}\n{"id":"2","titel":"Zwei"}\n',
      ]),
      stdout,
    });

    expect(chunks.join("")).toBe(
      '{"id":"1","titel":"Eins"}\n{"id":"2","titel":"Zwei"}\n',
    );
  });

  it("rejects extracted data that violates the configured schema without writing output", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");
      const chunks: string[] = [];

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

      const stdout = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      });

      await expect(
        runPipeline({
          config: configPath,
          skipFields: [],
          workers: 1,
          dryRun: false,
          verbose: 0,
          stdin: Readable.from(['{"id":"1","titel":"Eins"}\n']),
          stdout,
          searchFn: async () => [],
          llmClient: {
            extract: async () => ({ beschreibung: 123 }),
          },
        }),
      ).rejects.toThrow("1 record(s) failed to process");

      expect(chunks).toEqual([]);
    } finally {
      restoreStderr();
    }
  });

  it("passes the configured search provider to searchFn", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");
      let capturedProvider: string | undefined;

      writeFileSync(
        configPath,
        `
llm:
  model: kimi-k2.5
  apiUrl: https://ollama.com/api/chat

research:
  provider: duckduckgo
  searchQuery: "{titel} details"

extraction:
  prompt: Extract fields
  schema:
    beschreibung:
      type: string
`,
        "utf-8",
      );

      await runPipeline({
        config: configPath,
        skipFields: [],
        workers: 1,
        dryRun: false,
        verbose: 0,
        stdin: Readable.from(['{"id":"1","titel":"Eins"}\n']),
        stdout: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        searchFn: async (_query, options) => {
          capturedProvider = options.provider;
          return [];
        },
        llmClient: {
          extract: async () => ({ beschreibung: "Kurzbeschreibung" }),
        },
      });

      expect(capturedProvider).toBe("duckduckgo");
    } finally {
      restoreStderr();
    }
  });

  it("does not create the output file when any record fails", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");
      const outputPath = join(tempDir, "output.jsonl");
      let callCount = 0;

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

      await expect(
        runPipeline({
          config: configPath,
          outputPath,
          skipFields: [],
          workers: 1,
          dryRun: false,
          verbose: 0,
          stdin: Readable.from([
            '{"id":"1","titel":"Eins"}\n{"id":"2","titel":"Zwei"}\n',
          ]),
          searchFn: async () => [],
          llmClient: {
            extract: async () => {
              callCount += 1;
              return callCount === 1
                ? { beschreibung: "Kurzbeschreibung" }
                : { beschreibung: 123 };
            },
          },
        }),
      ).rejects.toThrow("1 record(s) failed to process");

      expect(existsSync(outputPath)).toBe(false);
    } finally {
      restoreStderr();
    }
  });
});

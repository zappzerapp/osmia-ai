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

function captureStdout(): { stdout: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stdout, chunks };
}

function writeBaseConfig(configPath: string): void {
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

  it("writes JSONL output to disk", async () => {
    const tempDir = createTempDir();
    const outputPath = join(tempDir, "output.jsonl");

    await saveOutputData(
      [
        { id: "1", name: "Item 1" },
        { id: "2", name: "Item 2" },
      ],
      outputPath,
      undefined,
      true,
    );

    const output = readFileSync(outputPath, "utf-8");
    expect(output).toBe(
      '{"id":"1","name":"Item 1"}\n{"id":"2","name":"Item 2"}\n',
    );
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

  it("streams JSONL records one write per record instead of buffering", async () => {
    const tempDir = createTempDir();
    const configPath = join(tempDir, "config.yaml");
    writeBaseConfig(configPath);
    const { stdout, chunks } = captureStdout();

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

    // One writeRecord call per record => one chunk per JSONL line.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('{"id":"1","titel":"Eins"}\n');
    expect(chunks[1]).toBe('{"id":"2","titel":"Zwei"}\n');
    for (const chunk of chunks) {
      const line = chunk.trim();
      const parsed = JSON.parse(line) as { id?: string };
      expect(typeof parsed).toBe("object");
      expect(parsed.id).toBeDefined();
    }
  });

  it("streams JSONL records to a file as they complete", async () => {
    const tempDir = createTempDir();
    const configPath = join(tempDir, "config.yaml");
    const outputPath = join(tempDir, "output.jsonl");
    writeBaseConfig(configPath);

    await runPipeline({
      config: configPath,
      outputPath,
      skipFields: [],
      workers: 1,
      dryRun: true,
      verbose: 0,
      stdin: Readable.from([
        '{"id":"1","titel":"Eins"}\n{"id":"2","titel":"Zwei"}\n',
      ]),
    });

    const output = readFileSync(outputPath, "utf-8");
    expect(output).toBe('{"id":"1","titel":"Eins"}\n{"id":"2","titel":"Zwei"}\n');
  });

  it("persists completed JSONL records on disk when a later record fails", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");
      const outputPath = join(tempDir, "output.jsonl");
      let callCount = 0;
      writeBaseConfig(configPath);

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

      // Record 1 was streamed before record 2 failed, so the file exists with
      // the completed record. Re-running with --resume can continue from here.
      expect(existsSync(outputPath)).toBe(true);
      const lines = readFileSync(outputPath, "utf-8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(1);
      const first = JSON.parse(lines[0]) as { id: string; beschreibung: string };
      expect(first.id).toBe("1");
      expect(first.beschreibung).toBe("Kurzbeschreibung");
    } finally {
      restoreStderr();
    }
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

  it("does not create the JSON-array output file when any record fails", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");
      const outputPath = join(tempDir, "output.json");
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

  it("fetches full page content behind fetchPageContent and feeds it to the LLM", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");

      writeFileSync(
        configPath,
        `
llm:
  model: kimi-k2.5
  apiUrl: https://ollama.com/api/chat

research:
  searchQuery: "{titel} details"
  fetchPageContent: true
  maxPageChars: 8000

extraction:
  prompt: Extract fields
  schema:
    beschreibung:
      type: string
`,
        "utf-8",
      );

      let capturedPrompt = "";
      const fetchedUrls: string[] = [];

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
        searchFn: async () => [
          {
            title: "Studio Headphones",
            url: "https://example.com/headphones",
            snippet: "thin snippet",
          },
        ],
        fetchFn: async (url) => {
          fetchedUrls.push(url);
          return {
            url,
            title: "Studio Headphones Review",
            text: "Full article body extracted from the page.",
          };
        },
        llmClient: {
          extract: async (_system, user) => {
            capturedPrompt = user;
            return { beschreibung: "Kurzbeschreibung" };
          },
        },
      });

      expect(fetchedUrls).toEqual(["https://example.com/headphones"]);
      expect(capturedPrompt).toContain("Full article body extracted from the page.");
      expect(capturedPrompt).not.toContain("thin snippet");
    } finally {
      restoreStderr();
    }
  });

  it("keeps the original snippet when a page fetch fails and never fails the record", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");

      writeFileSync(
        configPath,
        `
llm:
  model: kimi-k2.5
  apiUrl: https://ollama.com/api/chat

research:
  searchQuery: "{titel} details"
  fetchPageContent: true
  maxPageChars: 8000

extraction:
  prompt: Extract fields
  schema:
    beschreibung:
      type: string
`,
        "utf-8",
      );

      let capturedPrompt = "";

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
        searchFn: async () => [
          {
            title: "Studio Headphones",
            url: "https://example.com/headphones",
            snippet: "thin snippet",
          },
        ],
        fetchFn: async () => {
          throw new Error("network down");
        },
        llmClient: {
          extract: async (_system, user) => {
            capturedPrompt = user;
            return { beschreibung: "Kurzbeschreibung" };
          },
        },
      });

      expect(capturedPrompt).toContain("thin snippet");
    } finally {
      restoreStderr();
    }
  });

  it("attaches _sources to enriched records when extraction.includeSources is true", async () => {
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
  includeSources: true
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
          write(chunk, _encoding, callback) {
            chunks.push(chunk.toString());
            callback();
          },
        }),
        searchFn: async () => [
          {
            title: "Studio Headphones",
            url: "https://example.com/headphones",
            snippet: "thin snippet",
          },
          {
            title: "No URL result",
            url: "",
            snippet: "should be filtered out",
          },
        ],
        llmClient: {
          extract: async () => ({ beschreibung: "Kurzbeschreibung" }),
        },
      });

      const output = JSON.parse(chunks.join(""));
      expect(output).toEqual([
        {
          id: "1",
          titel: "Eins",
          beschreibung: "Kurzbeschreibung",
          _sources: [
            { url: "https://example.com/headphones", title: "Studio Headphones" },
          ],
        },
      ]);
    } finally {
      restoreStderr();
    }
  });

  it("does not attach _sources when extraction.includeSources is false", async () => {
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

      await runPipeline({
        config: configPath,
        skipFields: [],
        workers: 1,
        dryRun: false,
        verbose: 0,
        stdin: Readable.from(['{"id":"1","titel":"Eins"}\n']),
        stdout: new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(chunk.toString());
            callback();
          },
        }),
        searchFn: async () => [
          {
            title: "Studio Headphones",
            url: "https://example.com/headphones",
            snippet: "thin snippet",
          },
        ],
        llmClient: {
          extract: async () => ({ beschreibung: "Kurzbeschreibung" }),
        },
      });

      const output = JSON.parse(chunks.join(""));
      expect(output).toEqual([
        {
          id: "1",
          titel: "Eins",
          beschreibung: "Kurzbeschreibung",
        },
      ]);
      expect(output[0]._sources).toBeUndefined();
    } finally {
      restoreStderr();
    }
  });

  it("resumes by skipping records already present in the JSONL output", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");
      const outputPath = join(tempDir, "output.jsonl");
      writeBaseConfig(configPath);

      // Record id 1 is already complete in the output.
      writeFileSync(
        outputPath,
        '{"id":"1","titel":"Eins","beschreibung":"Kurzbeschreibung"}\n',
        "utf-8",
      );

      const searchCalls: string[] = [];
      const extractCalls: string[] = [];

      await runPipeline({
        config: configPath,
        outputPath,
        skipFields: [],
        workers: 1,
        dryRun: false,
        verbose: 0,
        resume: true,
        stdin: Readable.from([
          '{"id":"1","titel":"Eins"}\n{"id":"2","titel":"Zwei"}\n',
        ]),
        searchFn: async (query) => {
          searchCalls.push(query);
          return [];
        },
        llmClient: {
          extract: async (_system, _user) => {
            extractCalls.push(_user);
            return { beschreibung: "Kurzbeschreibung" };
          },
        },
      });

      // The already-present record was not re-processed.
      expect(searchCalls).toEqual(["Zwei details"]);
      expect(extractCalls).toHaveLength(1);

      // The output contains both the previously-written and the newly-appended
      // record.
      const lines = readFileSync(outputPath, "utf-8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]) as { id: string };
      const second = JSON.parse(lines[1]) as { id: string; beschreibung: string };
      expect(first.id).toBe("1");
      expect(second.id).toBe("2");
      expect(second.beschreibung).toBe("Kurzbeschreibung");
    } finally {
      restoreStderr();
    }
  });

  it("processes all records when --resume is set but the output file is missing", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");
      const outputPath = join(tempDir, "output.jsonl");
      writeBaseConfig(configPath);

      const extractCalls: string[] = [];

      await runPipeline({
        config: configPath,
        outputPath,
        skipFields: [],
        workers: 1,
        dryRun: false,
        verbose: 0,
        resume: true,
        stdin: Readable.from([
          '{"id":"1","titel":"Eins"}\n{"id":"2","titel":"Zwei"}\n',
        ]),
        searchFn: async () => [],
        llmClient: {
          extract: async (_system, user) => {
            extractCalls.push(user);
            return { beschreibung: "Kurzbeschreibung" };
          },
        },
      });

      expect(extractCalls).toHaveLength(2);
      const lines = readFileSync(outputPath, "utf-8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(2);
    } finally {
      restoreStderr();
    }
  });

  it("resumes by input index when the resume-key field is absent", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");
      const outputPath = join(tempDir, "output.jsonl");
      writeBaseConfig(configPath);

      // First record (no id) is already written at output index 0.
      writeFileSync(
        outputPath,
        '{"titel":"Alpha","beschreibung":"Kurzbeschreibung"}\n',
        "utf-8",
      );

      const searchCalls: string[] = [];

      await runPipeline({
        config: configPath,
        outputPath,
        skipFields: [],
        workers: 1,
        dryRun: false,
        verbose: 0,
        resume: true,
        stdin: Readable.from(['{"titel":"Alpha"}\n{"titel":"Beta"}\n']),
        searchFn: async (query) => {
          searchCalls.push(query);
          return [];
        },
        llmClient: {
          extract: async () => ({ beschreibung: "Kurzbeschreibung" }),
        },
      });

      // Only the second record (input index 1) is processed; the first is
      // skipped via the index fallback (no id field => key = input index).
      expect(searchCalls).toEqual(["Beta details"]);

      const lines = readFileSync(outputPath, "utf-8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(2);
      const second = JSON.parse(lines[1]) as {
        titel: string;
        beschreibung: string;
      };
      expect(second.titel).toBe("Beta");
      expect(second.beschreibung).toBe("Kurzbeschreibung");
    } finally {
      restoreStderr();
    }
  });

  it("resumes using a custom --resume-key field", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");
      const outputPath = join(tempDir, "output.jsonl");
      writeBaseConfig(configPath);

      writeFileSync(
        outputPath,
        '{"sku":"A1","titel":"Eins","beschreibung":"Kurzbeschreibung"}\n',
        "utf-8",
      );

      const searchCalls: string[] = [];

      await runPipeline({
        config: configPath,
        outputPath,
        skipFields: [],
        workers: 1,
        dryRun: false,
        verbose: 0,
        resume: true,
        resumeKey: "sku",
        stdin: Readable.from([
          '{"sku":"A1","titel":"Eins"}\n{"sku":"B2","titel":"Zwei"}\n',
        ]),
        searchFn: async (query) => {
          searchCalls.push(query);
          return [];
        },
        llmClient: {
          extract: async () => ({ beschreibung: "Kurzbeschreibung" }),
        },
      });

      expect(searchCalls).toEqual(["Zwei details"]);
      const lines = readFileSync(outputPath, "utf-8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(2);
    } finally {
      restoreStderr();
    }
  });

  it("auto-switches to JSONL output when --resume is set on a JSON-array path", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");
      const outputPath = join(tempDir, "output.json");
      writeBaseConfig(configPath);

      writeFileSync(
        outputPath,
        '{"id":"1","titel":"Eins","beschreibung":"Kurzbeschreibung"}\n',
        "utf-8",
      );

      await runPipeline({
        config: configPath,
        outputPath,
        skipFields: [],
        workers: 1,
        dryRun: false,
        verbose: 1,
        resume: true,
        stdin: Readable.from([
          '{"id":"1","titel":"Eins"}\n{"id":"2","titel":"Zwei"}\n',
        ]),
        searchFn: async () => [],
        llmClient: {
          extract: async () => ({ beschreibung: "Kurzbeschreibung" }),
        },
      });

      // The .json path was switched to JSONL: the file is now JSONL, with the
      // pre-existing line preserved and the new record appended.
      const content = readFileSync(outputPath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(2);
      expect(() => JSON.parse(lines[0])).not.toThrow();
      expect(() => JSON.parse(lines[1])).not.toThrow();
    } finally {
      restoreStderr();
    }
  });

  it("treats --resume as a no-op when writing to stdout (no output file)", async () => {
    const restoreStderr = silenceStderr();
    try {
      const tempDir = createTempDir();
      const configPath = join(tempDir, "config.yaml");
      writeBaseConfig(configPath);
      const { stdout, chunks } = captureStdout();

      const extractCalls: string[] = [];

      await runPipeline({
        config: configPath,
        skipFields: [],
        workers: 1,
        dryRun: false,
        verbose: 0,
        resume: true,
        stdin: Readable.from([
          '{"id":"1","titel":"Eins"}\n{"id":"2","titel":"Zwei"}\n',
        ]),
        stdout,
        searchFn: async () => [],
        llmClient: {
          extract: async (_system, user) => {
            extractCalls.push(user);
            return { beschreibung: "Kurzbeschreibung" };
          },
        },
      });

      // No file to read from => every record is processed normally.
      expect(extractCalls).toHaveLength(2);
      expect(chunks).toHaveLength(2);
    } finally {
      restoreStderr();
    }
  });
});
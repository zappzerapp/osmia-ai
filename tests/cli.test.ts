import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCliEntryPoint, run } from "../src/cli.js";
import { runPipeline } from "../src/pipeline.js";

vi.mock("../src/pipeline.js", () => ({
  runPipeline: vi.fn().mockResolvedValue(undefined),
}));

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      import("node:fs").then(({ rmSync }) =>
        rmSync(tempDir, { recursive: true, force: true }),
      );
    }
  }
});

function createTempDir(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "osmia-cli-"));
  tempDirs.push(tempDir);
  return tempDir;
}

describe("isCliEntryPoint", () => {
  it("matches the current module when invoked through a symlinked bin path", () => {
    const tempDir = createTempDir();
    const targetPath = join(tempDir, "cli.js");
    const symlinkPath = join(tempDir, "osmia-ai");

    writeFileSync(targetPath, "#!/usr/bin/env node\n", "utf-8");
    symlinkSync(targetPath, symlinkPath);

    expect(
      isCliEntryPoint(pathToFileURL(targetPath).href, ["node", symlinkPath]),
    ).toBe(true);
  });

  it("returns false for a different executable path", () => {
    const tempDir = createTempDir();
    const targetPath = join(tempDir, "cli.js");
    const otherPath = join(tempDir, "other.js");

    writeFileSync(targetPath, "#!/usr/bin/env node\n", "utf-8");
    writeFileSync(otherPath, "#!/usr/bin/env node\n", "utf-8");

    expect(
      isCliEntryPoint(pathToFileURL(targetPath).href, ["node", otherPath]),
    ).toBe(false);
  });
});

describe("cli resume flags", () => {
  const mockedRunPipeline = vi.mocked(runPipeline);

  afterEach(() => {
    mockedRunPipeline.mockClear();
  });

  it("passes --resume and --resume-key through to runPipeline", async () => {
    await run([
      "node",
      "osmia-ai",
      "--config",
      "config.yaml",
      "--input",
      "in.json",
      "--output",
      "out.jsonl",
      "--resume",
      "--resume-key",
      "sku",
    ]);

    expect(mockedRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: true,
        resumeKey: "sku",
        outputPath: "out.jsonl",
        inputPath: "in.json",
        config: "config.yaml",
      }),
    );
  });

  it("defaults --resume-key to id and omits resume when --resume is not set", async () => {
    await run([
      "node",
      "osmia-ai",
      "--config",
      "config.yaml",
      "--output",
      "out.jsonl",
    ]);

    expect(mockedRunPipeline).toHaveBeenCalledWith(
      expect.not.objectContaining({ resume: true }),
    );
    expect(mockedRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ resumeKey: "id" }),
    );
  });
});

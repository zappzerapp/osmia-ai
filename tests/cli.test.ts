import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isCliEntryPoint } from "../src/cli.js";

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

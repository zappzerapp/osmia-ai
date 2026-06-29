#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, realpathSync } from "node:fs";
import { stderr } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "./pipeline.js";
import { runConfigWizard } from "./wizard.js";

interface CliOptions {
  config?: string;
  input?: string;
  output?: string;
  skipIfExists?: string;
  wizard?: string | boolean;
  workers: number;
  dryRun: boolean;
  verbose: number;
  resume?: boolean;
  resumeKey?: string;
}

function parseSkipFields(skipIfExists: string | undefined): string[] {
  if (!skipIfExists) {
    return [];
  }

  return skipIfExists
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
}

function getCliVersion(): string {
  const packageJsonPath = fileURLToPath(
    new URL("../package.json", import.meta.url),
  );
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };

  return typeof packageJson.version === "string"
    ? packageJson.version
    : "0.0.0";
}

function buildCommand(): Command {
  const cli = new Command()
    .name("osmia-ai")
    .description("AI-powered data enrichment CLI tool")
    .version(getCliVersion())
    .option("-c, --config <path>", "Path to YAML configuration file")
    .option(
      "-i, --input <path>",
      "Path to input JSON/JSONL file (optional, reads stdin if not provided)",
    )
    .option(
      "-o, --output <path>",
      "Path to output JSON/JSONL file (optional, writes to stdout if not provided)",
    )
    .option(
      "-s, --skip-if-exists <fields>",
      "Comma-separated fields to skip when they already contain values",
    )
    .option(
      "-w, --workers <n>",
      "Number of concurrent workers",
      (value) => {
        const workers = Number.parseInt(value, 10);
        if (!Number.isInteger(workers) || workers < 1) {
          throw new Error("Workers must be a positive integer");
        }
        return workers;
      },
      1,
    )
    .option("--dry-run", "Simulate processing without making LLM calls", false)
    .option(
      "--resume",
      "Resume an interrupted batch: skip records already present in the output file (requires JSONL output and a file --output)",
    )
    .option(
      "--resume-key <field>",
      "Field used to identify records for --resume (default: id; falls back to input index when absent)",
      "id",
    )
    .option(
      "--wizard [path]",
      "Launch an interactive wizard and create a YAML config file",
    )
    .option(
      "-v, --verbose",
      "Increase verbosity (repeat for more detail)",
      (_value, previous: number) => previous + 1,
      0,
    );

  cli
    .command("init")
    .description("Create a config file with an interactive wizard")
    .argument("[path]", "Where to write the generated YAML config")
    .action(async (path?: string) => {
      await runConfigWizard(path ? { outputPath: path } : {});
    });

  cli.action(async () => {
    const options = cli.opts<CliOptions>();

    if (options.wizard !== undefined) {
      await runConfigWizard(
        typeof options.wizard === "string"
          ? { outputPath: options.wizard }
          : {},
      );
      return;
    }

    if (!options.config) {
      throw new Error(
        'Missing required option "--config <path>". Use "--wizard" or "init" to create one.',
      );
    }

    const pipelineOptions = {
      config: options.config,
      skipFields: parseSkipFields(options.skipIfExists),
      workers: options.workers,
      dryRun: options.dryRun,
      verbose: options.verbose,
      ...(options.input ? { inputPath: options.input } : {}),
      ...(options.output ? { outputPath: options.output } : {}),
      ...(options.resume ? { resume: true } : {}),
      ...(options.resumeKey ? { resumeKey: options.resumeKey } : {}),
    };

    await runPipeline(pipelineOptions);
  });

  return cli;
}

export function isCliEntryPoint(
  metaUrl: string,
  argv: string[] = process.argv,
): boolean {
  const entryPath = argv[1];
  if (!entryPath) {
    return false;
  }

  try {
    return (
      realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(entryPath))
    );
  } catch {
    return false;
  }
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const cli = buildCommand();

  try {
    await cli.parseAsync(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode =
      typeof (error as { exitCode?: unknown }).exitCode === "number"
        ? (error as { exitCode: number }).exitCode
        : 1;

    stderr.write(`Error: ${message}\n`);
    process.exitCode = exitCode;
  }
}

if (isCliEntryPoint(import.meta.url)) {
  void run();
}
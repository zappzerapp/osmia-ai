import { once } from "node:events";
import { createWriteStream, readFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Writable } from "node:stream";

/** A record written to output. Structurally compatible with PipelineRecord. */
export type OutputRecord = Record<string, unknown>;

/**
 * Writes records to an output sink (file or stdout) in either streaming JSONL
 * or buffered JSON-array form.
 *
 * - JSONL writers emit one line per `writeRecord` (streaming).
 * - JSON-array writers buffer records and flush a pretty-printed array on
 *   `close()` (preserving the historical buffered/atomic-write semantics).
 * - `discard()` abandons the buffer without writing; for JSONL it is a no-op
 *   because streamed records have already left the process.
 */
export interface RecordWriter {
  writeRecord(record: OutputRecord): Promise<void> | void;
  close(): Promise<void> | void;
  discard(): Promise<void> | void;
}

export interface CreateWriterOptions {
  outputPath?: string | undefined;
  stdoutStream?: Writable | undefined;
  useJsonl: boolean;
  /** For JSONL file output: open in append mode (resume) instead of truncate. */
  append?: boolean | undefined;
}

/** True when content looks like newline-delimited JSON objects. */
export function detectJsonlFormat(content: string): boolean {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return false;
  }

  return lines.every((line) => {
    try {
      const parsed = JSON.parse(line);
      return (
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      );
    } catch {
      return false;
    }
  });
}

/**
 * Compute the resume key for a record. Falls back to the provided index as a
 * string when the key field is missing or empty, so unstable inputs still
 * resume (imperfectly, since index fallback only matches when output order
 * lines up with input order).
 */
export function computeRecordKey(
  record: OutputRecord,
  keyField: string,
  index: number,
): string {
  const value = record[keyField];
  if (
    value !== undefined &&
    value !== null &&
    String(value).trim().length > 0
  ) {
    return String(value);
  }
  return String(index);
}

/**
 * Read already-written records from an existing output file. Supports both
 * JSONL (one object per line) and a JSON array. Returns an empty array if the
 * file cannot be parsed.
 */
export function readExistingRecords(outputPath: string): OutputRecord[] {
  let content: string;
  try {
    content = readFileSync(outputPath, "utf-8");
  } catch {
    return [];
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  if (detectJsonlFormat(trimmed)) {
    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as OutputRecord);
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed as OutputRecord[];
    }
    if (parsed !== null && typeof parsed === "object") {
      return [parsed as OutputRecord];
    }
  } catch {
    // Fall through to empty.
  }

  return [];
}

function writeChunk(stream: Writable, chunk: string): Promise<void> {
  const canContinue = stream.write(chunk);
  if (canContinue) {
    return Promise.resolve();
  }
  return once(stream, "drain").then(() => undefined);
}

/** Streaming JSONL writer: one JSON object per line, flushed immediately. */
class JsonlStreamWriter implements RecordWriter {
  private readonly destination: Writable;

  constructor(destination: Writable) {
    this.destination = destination;
  }

  async writeRecord(record: OutputRecord): Promise<void> {
    await writeChunk(this.destination, `${JSON.stringify(record)}\n`);
  }

  async close(): Promise<void> {
    // Never end stdout/stderr-style streams we don't own.
    if (this.destination === process.stdout) {
      return;
    }
    this.destination.end();
    await new Promise<void>((resolve, reject) => {
      this.destination.once("finish", () => resolve());
      this.destination.once("error", (error: Error) => reject(error));
    });
  }

  discard(): void {
    // Records already streamed; nothing to retract.
  }
}

/** Streaming JSONL writer backed by a file (truncate or append). */
class JsonlFileWriter implements RecordWriter {
  private readonly stream: Writable;

  constructor(outputPath: string, append: boolean) {
    this.stream = createWriteStream(outputPath, {
      flags: append ? "a" : "w",
    });
  }

  async writeRecord(record: OutputRecord): Promise<void> {
    await writeChunk(this.stream, `${JSON.stringify(record)}\n`);
  }

  async close(): Promise<void> {
    this.stream.end();
    await Promise.race([
      once(this.stream, "finish").then(() => undefined),
      once(this.stream, "error").then(([error]) => Promise.reject(error)),
    ]);
  }

  discard(): void {
    // Records already on disk; nothing to retract.
  }
}

/** Buffered JSON-array writer. Flushes a pretty-printed array on close(). */
class JsonArrayStreamWriter implements RecordWriter {
  private readonly destination: Writable;
  private readonly buffer: OutputRecord[] = [];

  constructor(destination: Writable) {
    this.destination = destination;
  }

  writeRecord(record: OutputRecord): void {
    this.buffer.push(record);
  }

  async close(): Promise<void> {
    await writeChunk(this.destination, JSON.stringify(this.buffer, null, 2));
    if (this.destination !== process.stdout) {
      this.destination.end();
      await new Promise<void>((resolve, reject) => {
        this.destination.once("finish", () => resolve());
        this.destination.once("error", (error: Error) => reject(error));
      });
    }
  }

  discard(): void {
    this.buffer.length = 0;
  }
}

/** Buffered JSON-array file writer. Atomic temp-file + rename on close(). */
class JsonArrayFileWriter implements RecordWriter {
  private readonly outputPath: string;
  private readonly buffer: OutputRecord[] = [];

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  writeRecord(record: OutputRecord): void {
    this.buffer.push(record);
  }

  async close(): Promise<void> {
    const tempOutputPath = join(
      dirname(this.outputPath),
      `.${basename(this.outputPath)}.${process.pid}.${Date.now()}.tmp`,
    );
    const writeStream = createWriteStream(tempOutputPath);

    try {
      await writeChunk(writeStream, JSON.stringify(this.buffer, null, 2));
      writeStream.end();
      await Promise.race([
        once(writeStream, "finish").then(() => undefined),
        once(writeStream, "error").then(([error]) => Promise.reject(error)),
      ]);
      await rename(tempOutputPath, this.outputPath);
    } catch (error) {
      writeStream.destroy();
      await rm(tempOutputPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  discard(): void {
    this.buffer.length = 0;
  }
}

/**
 * Build a RecordWriter for the given output target and format.
 *
 * - JSONL file output respects `append` (resume) vs truncate (fresh).
 * - JSON-array file output is always written atomically on close().
 * - stdout output is never ended by the writer.
 */
export function createRecordWriter(
  options: CreateWriterOptions,
): RecordWriter {
  const { outputPath, stdoutStream, useJsonl, append = false } = options;

  if (useJsonl) {
    if (outputPath) {
      return new JsonlFileWriter(outputPath, append);
    }
    return new JsonlStreamWriter(stdoutStream ?? process.stdout);
  }

  if (outputPath) {
    return new JsonArrayFileWriter(outputPath);
  }
  return new JsonArrayStreamWriter(stdoutStream ?? process.stdout);
}
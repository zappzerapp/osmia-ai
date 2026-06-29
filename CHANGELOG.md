# Changelog

All notable changes to this project are documented in this file.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-06-29

### Added

- **Full-page content fetching** (`research.fetchPageContent`, default `false`).
  When enabled, the pipeline fetches the full text of each search result page
  (via `@mozilla/readability` + `jsdom`) and feeds it to the LLM instead of the
  short search snippet. New tuning fields: `research.maxPageChars` (default
  `8000`), `research.pageFetchTimeoutMs`, `research.pageFetchMaxRetries`,
  `research.pageFetchRequestsPerMinute`, `research.pageFetchMaxConcurrency`.
  Page fetches are non-fatal: on error the record falls back to the snippet and
  continues. New module `src/fetcher.ts`.
- **Ollama structured outputs** (`llm.structuredOutput`, default `true`). The
  extraction schema is sent to Ollama as the `format` field so the model is
  constrained to schema-conform JSON. `parseJSONResponse` /
  `stripMarkdownCodeBlocks` remain as a fallback. New helpers exported from
  `src/llm.ts`: `buildJsonSchema`, `ExtractionSchema`, `ExtractionSchemaField`.
- **Source provenance** (`extraction.includeSources`, default `false`;
  `extraction.sourcesField`, default `_sources`). When enabled, each enriched
  record gets `[{ url, title }, …]` of the search results attached after
  validation — the sources are never sent to the LLM.
- **Resume for large batches**: `--resume` and `--resume-key <field>` CLI flags.
  Reads already-written records from the output file and skips them, appending
  the rest. Requires a file `--output`; auto-switches to JSONL. Falls back to
  the input index when the key field is absent.
- **Streaming JSONL output**. `runPipeline` now writes JSONL records
  incrementally as they succeed (new `src/output.ts` `RecordWriter`
  abstraction); JSON-array output remains buffered and flushed at the end. On
  abort, JSONL keeps the already-streamed records (which is what makes
  `--resume` work); JSON-array discards the buffer.

### Changed (behavioural, default flips)

- `llm.structuredOutput` now defaults to `true`. Existing configs that do not
  set it will send a JSON-Schema `format` object to Ollama instead of `"json"`.
  The output shape is unchanged; opt out with `structuredOutput: false`.
- `runPipeline` streams JSONL incrementally instead of writing the whole file
  once at the end. A partially completed run leaves a valid partial JSONL file
  (re-run with `--resume` to continue). JSON-array output is unaffected.

### Internal

- `detectJsonlFormat` moved from `src/pipeline.ts` to `src/output.ts` and is
  re-exported from `pipeline.ts`; existing imports keep working.

## [0.3.1] — earlier

- Fix ESM require crash in search providers.
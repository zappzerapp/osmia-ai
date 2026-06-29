# 🐝 Osmia AI

A stateless, AI-powered CLI tool for data enrichment. **Unix philosophy: File-In ➔ File-Out**.

## Overview

Osmia takes raw JSON/JSONL data, enriches it via web search + LLM, and outputs enhanced data without introducing a
database or backend.

```bash
cat input.json | npx osmia-ai --config config.yaml > enriched.json
```

## Features

- **Stateless**: Pure data transformation, no persistent state
- **Unix Pipes**: Native stdin/stdout support
- **Resilient**: Retries with backoff and `429` handling for search and LLM calls
- **Full-page content**: Optionally fetch and readability-clean each result URL for richer extraction context (config-driven, no extra flag)
- **Concurrent**: Configurable workers with separate throttles for search, page fetch, and LLM
- **Smart Skip**: Skip already-enriched records (--skip-if-exists)
- **Streaming JSONL**: JSONL output streams record-by-record so completed records persist even if the batch aborts
- **Resume**: Re-run interrupted batches with --resume, skipping records already present in the output file
- **Configurable**: YAML config with templated search queries
- **JSONL Support**: Works with JSONL input and output formats

## Installation

Requires Node.js 24 LTS or newer.

```bash
npm install -g osmia-ai
# or use directly
npx osmia-ai --config config.yaml --input data.json --output enriched.json
```

## Quick Start

1. **Create `config.yaml`**
   ```bash
   osmia-ai init
   ```
   The new wizard asks for your LLM settings, search template, extraction prompt, and schema fields, then writes a valid
   YAML config for you.
   Run it in an interactive terminal, not via a pipe or CI stdin.

2. **Set API keys** (depends on your search provider — default is Exa):
   ```bash
   export OLLAMA_API_KEY="your-ollama-cloud-api-key"
   export EXA_API_KEY="your-exa-api-key"
   ```

3. **Run**:
   ```bash
   osmia-ai --config config.yaml --input data.json --output enriched.json
   ```

### Try the bundled examples

Sample data and ready-made configs live in [examples/](examples/):

| File | Purpose |
| --- | --- |
| [catalog-config.yaml](examples/catalog-config.yaml) | Standard catalog enrichment (Exa search) |
| [catalog-batch-config.yaml](examples/catalog-batch-config.yaml) | Same schema, conservative rate limits for large batches |
| [catalog-duckduckgo-config.yaml](examples/catalog-duckduckgo-config.yaml) | Same schema, no search API key required |
| [sample-input.json](examples/sample-input.json) | Two sample products (JSON array) |
| [sample-input.jsonl](examples/sample-input.jsonl) | Same records as JSONL |

```bash
export OLLAMA_API_KEY="your-ollama-cloud-api-key"
export EXA_API_KEY="your-exa-api-key"

osmia-ai \
  --config examples/catalog-config.yaml \
  --input examples/sample-input.json \
  --output enriched.json
```

For a quick local try without an Exa key, use the DuckDuckGo example instead:

```bash
export OLLAMA_API_KEY="your-ollama-cloud-api-key"

osmia-ai \
  --config examples/catalog-duckduckgo-config.yaml \
  --input examples/sample-input.json \
  --output enriched.json
```

## Usage

```
Usage: osmia-ai [options]

Options:
  -c, --config <path>            YAML configuration file
  -i, --input <path>             Input JSON/JSONL file (reads stdin if not provided)
  -o, --output <path>           Output file (writes stdout if not provided)
  -s, --skip-if-exists <fields>  Comma-separated fields to skip if non-empty
  -w, --workers <n>             Concurrent workers (default: 1)
  --dry-run                     Simulate without LLM calls
  --resume                       Resume an interrupted batch (skip records already in the output file; requires JSONL output)
  --resume-key <field>           Field used to identify records for --resume (default: id; falls back to input index)
  --wizard [path]               Launch an interactive wizard and create a YAML config file
  -v, --verbose                 Verbosity (use -v or -vv)
```

Create a config interactively:

```bash
osmia-ai init
# or
osmia-ai --wizard config.yaml
```

## Examples

### Basic Usage

```bash
osmia-ai --config config.yaml --input data.json --output enriched.json
```

### Generate Config Interactively

```bash
osmia-ai init config.yaml
```

### Unix Pipe

```bash
cat data.json | osmia-ai --config config.yaml > enriched.json
```

### With Skip Logic

```bash
osmia-ai -c config.yaml -i data.json -o enriched.json -s category,description,specs
```

### Concurrent Processing

```bash
osmia-ai --config config.yaml --input data.json --workers 5 --verbose
```

### Dry Run (Debug Prompts)

```bash
osmia-ai --config config.yaml --input data.json --dry-run -vv
```

### Resume an Interrupted Batch

JSONL output streams record-by-record: each successfully processed record is written as soon as
it completes, so if a long batch aborts (a record fails, the process is killed, or the network
drops) the records already finished are safe on disk. Re-run the same command with `--resume` to
skip the records already present in the output file and continue with the rest:

```bash
osmia-ai --config config.yaml --input data.json --output enriched.jsonl --resume
```

`--resume` reads the existing output file, parses the completed records, and skips any input
record whose key is already present. By default the key is the record's `id` field; change it
with `--resume-key <field>`. When the key field is absent on a record, osmia falls back to that
record's original input index (as a string), so unstable inputs still resume — imperfectly, since
the index fallback only matches when the output order lines up with the input order.

`--resume` requires JSONL output because it appends to the file. If the configured output would
be a JSON array (e.g. an `.json` path), osmia automatically switches to JSONL and logs a warning.
`--resume` with stdout output (no `--output` file) is a no-op: there is no file to read from, so
a warning is logged and every record is processed normally.

## Library Usage

Osmia ships as an ESM Node library too — the same modules the CLI uses are exported from the
package root, so you can embed enrichment in a script or service:

```ts
import { loadConfig, runPipeline } from "osmia-ai";

await runPipeline({
  config: "config.yaml",
  inputPath: "data.json",
  outputPath: "enriched.json",
  workers: 3,
  skipFields: [],
  dryRun: false,
  verbose: 0,
});
```

Notable exports (see [`src/index.ts`](src/index.ts) for the full surface):

- **Pipeline**: `runPipeline`, `loadInputData`, `saveOutputData`, `shouldSkipRecord`, `detectJsonlFormat`
- **Config**: `loadConfig`, `validateConfig`, `serializeConfig`, `configSchema`, `supportedExtractionFieldTypes`
- **LLM**: `LLMClient`, `LLMError`
- **Search**: `searchWeb`, `searchWithTemplate`, `formatQuery`
- **Wizard**: `runConfigWizard`, `createDefaultConfig`
- **Types**: `Config`, `LLMConfig`, `ResearchConfig`, `ExtractionConfig`, `PipelineOptions`, `PipelineRecord`, `SearchResult`

The zod schemas (`configSchema`, `llmConfigSchema`, `researchConfigSchema`, `extractionConfigSchema`)
let you validate or manipulate configs programmatically.

## Configuration

**Templating**: Use `{fieldName}` placeholders in `searchQuery`—they're replaced from input records.

Use [config.yaml.template](config.yaml.template) for the canonical default structure.
The [examples/](examples/) directory adds catalog-focused configs and sample input data.
`osmia-ai init` is the fastest way to generate a valid starting point interactively.

### Search providers

Set `research.provider` in your YAML config. Supported values: `exa` (default), `duckduckgo`, `google`, `ollama`.

| Provider | Required environment variables |
| --- | --- |
| `exa` | `EXA_API_KEY` |
| `duckduckgo` | none |
| `google` | `GOOGLE_API_KEY`, `GOOGLE_SEARCH_ENGINE_ID` |
| `ollama` | `OLLAMA_API_KEY` |

The LLM always uses the key named by `llm.apiKeyEnv` (default: `OLLAMA_API_KEY`).

### Full-page content

By default the LLM only sees the short snippets returned by the search provider. Enable
`research.fetchPageContent` to fetch each result URL, extract the main article text with
Readability, and feed that into the extraction prompt instead of the snippet. This is the single
biggest quality lever, but it is slower, sends more tokens to the LLM, and adds a second
rate-limited HTTP queue.

```yaml
research:
  fetchPageContent: true
  maxPageChars: 8000          # cap per result (snippet is capped at this, not 4000)
  pageFetchTimeoutMs: 15000
  pageFetchMaxRetries: 2
  pageFetchRequestsPerMinute: 20
  pageFetchMaxConcurrency: 2
```

This is config-driven — there is no `--fetch` flag. Fetch failures are non-fatal: a warning is
logged and the original search snippet is kept, so a record never fails because a page would not
load. Non-HTML responses (PDFs, images) and non-http(s) URLs are skipped automatically.

Note: the `exa` provider already returns page text via its contents API, so this option mainly
benefits `duckduckgo`, `google`, and `ollama`, which only return short snippets.

### Structured outputs

Structured outputs are enabled by default (`llm.structuredOutput: true`). When on, osmia sends the
extraction schema as a [JSON Schema](https://json-schema.org/) object in Ollama's `format` field so the
model is constrained to the configured shape. This noticeably improves reliability for small local
models and reduces the need for response repair.

The response is still parsed with the same fallback logic (`parseJSONResponse` /
`stripMarkdownCodeBlocks`), so a model that returns malformed JSON or wraps it in markdown code fences
keeps working. The final zod validation in the pipeline is unchanged.

Disable it for non-Ollama-compatible endpoints that do not accept a JSON Schema `format`:

```yaml
llm:
  structuredOutput: false
```

### Source provenance

Set `extraction.includeSources: true` to attach the URLs (and titles) of the search results that
fed each record's extraction as an array on the output record. By default the field is named
`_sources` and lists `{ url, title }` objects — the same results the LLM was given — so each
enrichment is machine-checkable against its origins. Rename the field with
`extraction.sourcesField` if it collides with a real data field. The array is added after the
LLM extraction and validation, so it never reaches the model or the extraction schema.

```yaml
extraction:
  includeSources: true
  sourcesField: _sources
```

### Extraction schema

`extraction.schema` maps each output field to its type. Valid `type` values:
`string`, `number`, `boolean`, `integer`, `array`, `object`, `null`, `unknown`, `any`.
A field may also carry a `description`:

```yaml
extraction:
  schema:
    category:
      type: "string"
      description: "Most likely product category"
    price:
      type: "number"
      description: "Price in EUR"
```

As a shorthand, a bare string is read as `{ type: <string> }`:

```yaml
extraction:
  schema:
    category: "string"
    price: "number"
```

The schema is enforced with zod after the LLM responds, before the record is written.

## Use Cases

- **E-commerce**: Enrich product catalogs with specs and descriptions
- **Research**: Augment datasets with web metadata
- **Content**: Generate summaries, tags, categorizations
- **Contacts**: Enrich contact lists with company info

## Development

```bash
nvm use
npm install
npm run build
npm test
npm run dev -- --config config.yaml --input data.json   # run from source via tsx (no build needed)
npm run lint                                            # typecheck without emitting
```

Both `camelCase` and legacy `snake_case` config keys are accepted when loading YAML files.

For JSON-array output (`.json` or stdout), the pipeline aborts before writing if any record fails, so batch jobs do not silently leave behind partial result files. For JSONL output, records stream record-by-record as they complete, so completed records persist on disk even when a later record fails — re-run with `--resume` (see above) to continue the batch.

For large batches, start conservatively with `--workers 2` or `--workers 3` and increase `requestsPerMinute` only after
confirming that both your search provider and LLM endpoint accept the traffic without returning `429` responses.

## License

MIT

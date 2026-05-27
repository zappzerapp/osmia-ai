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
- **Concurrent**: Configurable workers with separate throttles for search and LLM
- **Smart Skip**: Skip already-enriched records (--skip-if-exists)
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
```

Both `camelCase` and legacy `snake_case` config keys are accepted when loading YAML files.

Runs abort before writing output if any record fails, so batch jobs do not silently leave behind partial result files.

For large batches, start conservatively with `--workers 2` or `--workers 3` and increase `requestsPerMinute` only after
confirming that both your search provider and LLM endpoint accept the traffic without returning `429` responses.

## License

MIT

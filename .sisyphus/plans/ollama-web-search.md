# Plan: Add Ollama Web Search Provider

## Goal
Add `ollama` as a new search provider in `@src/config.ts` and implement its search logic in `@src/search.ts`, following the same pattern as existing providers (exa, duckduckgo, google).

## API Details (from Ollama docs)
- **Endpoint**: `POST https://ollama.com/api/web_search`
- **Auth**: `Authorization: Bearer $OLLAMA_API_KEY` header
- **Request body**: `{ query: string, max_results?: number }` (max_results default 5, max 10)
- **Response**: `{ results: [{ title: string, url: string, content: string }] }`

## Changes

### 1. `src/config.ts` — Add "ollama" to search providers
- Add `"ollama"` to the `searchProviders` array (line 65)
- The type `SearchProvider` auto-derives from the array

### 2. `src/search.ts` — Implement Ollama search provider
- Add `getOllamaApiKey()` helper (reads `OLLAMA_API_KEY` env var, throws `SearchError` if missing)
- Add `ollamaProvider: SearchProviderImpl` object with a `search()` method:
  - POSTs to `https://ollama.com/api/web_search` with `Authorization: Bearer <key>` header
  - Sends `{ query, max_results }` JSON body
  - Maps response `results[]` to `SearchResult[]` (title, url, snippet from content)
  - Wraps fetch in `Promise.race` with `createTimeout` (same pattern as google/exa)
  - Handles non-ok responses with `SearchError` including status code and retryability
- Register `ollamaProvider` in the `providers` record (line 277)
- Update the error message in `getProvider` (line 287) to include "ollama" in the list

### 3. `package.json` — No new dependencies needed
- The Ollama web search API is a simple REST call with `fetch`; no SDK required

### 4. `tests/search.test.ts` — No test changes needed
- Existing tests only cover `formatQuery` and `formatSearchResults` helpers, which are provider-agnostic

## Verification
- `npm run lint` — no type errors
- `npm test` — existing tests pass
- `npm run build` — builds cleanly
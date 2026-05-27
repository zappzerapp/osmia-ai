import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SNIPPET_CHARS,
  formatQuery,
  formatSearchResults,
  limitSnippet,
  type SearchResult,
} from "../src/search.js";

describe("search helpers", () => {
  it("fills known template placeholders and keeps unknown ones intact", () => {
    expect(
      formatQuery("Product {name} {missing}", {
        name: "Studio Headphones",
      })
    ).toBe("Product Studio Headphones {missing}");
  });

  it("formats search results for prompt injection", () => {
    const results: SearchResult[] = [
      {
        title: "Studio Headphones",
        url: "https://example.com/studio-headphones",
        snippet: "Over-ear headphones with noise isolation",
      },
    ];

    expect(formatSearchResults(results)).toContain("Studio Headphones");
    expect(formatSearchResults([])).toBe("No web results found.");
  });

  it("truncates oversized snippets", () => {
    const longText = "x".repeat(DEFAULT_MAX_SNIPPET_CHARS + 500);

    expect(limitSnippet(longText, DEFAULT_MAX_SNIPPET_CHARS)).toHaveLength(
      DEFAULT_MAX_SNIPPET_CHARS + 1
    );
    expect(limitSnippet(longText, DEFAULT_MAX_SNIPPET_CHARS).endsWith("…")).toBe(true);
    expect(limitSnippet("short text", DEFAULT_MAX_SNIPPET_CHARS)).toBe("short text");
  });
});

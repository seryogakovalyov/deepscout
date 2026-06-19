import type { SearchConfig } from "../../core/config";

export function createRuntimeConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
  const base: SearchConfig = {
    maxResults: overrides.maxResults ?? 8,
    maxPages: overrides.maxPages ?? 3,
    timeoutMs: overrides.timeoutMs ?? 8000,
    locale: overrides.locale ?? "en-us",
    searxngUrl: overrides.searxngUrl,
    embeddingsUrl: overrides.embeddingsUrl ?? "http://localhost:8000",
    searchWindow: overrides.searchWindow ?? "y",
  };
  return base;
}

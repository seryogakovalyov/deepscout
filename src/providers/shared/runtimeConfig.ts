import type { SearchConfig } from "../../core/config";
import { searchConfigFromEnv } from "../../core/config";

export function createRuntimeConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
  return searchConfigFromEnv(overrides);
}

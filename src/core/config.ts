// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;

export type SearchTimeWindow = "d" | "w" | "m" | "y";

export interface SearchConfig {
  maxResults: number;
  maxPages: number;
  timeoutMs: number;
  locale: string;
  exaApiKey?: string;
  searxngUrl?: string;
  searxngRetryAttempts: number;
  searxngRetryDelayMs: number;
  searxngRetryBackoffMultiplier: number;
  embeddingsUrl?: string;
  searchWindow?: SearchTimeWindow;
}

export interface McpHttpConfig {
  host: string;
  port: number;
}

export type RuntimeConfig = SearchConfig;

const SEARCH_DEFAULTS: Omit<SearchConfig, "embeddingsUrl" | "searchWindow"> = {
  maxResults: 8,
  maxPages: 3,
  timeoutMs: 8000,
  locale: "en-us",
  searxngRetryAttempts: 3,
  searxngRetryDelayMs: 1500,
  searxngRetryBackoffMultiplier: 2,
};

const SEARCH_TIME_MAP: Record<string, SearchTimeWindow> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

const MCP_HTTP_DEFAULTS: McpHttpConfig = {
  host: "127.0.0.1",
  port: 8787,
};

function parseEnvNumber(env: string | undefined, fallback: number): number {
  if (env === undefined) return fallback;
  const n = Number.parseInt(env, 10);
  return Number.isNaN(n) ? fallback : n;
}

function parseEnvFloat(env: string | undefined, fallback: number): number {
  if (env === undefined) return fallback;
  const n = Number.parseFloat(env);
  return Number.isNaN(n) ? fallback : n;
}

function minNumber(value: number, min: number): number {
  return Number.isFinite(value) ? Math.max(value, min) : min;
}

function parseEnvTimeWindow(env: string | undefined): SearchTimeWindow | undefined {
  if (!env) return undefined;
  return SEARCH_TIME_MAP[env.trim().toLowerCase()] ?? undefined;
}

export function searchConfigFromEnv(overrides?: Partial<SearchConfig>): SearchConfig {
  const env = process.env;
  return {
    maxResults: parseEnvNumber(env.MAX_SEARCH_RESULTS, overrides?.maxResults ?? SEARCH_DEFAULTS.maxResults),
    maxPages: parseEnvNumber(env.MAX_PAGES_PER_SEARCH, overrides?.maxPages ?? SEARCH_DEFAULTS.maxPages),
    timeoutMs: parseEnvNumber(env.FETCH_TIMEOUT_MS, overrides?.timeoutMs ?? SEARCH_DEFAULTS.timeoutMs),
    locale: env.SEARCH_LANGUAGE ?? overrides?.locale ?? SEARCH_DEFAULTS.locale,
    exaApiKey: env.EXA_API_KEY ?? overrides?.exaApiKey,
    searxngUrl: env.SEARXNG_URL ?? overrides?.searxngUrl,
    searxngRetryAttempts: minNumber(parseEnvNumber(env.SEARXNG_RETRY_ATTEMPTS, overrides?.searxngRetryAttempts ?? SEARCH_DEFAULTS.searxngRetryAttempts), 1),
    searxngRetryDelayMs: minNumber(parseEnvNumber(env.SEARXNG_RETRY_DELAY_MS, overrides?.searxngRetryDelayMs ?? SEARCH_DEFAULTS.searxngRetryDelayMs), 0),
    searxngRetryBackoffMultiplier: minNumber(parseEnvFloat(env.SEARXNG_RETRY_BACKOFF_MULTIPLIER, overrides?.searxngRetryBackoffMultiplier ?? SEARCH_DEFAULTS.searxngRetryBackoffMultiplier), 1),
    embeddingsUrl: env.EMBEDDINGS_BASE_URL ?? overrides?.embeddingsUrl,
    searchWindow: parseEnvTimeWindow(env.SEARCH_RECENCY_WINDOW) ?? overrides?.searchWindow,
  };
}

export function mcpHttpConfigFromEnv(overrides?: Partial<McpHttpConfig>): McpHttpConfig {
  const env = process.env;
  return {
    host: env.MCP_HTTP_HOST ?? overrides?.host ?? MCP_HTTP_DEFAULTS.host,
    port: parseEnvNumber(env.MCP_HTTP_PORT, overrides?.port ?? MCP_HTTP_DEFAULTS.port),
  };
}

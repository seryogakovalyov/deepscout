"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchConfigFromEnv = searchConfigFromEnv;
exports.mcpHttpConfigFromEnv = mcpHttpConfigFromEnv;
const SEARCH_DEFAULTS = {
    maxResults: 8,
    maxPages: 3,
    timeoutMs: 8000,
    locale: "en-us",
};
const SEARCH_TIME_MAP = {
    day: "d",
    week: "w",
    month: "m",
    year: "y",
};
const MCP_HTTP_DEFAULTS = {
    host: "127.0.0.1",
    port: 8787,
};
function parseEnvNumber(env, fallback) {
    if (env === undefined)
        return fallback;
    const n = Number.parseInt(env, 10);
    return Number.isNaN(n) ? fallback : n;
}
function parseEnvTimeWindow(env) {
    if (!env)
        return undefined;
    return SEARCH_TIME_MAP[env.trim().toLowerCase()] ?? undefined;
}
function searchConfigFromEnv(overrides) {
    const env = process.env;
    return {
        maxResults: parseEnvNumber(env.MAX_SEARCH_RESULTS, overrides?.maxResults ?? SEARCH_DEFAULTS.maxResults),
        maxPages: parseEnvNumber(env.MAX_PAGES_PER_SEARCH, overrides?.maxPages ?? SEARCH_DEFAULTS.maxPages),
        timeoutMs: parseEnvNumber(env.FETCH_TIMEOUT_MS, overrides?.timeoutMs ?? SEARCH_DEFAULTS.timeoutMs),
        locale: env.SEARCH_LANGUAGE ?? overrides?.locale ?? SEARCH_DEFAULTS.locale,
        searxngUrl: env.SEARXNG_URL ?? overrides?.searxngUrl,
        embeddingsUrl: env.EMBEDDINGS_BASE_URL ?? overrides?.embeddingsUrl,
        searchWindow: parseEnvTimeWindow(env.SEARCH_RECENCY_WINDOW) ?? overrides?.searchWindow,
    };
}
function mcpHttpConfigFromEnv(overrides) {
    const env = process.env;
    return {
        host: env.MCP_HTTP_HOST ?? overrides?.host ?? MCP_HTTP_DEFAULTS.host,
        port: parseEnvNumber(env.MCP_HTTP_PORT, overrides?.port ?? MCP_HTTP_DEFAULTS.port),
    };
}

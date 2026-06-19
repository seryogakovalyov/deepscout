"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRuntimeConfig = createRuntimeConfig;
function createRuntimeConfig(overrides = {}) {
    const base = {
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

const { ddgSearch } = require("../core/search");
const { searchConfigFromEnv, mcpHttpConfigFromEnv } = require("../core/config");

type SearchTimeWindow = "d" | "w" | "m" | "y";

const config = searchConfigFromEnv();
const diagQuery = process.env.SEARCH_DIAG_QUERY;
const diagMaxResults = process.env.SEARCH_DIAG_MAX_RESULTS
  ? Number.parseInt(process.env.SEARCH_DIAG_MAX_RESULTS, 10)
  : undefined;

const query = diagQuery ?? "llama.cpp function calling";
const maxResults = diagMaxResults ?? config.maxResults;
const locale = config.locale;
const searxngUrl = config.searxngUrl;
const timeWindow = config.searchWindow;
const searxngRetry = {
  attempts: config.searxngRetryAttempts,
  delayMs: config.searxngRetryDelayMs,
  backoffMultiplier: config.searxngRetryBackoffMultiplier,
};

function parseTimeWindow(value: string | undefined): SearchTimeWindow | undefined {
  const map: Record<string, SearchTimeWindow> = { day: "d", week: "w", month: "m", year: "y" };
  if (!value) return undefined;
  return map[value.trim().toLowerCase()];
}

function selectedProvider(): string {
  return searxngUrl ? "SearXNG" : "DuckDuckGo HTML";
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function stripTagsSearch(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const text = await res.text();
  return { status: res.status, text };
}

function ddgUrl(): string {
  const params = new URLSearchParams({ q: query, kl: locale });
  if (timeWindow) params.set("df", timeWindow);
  return `https://html.duckduckgo.com/html/?${params}`;
}

function bingUrl(): string {
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}&setlang=en&cc=us`;
}

function searxngSearchUrl(): string | null {
  if (!searxngUrl) return null;
  const timeRange: Record<SearchTimeWindow, string> = { d: "day", w: "week", m: "month", y: "year" };
  const params: Record<string, string> = { q: query, format: "json" };
  if (timeWindow) params.time_range = timeRange[timeWindow];
  return `${searxngUrl.replace(/\/$/, "")}/search?${new URLSearchParams(params)}`;
}

function parseDDG(html: string): Array<{ title: string; url: string; snippet: string }> {
  const hits: Array<{ title: string; url: string; snippet: string }> = [];
  const linkRe = /class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && hits.length < maxResults) {
    const uddg = m[1].match(/[?]uddg=([^&"]+)/);
    let url = m[1];
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { continue; } }
    if (!url.startsWith("http")) continue;
    const title = stripTagsSearch(m[2]);
    if (title) hits.push({ title, url, snippet: "" });
  }
  return hits;
}

function parseBing(html: string): Array<{ title: string; url: string; snippet: string }> {
  const hits: Array<{ title: string; url: string; snippet: string }> = [];
  const liRe = /<li class="b_algo">([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html)) !== null && hits.length < maxResults) {
    const block = m[1];
    const linkM = block.match(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkM) continue;
    const title = stripTagsSearch(linkM[2]);
    if (title) hits.push({ title, url: linkM[1], snippet: "" });
  }
  return hits;
}

type ProviderDiagnostic = {
  name: string;
  configured: boolean;
  selected: boolean;
  healthy: boolean;
  url: string | null;
  status?: number;
  resultCount: number;
  error?: string;
  sampleTitles: string[];
  engineWarnings?: string[];
};

function warningToText(warning: unknown): string {
  if (typeof warning === "string") return warning;
  if (Array.isArray(warning)) return warning.map((item) => String(item)).join(":");
  if (warning && typeof warning === "object") {
    return Object.entries(warning)
      .map(([key, value]) => `${key}:${String(value)}`)
      .join(",");
  }
  return String(warning);
}

async function diagnoseSearXNG(): Promise<ProviderDiagnostic> {
  const url = searxngSearchUrl();
  if (!url) {
    return {
      name: "SearXNG",
      configured: false,
      selected: false,
      healthy: false,
      url: null,
      resultCount: 0,
      sampleTitles: [],
      error: "SEARXNG_URL is not configured",
    };
  }
  try {
    const { status, text } = await fetchText(url);
    const data = JSON.parse(text) as { results?: Array<{ title?: string; url?: string; content?: string }>; unresponsive_engines?: unknown[] };
    const hits = (data.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
    }));
    const engineWarnings = (data.unresponsive_engines ?? []).map(warningToText).filter(Boolean);
    return {
      name: "SearXNG",
      configured: true,
      selected: Boolean(searxngUrl),
      healthy: status >= 200 && status < 300 && hits.length > 0,
      url,
      status,
      resultCount: hits.length,
      sampleTitles: hits.map((hit) => hit.title).filter(Boolean),
      engineWarnings,
    };
  } catch (err) {
    return {
      name: "SearXNG",
      configured: true,
      selected: Boolean(searxngUrl),
      healthy: false,
      url,
      resultCount: 0,
      sampleTitles: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function diagnoseDDG(): Promise<ProviderDiagnostic> {
  const url = ddgUrl();
  try {
    const { status, text } = await fetchText(url);
    const hits = parseDDG(text);
    return {
      name: "DuckDuckGo HTML",
      configured: true,
      selected: !searxngUrl,
      healthy: status >= 200 && status < 300 && hits.length > 0,
      url,
      status,
      resultCount: hits.length,
      sampleTitles: hits.map((hit) => hit.title),
    };
  } catch (err) {
    return {
      name: "DuckDuckGo HTML",
      configured: true,
      selected: !searxngUrl,
      healthy: false,
      url,
      resultCount: 0,
      sampleTitles: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function diagnoseBing(): Promise<ProviderDiagnostic> {
  const url = bingUrl();
  try {
    const { status, text } = await fetchText(url);
    const hits = parseBing(text);
    return {
      name: "Bing HTML",
      configured: true,
      selected: false,
      healthy: status >= 200 && status < 300 && hits.length > 0,
      url,
      status,
      resultCount: hits.length,
      sampleTitles: hits.map((hit) => hit.title),
    };
  } catch (err) {
    return {
      name: "Bing HTML",
      configured: true,
      selected: false,
      healthy: false,
      url,
      resultCount: 0,
      sampleTitles: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function printProvider(provider: ProviderDiagnostic): void {
  console.log(`Provider: ${provider.name}`);
  console.log(`  configured: ${provider.configured}`);
  console.log(`  selected: ${provider.selected}`);
  console.log(`  healthy: ${provider.healthy}`);
  console.log(`  url: ${provider.url ?? "(none)"}`);
  if (provider.status !== undefined) console.log(`  http_status: ${provider.status}`);
  console.log(`  sample_search_results_count: ${provider.resultCount}`);
  if (provider.error) console.log(`  error: ${provider.error}`);
  if (provider.engineWarnings && provider.engineWarnings.length > 0) {
    console.log("  engine_warnings:");
    for (const warning of provider.engineWarnings.slice(0, 10)) console.log(`    - ${warning}`);
  }
  if (provider.sampleTitles.length > 0) {
    console.log("  sample_titles:");
    for (const title of provider.sampleTitles) console.log(`    - ${title}`);
  }
}

async function main(): Promise<void> {
  console.log("=== CONFIGURED PROVIDERS ===");
  console.log(`SearXNG: ${searxngUrl ? searxngUrl : "(not configured)"}`);
  console.log("DuckDuckGo HTML: enabled");
  console.log("Bing HTML: enabled as fallback");
  console.log("");

  console.log("=== SELECTED PROVIDER ===");
  console.log(selectedProvider());
  console.log("");

  console.log("=== DIAGNOSTIC QUERY ===");
  console.log(`query: ${query}`);
  console.log(`max_results: ${maxResults}`);
  console.log(`locale: ${locale}`);
  console.log(`time_window: ${timeWindow ?? "(none)"}`);
  console.log(`searxng_retry_attempts: ${searxngRetry.attempts}`);
  console.log(`searxng_retry_delay_ms: ${searxngRetry.delayMs}`);
  console.log(`searxng_retry_backoff_multiplier: ${searxngRetry.backoffMultiplier}`);
  console.log("");

  console.log("=== PROVIDER HEALTH ===");
  const providers = await Promise.all([
    diagnoseSearXNG(),
    diagnoseDDG(),
    diagnoseBing(),
  ]);
  for (const provider of providers) {
    printProvider(provider);
    console.log("");
  }

  console.log("=== FALLBACK CHAIN RESULT ===");
  try {
    const hits = await ddgSearch(query, maxResults, timeWindow, locale, searxngUrl, undefined, undefined, searxngRetry);
    console.log(`sample_search_results_count: ${hits.length}`);
    for (const hit of hits) console.log(`- ${hit.title} (${hit.url})`);
  } catch (err) {
    console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch((err: unknown) => {
  console.error("Search diagnostics failed.");
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});

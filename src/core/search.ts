import { fetchPage } from "./read";
import { rerankHits } from "./rerank";
import type { PageResult, SearchHit, SearchTimeWindow } from "./types";
import { sleep } from "./utils";

export type SearchStatus = (message: string) => void;

export type SearXNGRetryOptions = {
  attempts: number;
  delayMs: number;
  backoffMultiplier: number;
};

function report(status: SearchStatus | undefined, message: string): void {
  status?.(`[search] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedAttempts(attempts: number): number {
  return Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
}

function nextDelayMs(baseDelayMs: number, backoffMultiplier: number, attemptIndex: number): number {
  const multiplier = Number.isFinite(backoffMultiplier) ? Math.max(1, backoffMultiplier) : 1;
  const delay = Math.max(0, baseDelayMs) * Math.pow(multiplier, attemptIndex);
  return Math.min(Math.round(delay), 30_000);
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function stripTagsSearch(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

async function fetchSearchHtml(url: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    signal: fetchSignal,
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function scrapeDDG(query: string, max: number, time?: SearchTimeWindow, locale = "en-us", signal?: AbortSignal, status?: SearchStatus): Promise<SearchHit[]> {
  // DDG HTML: kl=locale, df=d|w|m|y for time filter
  const params = new URLSearchParams({ q: query, kl: locale });
  if (time) params.set("df", time);
  const url = `https://html.duckduckgo.com/html/?${params}`;
  report(status, `provider=duckduckgo request url=${url}`);
  const html = await fetchSearchHtml(url, 10_000, signal);

  const links: Array<{ title: string; url: string }> = [];
  const linkRe = /class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < max) {
    const uddg = m[1].match(/[?]uddg=([^&"]+)/);
    let url = m[1];
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { continue; } }
    if (!url.startsWith("http")) continue;
    const title = stripTagsSearch(m[2]);
    if (title) links.push({ url, title });
  }
  if (links.length === 0) {
    report(status, "provider=duckduckgo parsed_results=0");
    return [];
  }

  const snippets: string[] = [];
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:div|a)>/g;
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html)) !== null) snippets.push(stripTagsSearch(sm[1]));

  const results = links.map((l, i) => ({ ...l, snippet: snippets[i] ?? "" }));
  report(status, `provider=duckduckgo parsed_results=${results.length}`);
  return results;
}

// Bing HTML search has no reliable URL-based freshness parameter.
// (tbs=qdr:X is Google's parameter and was silently ignored by Bing.)
// Time filtering is handled by SearXNG and DDG tiers above.
async function scrapeBing(query: string, max: number, _time?: SearchTimeWindow, signal?: AbortSignal, status?: SearchStatus): Promise<SearchHit[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${max}&setlang=en&cc=us`;
  report(status, `provider=bing request url=${url}`);
  const html = await fetchSearchHtml(url, 10_000, signal);
  const results: SearchHit[] = [];
  const liRe = /<li class="b_algo">([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html)) !== null && results.length < max) {
    const block = m[1];
    const linkM = block.match(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkM) continue;
    const title = stripTagsSearch(linkM[2]);
    if (!title) continue;
    const snipM = block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) ??
                  block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({ title, url: linkM[1], snippet: snipM ? stripTagsSearch(snipM[1]) : "" });
  }
  report(status, `provider=bing parsed_results=${results.length}`);
  return results;
}

// SearXNG time_range values: day | week | month | year
const SEARXNG_TIME: Record<string, string> = { d: "day", w: "week", m: "month", y: "year" };

const TIME_WINDOW_DAYS: Record<SearchTimeWindow, number> = { d: 1, w: 7, m: 31, y: 366 };

type ExaResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    highlights?: string[];
    highlight?: string;
    text?: string;
    summary?: string;
    publishedDate?: string;
  }>;
};

function startPublishedDate(time?: SearchTimeWindow): string | undefined {
  if (!time) return undefined;
  const start = new Date(Date.now() - TIME_WINDOW_DAYS[time] * 24 * 60 * 60 * 1000);
  return start.toISOString();
}

function exaSnippet(result: NonNullable<ExaResponse["results"]>[number]): string {
  if (Array.isArray(result.highlights) && result.highlights.length > 0) return result.highlights.join("\n");
  return result.highlight ?? result.summary ?? result.text ?? "";
}

async function searchExa(apiKey: string, query: string, max: number, timeoutMs = 10_000, time?: SearchTimeWindow, signal?: AbortSignal, status?: SearchStatus): Promise<SearchHit[]> {
  const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const body: Record<string, unknown> = {
    query,
    type: "auto",
    numResults: max,
    contents: { highlights: true },
  };
  const startDate = startPublishedDate(time);
  if (startDate) body.startPublishedDate = startDate;

  report(status, `provider=exa request type=auto num_results=${max} time_window=${time ?? "none"}`);
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    signal: fetchSignal,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Exa HTTP ${res.status}`);

  const data = await res.json() as ExaResponse;
  const results = (data.results ?? []).slice(0, max).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: exaSnippet(r),
  })).filter((r) => r.url && r.title);
  report(status, `provider=exa parsed_results=${results.length}`);
  return results;
}

type SearXNGEngineWarning = string | unknown[] | Record<string, unknown>;

type SearXNGResponse = {
  results?: Array<{ url?: string; title?: string; content?: string }>;
  unresponsive_engines?: SearXNGEngineWarning[];
};

type SearXNGSearchResult = {
  hits: SearchHit[];
  warnings: string[];
  shouldBackoff: boolean;
};

function warningToText(warning: SearXNGEngineWarning): string {
  if (typeof warning === "string") return warning;
  if (Array.isArray(warning)) return warning.map((item) => String(item)).join(":");
  return Object.entries(warning)
    .map(([key, value]) => `${key}:${String(value)}`)
    .join(",");
}

function warningSuggestsBackoff(warnings: string[]): boolean {
  return warnings.some((warning) => /blocked|captcha|forbidden|too many|ratelimit|rate limit|timeout|timed out|429|403/i.test(warning));
}

async function searchSearXNG(baseUrl: string, query: string, max: number, timeoutMs = 10_000, time?: SearchTimeWindow, signal?: AbortSignal, status?: SearchStatus): Promise<SearXNGSearchResult> {
  const params: Record<string, string> = { q: query, format: "json" };
  if (time) params["time_range"] = SEARXNG_TIME[time] ?? "";
  const url = `${baseUrl.replace(/\/$/, "")}/search?${new URLSearchParams(params)}`;
  report(status, `provider=searxng request url=${url}`);
  const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { signal: fetchSignal, headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" } });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json() as SearXNGResponse;
  const results = (data.results ?? []).slice(0, max).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  })).filter((r) => r.url && r.title);
  const warnings = (data.unresponsive_engines ?? []).map(warningToText).filter(Boolean);
  if (warnings.length > 0) {
    report(status, `provider=searxng engine_warnings=${warnings.slice(0, 5).join(" | ")}`);
  }
  report(status, `provider=searxng parsed_results=${results.length}`);
  return {
    hits: results,
    warnings,
    shouldBackoff: results.length === 0,
  };
}

async function searchSearXNGWithRetry(
  baseUrl: string,
  query: string,
  max: number,
  timeoutMs = 10_000,
  time?: SearchTimeWindow,
  signal?: AbortSignal,
  status?: SearchStatus,
  retry: SearXNGRetryOptions = { attempts: 1, delayMs: 0, backoffMultiplier: 1 },
): Promise<SearchHit[]> {
  const attempts = boundedAttempts(retry.attempts);
  let lastResult: SearXNGSearchResult | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) break;
    report(status, `provider=searxng attempt=${attempt}/${attempts}`);
    lastResult = await searchSearXNG(baseUrl, query, max, timeoutMs, time, signal, status);
    if (!lastResult.shouldBackoff) return lastResult.hits;
    if (attempt >= attempts) break;

    const reason = warningSuggestsBackoff(lastResult.warnings) ? "engine_warning" : "zero_results";
    const delayMs = nextDelayMs(retry.delayMs, retry.backoffMultiplier, attempt - 1);
    report(status, `provider=searxng backoff reason=${reason} delay_ms=${delayMs}`);
    await sleepWithAbort(delayMs, signal);
  }

  return lastResult?.hits ?? [];
}

export async function ddgSearch(
  query: string,
  maxResults: number,
  time?: SearchTimeWindow,
  locale = "en-us",
  searxngUrl?: string,
  signal?: AbortSignal,
  status?: SearchStatus,
  searxngRetry: SearXNGRetryOptions = { attempts: 1, delayMs: 0, backoffMultiplier: 1 },
  exaApiKey?: string,
): Promise<SearchHit[]> {
  if (exaApiKey) {
    try {
      const results = await searchExa(exaApiKey, query, maxResults, 10_000, time, signal, status);
      if (results.length > 0) return results;
      report(status, "provider=exa result_count=0 fallback=searxng");
    } catch (error) {
      report(status, `provider=exa error=${errorMessage(error)} fallback=searxng`);
    }
  } else {
    report(status, "provider=exa skipped reason=not_configured");
  }

  if (searxngUrl) {
    try {
      const r = await searchSearXNGWithRetry(searxngUrl, query, maxResults, 10_000, time, signal, status, searxngRetry);
      if (r.length > 0) return r;
      if (time) {
        report(status, "provider=searxng result_count=0 retry_without_time_range=true");
        const retryWithoutTime = await searchSearXNGWithRetry(searxngUrl, query, maxResults, 10_000, undefined, signal, status, searxngRetry);
        if (retryWithoutTime.length > 0) {
          report(status, `provider=searxng fallback_without_time_range_results=${retryWithoutTime.length}`);
          return retryWithoutTime;
        }
      }
      report(status, "provider=searxng result_count=0 fallback=duckduckgo");
    } catch (error) {
      report(status, `provider=searxng error=${errorMessage(error)} fallback=duckduckgo`);
    }
  } else {
    report(status, "provider=searxng skipped reason=not_configured");
  }
  try {
    const results = await scrapeDDG(query, maxResults, time, locale, signal, status);
    if (results.length > 0) return results;
    report(status, "provider=duckduckgo result_count=0 fallback=bing");
  } catch (error) {
    report(status, `provider=duckduckgo error=${errorMessage(error)} fallback=bing`);
  }
  try {
    const results = await scrapeBing(query, maxResults, time, signal, status);
    if (results.length === 0) report(status, "provider=bing result_count=0 fallback=none");
    return results;
  } catch (error) {
    report(status, `provider=bing error=${errorMessage(error)} fallback=none`);
    return [];
  }
}

/** Search and then fetch+read the top N pages. Skips URLs already in `fetchedUrls` (dedup). */
export async function searchAndRead(
  query: string,
  maxResults: number,
  maxPages: number,
  timeoutMs: number,
  time?: SearchTimeWindow,
  locale = "en-us",
  fetchedUrls?: Set<string>,
  searxngUrl?: string,
  embeddingsUrl?: string,
  signal?: AbortSignal,
  status?: SearchStatus,
  searxngRetry: SearXNGRetryOptions = { attempts: 1, delayMs: 0, backoffMultiplier: 1 },
  exaApiKey?: string,
): Promise<{ hits: SearchHit[]; pages: PageResult[] }> {
  report(status, `query="${query}" max_results=${maxResults} time_window=${time ?? "none"} exa=${exaApiKey ? "configured" : "not_configured"} searxng=${searxngUrl ? "configured" : "not_configured"}`);
  let hits = await ddgSearch(query, maxResults, time, locale, searxngUrl, signal, status, searxngRetry, exaApiKey);
  report(status, `search_results=${hits.length}`);
  if (embeddingsUrl && hits.length > 1) {
    report(status, `rerank=enabled embeddings_url=${embeddingsUrl}`);
    hits = await rerankHits(query, hits, embeddingsUrl);
  } else {
    report(status, `rerank=skipped reason=${embeddingsUrl ? "not_enough_results" : "not_configured"}`);
  }
  const pages: PageResult[] = [];
  for (const h of hits) {
    if (signal?.aborted) break;
    // Stop when we have enough successful reads; errors don't fill the slot
    if (pages.filter((p) => !p.error).length >= maxPages) break;
    if (fetchedUrls?.has(h.url)) continue;
    fetchedUrls?.add(h.url);
    report(status, `fetch_page url=${h.url}`);
    const p = await fetchPage(h.url, timeoutMs, 8000, signal);
    pages.push(p);
    report(status, p.error ? `fetch_page error=${p.error} url=${h.url}` : `fetch_page ok words=${p.wordCount} url=${h.url}`);
    await sleep(300);
  }
  return { hits, pages };
}

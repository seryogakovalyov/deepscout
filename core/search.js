"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ddgSearch = ddgSearch;
exports.searchAndRead = searchAndRead;
const read_1 = require("./read");
const rerank_1 = require("./rerank");
const utils_1 = require("./utils");
function report(status, message) {
    status?.(`[search] ${message}`);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function decodeHtmlEntities(s) {
    return s
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function stripTagsSearch(html) {
    return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}
async function fetchSearchHtml(url, timeoutMs = 10_000, signal) {
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
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    return await res.text();
}
async function scrapeDDG(query, max, time, locale = "en-us", signal, status) {
    // DDG HTML: kl=locale, df=d|w|m|y for time filter
    const params = new URLSearchParams({ q: query, kl: locale });
    if (time)
        params.set("df", time);
    const url = `https://html.duckduckgo.com/html/?${params}`;
    report(status, `provider=duckduckgo request url=${url}`);
    const html = await fetchSearchHtml(url, 10_000, signal);
    const links = [];
    const linkRe = /class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = linkRe.exec(html)) !== null && links.length < max) {
        const uddg = m[1].match(/[?]uddg=([^&"]+)/);
        let url = m[1];
        if (uddg) {
            try {
                url = decodeURIComponent(uddg[1]);
            }
            catch {
                continue;
            }
        }
        if (!url.startsWith("http"))
            continue;
        const title = stripTagsSearch(m[2]);
        if (title)
            links.push({ url, title });
    }
    if (links.length === 0) {
        report(status, "provider=duckduckgo parsed_results=0");
        return [];
    }
    const snippets = [];
    const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:div|a)>/g;
    let sm;
    while ((sm = snipRe.exec(html)) !== null)
        snippets.push(stripTagsSearch(sm[1]));
    const results = links.map((l, i) => ({ ...l, snippet: snippets[i] ?? "" }));
    report(status, `provider=duckduckgo parsed_results=${results.length}`);
    return results;
}
// Bing HTML search has no reliable URL-based freshness parameter.
// (tbs=qdr:X is Google's parameter and was silently ignored by Bing.)
// Time filtering is handled by SearXNG and DDG tiers above.
async function scrapeBing(query, max, _time, signal, status) {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${max}&setlang=en&cc=us`;
    report(status, `provider=bing request url=${url}`);
    const html = await fetchSearchHtml(url, 10_000, signal);
    const results = [];
    const liRe = /<li class="b_algo">([\s\S]*?)<\/li>/g;
    let m;
    while ((m = liRe.exec(html)) !== null && results.length < max) {
        const block = m[1];
        const linkM = block.match(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!linkM)
            continue;
        const title = stripTagsSearch(linkM[2]);
        if (!title)
            continue;
        const snipM = block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) ??
            block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        results.push({ title, url: linkM[1], snippet: snipM ? stripTagsSearch(snipM[1]) : "" });
    }
    report(status, `provider=bing parsed_results=${results.length}`);
    return results;
}
// SearXNG time_range values: day | week | month | year
const SEARXNG_TIME = { d: "day", w: "week", m: "month", y: "year" };
async function searchSearXNG(baseUrl, query, max, timeoutMs = 10_000, time, signal, status) {
    const params = { q: query, format: "json" };
    if (time)
        params["time_range"] = SEARXNG_TIME[time] ?? "";
    const url = `${baseUrl.replace(/\/$/, "")}/search?${new URLSearchParams(params)}`;
    report(status, `provider=searxng request url=${url}`);
    const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const res = await fetch(url, { signal: fetchSignal, headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" } });
    if (!res.ok)
        throw new Error(`SearXNG HTTP ${res.status}`);
    const data = await res.json();
    const results = (data.results ?? []).slice(0, max).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
    }));
    report(status, `provider=searxng parsed_results=${results.length}`);
    return results;
}
async function ddgSearch(query, maxResults, time, locale = "en-us", searxngUrl, signal, status) {
    if (searxngUrl) {
        try {
            const r = await searchSearXNG(searxngUrl, query, maxResults, 10_000, time, signal, status);
            if (r.length > 0)
                return r;
            if (time) {
                report(status, "provider=searxng result_count=0 retry_without_time_range=true");
                const retry = await searchSearXNG(searxngUrl, query, maxResults, 10_000, undefined, signal, status);
                if (retry.length > 0) {
                    report(status, `provider=searxng fallback_without_time_range_results=${retry.length}`);
                    return retry;
                }
            }
            report(status, "provider=searxng result_count=0 fallback=duckduckgo");
        }
        catch (error) {
            report(status, `provider=searxng error=${errorMessage(error)} fallback=duckduckgo`);
        }
    }
    else {
        report(status, "provider=searxng skipped reason=not_configured");
    }
    try {
        const results = await scrapeDDG(query, maxResults, time, locale, signal, status);
        if (results.length > 0)
            return results;
        report(status, "provider=duckduckgo result_count=0 fallback=bing");
    }
    catch (error) {
        report(status, `provider=duckduckgo error=${errorMessage(error)} fallback=bing`);
    }
    try {
        const results = await scrapeBing(query, maxResults, time, signal, status);
        if (results.length === 0)
            report(status, "provider=bing result_count=0 fallback=none");
        return results;
    }
    catch (error) {
        report(status, `provider=bing error=${errorMessage(error)} fallback=none`);
        return [];
    }
}
/** Search and then fetch+read the top N pages. Skips URLs already in `fetchedUrls` (dedup). */
async function searchAndRead(query, maxResults, maxPages, timeoutMs, time, locale = "en-us", fetchedUrls, searxngUrl, embeddingsUrl, signal, status) {
    report(status, `query="${query}" max_results=${maxResults} time_window=${time ?? "none"} searxng=${searxngUrl ? "configured" : "not_configured"}`);
    let hits = await ddgSearch(query, maxResults, time, locale, searxngUrl, signal, status);
    report(status, `search_results=${hits.length}`);
    if (embeddingsUrl && hits.length > 1) {
        report(status, `rerank=enabled embeddings_url=${embeddingsUrl}`);
        hits = await (0, rerank_1.rerankHits)(query, hits, embeddingsUrl);
    }
    else {
        report(status, `rerank=skipped reason=${embeddingsUrl ? "not_enough_results" : "not_configured"}`);
    }
    const pages = [];
    for (const h of hits) {
        if (signal?.aborted)
            break;
        // Stop when we have enough successful reads; errors don't fill the slot
        if (pages.filter((p) => !p.error).length >= maxPages)
            break;
        if (fetchedUrls?.has(h.url))
            continue;
        fetchedUrls?.add(h.url);
        report(status, `fetch_page url=${h.url}`);
        const p = await (0, read_1.fetchPage)(h.url, timeoutMs, 8000, signal);
        pages.push(p);
        report(status, p.error ? `fetch_page error=${p.error} url=${h.url}` : `fetch_page ok words=${p.wordCount} url=${h.url}`);
        await (0, utils_1.sleep)(300);
    }
    return { hits, pages };
}

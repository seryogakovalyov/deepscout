"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ddgSearch = ddgSearch;
exports.searchAndRead = searchAndRead;
const read_1 = require("./read");
const rerank_1 = require("./rerank");
const utils_1 = require("./utils");
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
async function scrapeDDG(query, max, time, locale = "en-us", signal) {
    // DDG HTML: kl=locale, df=d|w|m|y for time filter
    const params = new URLSearchParams({ q: query, kl: locale });
    if (time)
        params.set("df", time);
    const html = await fetchSearchHtml(`https://html.duckduckgo.com/html/?${params}`, 10_000, signal);
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
    if (links.length === 0)
        return [];
    const snippets = [];
    const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:div|a)>/g;
    let sm;
    while ((sm = snipRe.exec(html)) !== null)
        snippets.push(stripTagsSearch(sm[1]));
    return links.map((l, i) => ({ ...l, snippet: snippets[i] ?? "" }));
}
// Bing HTML search has no reliable URL-based freshness parameter.
// (tbs=qdr:X is Google's parameter and was silently ignored by Bing.)
// Time filtering is handled by SearXNG and DDG tiers above.
async function scrapeBing(query, max, _time, signal) {
    const html = await fetchSearchHtml(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${max}&setlang=en&cc=us`, 10_000, signal);
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
    return results;
}
// SearXNG time_range values: day | week | month | year
const SEARXNG_TIME = { d: "day", w: "week", m: "month", y: "year" };
async function searchSearXNG(baseUrl, query, max, timeoutMs = 10_000, time, signal) {
    const params = { q: query, format: "json" };
    if (time)
        params["time_range"] = SEARXNG_TIME[time] ?? "";
    const url = `${baseUrl.replace(/\/$/, "")}/search?${new URLSearchParams(params)}`;
    const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const res = await fetch(url, { signal: fetchSignal, headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" } });
    if (!res.ok)
        throw new Error(`SearXNG HTTP ${res.status}`);
    const data = await res.json();
    return (data.results ?? []).slice(0, max).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
    }));
}
async function ddgSearch(query, maxResults, time, locale = "en-us", searxngUrl, signal) {
    if (searxngUrl) {
        try {
            const r = await searchSearXNG(searxngUrl, query, maxResults, 10_000, time, signal);
            if (r.length > 0)
                return r;
        }
        catch { /* fall through */ }
    }
    try {
        const results = await scrapeDDG(query, maxResults, time, locale, signal);
        if (results.length > 0)
            return results;
    }
    catch { /* fall through to Bing */ }
    try {
        return await scrapeBing(query, maxResults, time, signal);
    }
    catch {
        return [];
    }
}
/** Search and then fetch+read the top N pages. Skips URLs already in `fetchedUrls` (dedup). */
async function searchAndRead(query, maxResults, maxPages, timeoutMs, time, locale = "en-us", fetchedUrls, searxngUrl, embeddingsUrl, signal) {
    let hits = await ddgSearch(query, maxResults, time, locale, searxngUrl, signal);
    if (embeddingsUrl && hits.length > 1) {
        hits = await (0, rerank_1.rerankHits)(query, hits, embeddingsUrl);
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
        const p = await (0, read_1.fetchPage)(h.url, timeoutMs, 8000, signal);
        pages.push(p);
        await (0, utils_1.sleep)(300);
    }
    return { hits, pages };
}

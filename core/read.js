"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchPage = fetchPage;
const FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
};
function cleanHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
        .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
        .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
        .replace(/<header[\s\S]*?<\/header>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s{2,}/g, " ")
        .trim();
}
/** Strip HTML to readable plain text. Prefers <article>/<main> content over full-page noise. */
function extractText(html, maxChars = 8000) {
    // Try to pull out just the main article body first — much better signal-to-noise
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
        html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ??
        html.match(/<div[^>]+(?:class|id)="[^"]*(?:content|article|post|entry|story)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const source = articleMatch ? articleMatch[1] : html;
    return cleanHtml(source).slice(0, maxChars);
}
function extractTitle(html) {
    const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    if (m)
        return m[1].trim().replace(/\s+/g, " ");
    // og:title attributes can appear in any order, so match the meta tag then extract content
    const ogTag = html.match(/<meta[^>]+og:title[^>]*>/i);
    if (ogTag) {
        const contentMatch = ogTag[0].match(/content="([^"]{1,200})"/i);
        if (contentMatch)
            return contentMatch[1].trim();
    }
    return "Untitled";
}
async function fetchPage(url, timeoutMs, maxChars = 8000, signal) {
    try {
        const fetchSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs);
        const res = await fetch(url, { signal: fetchSignal, headers: FETCH_HEADERS });
        if (!res.ok) {
            return { url, title: "", text: "", wordCount: 0, error: `HTTP ${res.status}` };
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text")) {
            return { url, title: "", text: "", wordCount: 0, error: `Non-text content: ${contentType}` };
        }
        const html = await res.text();
        const title = extractTitle(html);
        const extracted = extractText(html, maxChars);
        return { url, title, text: extracted, wordCount: extracted.split(/\s+/).length };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { url, title: "", text: "", wordCount: 0, error: msg };
    }
}

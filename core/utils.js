"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.json = json;
exports.sleep = sleep;
exports.truncateAtWord = truncateAtWord;
exports.rootDomain = rootDomain;
exports.publisherDiversityInstruction = publisherDiversityInstruction;
function json(obj) {
    return JSON.stringify(obj, null, 2);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function truncateAtWord(s, max) {
    if (s.length <= max)
        return s;
    const cut = s.lastIndexOf(" ", max);
    return cut > 0 ? s.slice(0, cut) : s.slice(0, max);
}
function rootDomain(url) {
    try {
        const h = new URL(url).hostname.replace(/^www\./, "");
        const parts = h.split(".");
        return parts.length >= 2 ? parts.slice(-2).join(".") : h;
    }
    catch {
        return url;
    }
}
function publisherDiversityInstruction(successUrls) {
    if (successUrls.length === 0) {
        return "No pages successfully read. Do not assert any facts — re-search or inform the user.";
    }
    const domains = new Set(successUrls.map(rootDomain));
    const count = domains.size;
    if (count === 1) {
        return `WARNING: All pages read are from the same publisher (${[...domains][0]}). Every claim here is SINGLE-SOURCE = UNVERIFIED. Call fact_check on key claims, or explicitly label them as unverified before presenting.`;
    }
    return `${count} independent publisher(s) read. For each key claim: check if 2+ of these publishers support it. Single-source claims must be labeled UNVERIFIED.`;
}

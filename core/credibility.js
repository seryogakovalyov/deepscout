"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessDomainCredibility = assessDomainCredibility;
const GOV_DOMAINS = /\.(gov|mil)(\.[\w]+)?$/i;
const EDU_DOMAINS = /\.(edu|ac\.\w{2}|edu\.\w{2})(\.[\w]+)?$/i;
const NEWS_DOMAINS = new Set([
    "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "theguardian.com",
    "nytimes.com", "washingtonpost.com", "economist.com", "ft.com",
    "bloomberg.com", "wsj.com", "npr.org", "aljazeera.com", "theatlantic.com",
    "nature.com", "science.org", "scientificamerican.com", "newscientist.com",
    "technologyreview.com", "arstechnica.com", "wired.com",
]);
const ACADEMIC_DOMAINS = new Set([
    "arxiv.org", "pubmed.ncbi.nlm.nih.gov", "semanticscholar.org",
    "scholar.google.com", "jstor.org", "researchgate.net",
    "ncbi.nlm.nih.gov", "springer.com", "nature.com", "cell.com",
]);
const LOW_CREDIBILITY_SIGNALS = ["blogspot.com", "wordpress.com", "reddit.com",
    "quora.com", "yahoo.com", "medium.com"];
function assessDomainCredibility(url) {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, "");
        const signals = [];
        let type = "website";
        let credibility = "unknown";
        if (GOV_DOMAINS.test(hostname)) {
            type = "government";
            credibility = "high";
            signals.push("government domain");
        }
        else if (EDU_DOMAINS.test(hostname)) {
            type = "academic institution";
            credibility = "high";
            signals.push("educational domain");
        }
        else if (ACADEMIC_DOMAINS.has(hostname)) {
            type = "academic/research";
            credibility = "high";
            signals.push("known academic platform");
        }
        else if (NEWS_DOMAINS.has(hostname)) {
            type = "established news outlet";
            credibility = "high";
            signals.push("established journalism");
        }
        else if (hostname === "wikipedia.org" || hostname.endsWith(".wikipedia.org")) {
            type = "encyclopedia";
            credibility = "medium";
            signals.push("Wikipedia — reliable overview but verify citations for facts");
        }
        else if (LOW_CREDIBILITY_SIGNALS.some((s) => hostname.includes(s))) {
            type = "user-generated content";
            credibility = "low";
            signals.push("user-generated / blog platform — verify claims independently");
        }
        else {
            credibility = "unknown";
            signals.push("unknown publication — check About page, author credentials, citations");
        }
        return { type, credibility, signals };
    }
    catch {
        return { type: "unknown", credibility: "unknown", signals: ["could not parse URL"] };
    }
}

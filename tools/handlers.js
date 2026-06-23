"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createToolHandlers = createToolHandlers;
const search_1 = require("../core/search");
const credibility_1 = require("../core/credibility");
const read_1 = require("../core/read");
const utils_1 = require("../core/utils");
const AMBIGUOUS_TERMS = {
    python: ["programming language", "snake (animal)"],
    java: ["programming language", "island in Indonesia", "coffee"],
    swift: ["programming language", "Taylor Swift", "swift bird"],
    mercury: ["planet", "element", "car brand", "Greek god"],
    bank: ["financial institution", "river bank", "data bank"],
    apple: ["tech company", "fruit"],
    meta: ["Meta (Facebook)", "meta as a concept/adjective"],
    bat: ["cricket/baseball bat", "flying mammal"],
    spring: ["Spring framework (Java)", "season", "water spring"],
    rust: ["Rust programming language", "corrosion"],
    go: ["Go programming language", "board game", "verb"],
    ruby: ["Ruby programming language", "gemstone"],
    crane: ["construction crane", "bird"],
};
function detectAmbiguitySignals(question) {
    const signals = [];
    const lower = question.toLowerCase();
    const words = lower.split(/\s+/);
    if (words.length < 4)
        signals.push("query is very short — likely underspecified");
    for (const [term, meanings] of Object.entries(AMBIGUOUS_TERMS)) {
        if (new RegExp(`\\b${term}\\b`).test(lower)) {
            signals.push(`"${term}" is ambiguous — could mean: ${meanings.join(" or ")}`);
        }
    }
    const timeWords = ["latest", "recent", "current", "now", "today", "new", "best", "top"];
    const hasTimeSensitive = timeWords.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
    const hasTimeContext = /\b(20\d{2}|last (week|month|year)|in \d{4})\b/i.test(question);
    if (hasTimeSensitive && !hasTimeContext) {
        signals.push("time-sensitive terms detected — which time period matters?");
    }
    // "here" omitted — too common a false positive ("here is how it works")
    const locationWords = ["near me", "nearby", "in my area", "around me", "local to"];
    if (locationWords.some((w) => lower.includes(w))) {
        signals.push("location-dependent query — which country/city/region?");
    }
    return signals;
}
function createToolHandlers(config) {
    const searxngRetry = {
        attempts: config.searxngRetryAttempts,
        delayMs: config.searxngRetryDelayMs,
        backoffMultiplier: config.searxngRetryBackoffMultiplier,
    };
    const ddg = (query, max, time, signal, status) => (0, search_1.ddgSearch)(query, max, time, config.locale, config.searxngUrl, signal, status, searxngRetry);
    const sar = (query, max, pages, time, dedup, signal, status) => (0, search_1.searchAndRead)(query, max, pages, config.timeoutMs, time, config.locale, dedup, config.searxngUrl, config.embeddingsUrl, signal, status, searxngRetry);
    return {
        clarify: async ({ question }, ctx) => {
            ctx.status("Analysing query…");
            const signals = detectAmbiguitySignals(question);
            if (signals.length === 0) {
                return (0, utils_1.json)({
                    status: "READY",
                    refined_query: question,
                    instruction: "Question is specific enough. Call the appropriate search tool now using refined_query.",
                });
            }
            return (0, utils_1.json)({
                status: "CLARIFY",
                ambiguity_signals: signals,
                instruction: [
                    "DO NOT search yet.",
                    "Ask the user 1–3 focused questions based on the ambiguity signals above.",
                    "Keep questions short and concrete — one topic per question.",
                    "Only call a search tool after the user answers.",
                ].join(" "),
            });
        },
        search: async ({ query, max_pages_to_read }, ctx) => {
            ctx.status(`Searching: ${query}`);
            const { hits, pages } = await sar(query, config.maxResults, max_pages_to_read, undefined, undefined, ctx.signal, ctx.status);
            const pageDetails = pages.map((p) => ({
                url: p.url,
                title: p.title,
                status: p.error ? `error: ${p.error}` : `read (${p.wordCount} words)`,
                credibility: (0, credibility_1.assessDomainCredibility)(p.url),
                content: p.error ? null : p.text,
            }));
            const snippetOnlyHits = hits.slice(max_pages_to_read).map((h) => ({
                title: h.title,
                url: h.url,
                snippet: h.snippet,
                credibility: (0, credibility_1.assessDomainCredibility)(h.url),
            }));
            const successUrls = pages.filter((p) => !p.error).map((p) => p.url);
            return (0, utils_1.json)({
                query,
                total_results_found: hits.length,
                pages_read: successUrls.length,
                independent_publishers_read: new Set(successUrls.map(utils_1.rootDomain)).size,
                pages_read_content: pageDetails,
                additional_snippets: snippetOnlyHits,
                instruction: (0, utils_1.publisherDiversityInstruction)(successUrls) + " Cite specific sources. Distinguish facts from inferences.",
            });
        },
        fetch_and_read: async ({ url, max_chars }, ctx) => {
            ctx.status(`Fetching: ${url}`);
            const page = await (0, read_1.fetchPage)(url, config.timeoutMs, max_chars, ctx.signal);
            if (page.error) {
                return (0, utils_1.json)({ url, error: page.error, hint: "Try a different URL or use the search tool." });
            }
            const cred = (0, credibility_1.assessDomainCredibility)(url);
            return (0, utils_1.json)({
                url,
                title: page.title,
                word_count: page.wordCount,
                source_credibility: cred,
                content: page.text,
                instruction: "Reason over this content directly. Quote specific passages when citing facts.",
            });
        },
        deep_search: async ({ topic, angles, pages_per_angle }, ctx) => {
            const defaultAngles = [
                `${topic} overview key facts`,
                `${topic} latest research findings`,
                `${topic} criticism problems limitations`,
                `${topic} expert consensus`,
            ];
            const searchAngles = angles.length > 0 ? angles : defaultAngles;
            const results = [];
            ctx.status(`Deep-searching "${topic}" across ${searchAngles.length} angles…`);
            // Dedup: never fetch the same URL twice across angles
            const fetchedUrls = new Set();
            for (const [i, angle] of searchAngles.entries()) {
                ctx.status(`Angle ${i + 1}/${searchAngles.length}: ${angle}`);
                const query = angles.length > 0 ? `${topic} ${angle}` : angle;
                const { hits, pages } = await sar(query, config.maxResults, pages_per_angle, undefined, fetchedUrls, ctx.signal, ctx.status);
                results.push({
                    angle,
                    query,
                    hits: hits.slice(pages_per_angle).map((h) => ({
                        title: h.title, url: h.url, snippet: h.snippet,
                    })),
                    pages: pages.map((p) => ({
                        url: p.url,
                        title: p.title,
                        credibility: (0, credibility_1.assessDomainCredibility)(p.url),
                        content: p.error ? null : p.text,
                        ...(p.error ? { error: p.error } : {}),
                    })),
                });
                await (0, utils_1.sleep)(400);
            }
            return (0, utils_1.json)({
                topic,
                angles_searched: searchAngles.length,
                results,
                instruction: [
                    "Synthesize across ALL angles above. Do NOT just summarize angle 1.",
                    "Surface agreements and disagreements between angles.",
                    "Identify what is well-established vs what is contested.",
                    "Flag any angle where sources were thin or contradicted each other.",
                ].join(" "),
            });
        },
        fact_check: async ({ claim }, ctx) => {
            ctx.status("Fact-checking across 4 search angles…");
            const searches = [
                { angle: "direct", query: claim },
                { angle: "opposing", query: `"${(0, utils_1.truncateAtWord)(claim, 60)}" false wrong debunked myth` },
                { angle: "evidence", query: `evidence research study "${(0, utils_1.truncateAtWord)(claim, 80)}"` },
                { angle: "expert", query: `experts scientists say ${claim.slice(0, 80)}` },
            ];
            const angleResults = [];
            for (const [i, s] of searches.entries()) {
                ctx.status(`Checking angle ${i + 1}/4: ${s.angle}`);
                const { hits, pages } = await sar(s.query, config.maxResults, Math.min(config.maxPages, 2), undefined, undefined, ctx.signal, ctx.status);
                angleResults.push({
                    angle: s.angle,
                    hits: hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })),
                    pages: pages.map((p) => ({
                        url: p.url,
                        title: p.title,
                        credibility: (0, credibility_1.assessDomainCredibility)(p.url),
                        content: p.error ? null : p.text,
                        ...(p.error ? { error: p.error } : {}),
                    })),
                });
                await (0, utils_1.sleep)(350);
            }
            return (0, utils_1.json)({
                claim,
                search_angles: angleResults,
                verdict_guide: {
                    supported: "Multiple independent, credible sources directly confirm the claim.",
                    disputed: "Credible sources exist on both sides — the claim is contested.",
                    unsupported: "No solid evidence found; sources either don't address it or contradict it.",
                    nuanced: "Partially true — accurate in a specific context but misleading as a general statement.",
                    uncertain: "Coverage is thin, very recent, or sources are inconclusive.",
                },
                instruction: [
                    "Analyse ALL four search angles above.",
                    "Count how many HIGH-credibility sources support vs oppose the claim.",
                    "Assign a verdict from the guide.",
                    "Explain the key evidence for your verdict.",
                    "Flag any important context or caveats.",
                ].join(" "),
            });
        },
        verify_statistic: async ({ statistic, context }, ctx) => {
            ctx.status("Verifying statistic across 4 angles…");
            const base = context ? `${statistic} ${context}` : statistic;
            const searches = [
                { angle: "direct", query: base },
                { angle: "primary_source", query: `source study report "${statistic.slice(0, 60)}" original data` },
                { angle: "fact_check", query: `${statistic.slice(0, 80)} true false actual number` },
                { angle: "updated_data", query: `latest ${base} statistics data ${new Date().getFullYear()}` },
            ];
            const results = [];
            for (const [i, s] of searches.entries()) {
                ctx.status(`Verifying angle ${i + 1}/4: ${s.angle}`);
                const { hits, pages } = await sar(s.query, config.maxResults, Math.min(config.maxPages, 2), undefined, undefined, ctx.signal, ctx.status);
                results.push({
                    angle: s.angle,
                    hits: hits.map((h) => ({
                        title: h.title, url: h.url, snippet: h.snippet,
                        credibility: (0, credibility_1.assessDomainCredibility)(h.url),
                    })),
                    pages: pages.map((p) => ({
                        url: p.url,
                        title: p.title,
                        credibility: (0, credibility_1.assessDomainCredibility)(p.url),
                        content: p.error ? null : p.text,
                        ...(p.error ? { error: p.error } : {}),
                    })),
                });
                await (0, utils_1.sleep)(350);
            }
            return (0, utils_1.json)({
                statistic,
                context: context || null,
                search_results: results,
                instruction: [
                    "Look for: (1) the actual number, (2) who published it, (3) the date, (4) the sample/scope.",
                    "Identify the most credible primary source (gov, academic, major research org preferred).",
                    "Note if the number you found differs from the stated statistic.",
                    "Flag if the stat appears to be outdated, misattributed, or out of context.",
                    "Never confirm a statistic without finding a credible source that explicitly states it.",
                ].join(" "),
            });
        },
        find_primary_source: async ({ claim, domain }, ctx) => {
            ctx.status("Tracing claim to primary source…");
            const base = domain ? `${claim} ${domain}` : claim;
            const searches = [
                { angle: "original_study", query: `original study research "${(0, utils_1.truncateAtWord)(claim, 70)}"` },
                { angle: "first_published", query: `first published source "${(0, utils_1.truncateAtWord)(claim, 70)}" journal report` },
                { angle: "official_source", query: `official government organization report ${base}` },
                { angle: "citation_trace", query: `cite source reference ${base} who found` },
            ];
            const results = [];
            for (const [i, s] of searches.entries()) {
                ctx.status(`Source angle ${i + 1}/4: ${s.angle}`);
                const { hits, pages } = await sar(s.query, config.maxResults, 1, undefined, undefined, ctx.signal, ctx.status);
                results.push({
                    angle: s.angle,
                    hits: hits.map((h) => ({
                        title: h.title, url: h.url, snippet: h.snippet,
                        credibility: (0, credibility_1.assessDomainCredibility)(h.url),
                    })),
                    top_page: pages[0]
                        ? {
                            url: pages[0].url,
                            title: pages[0].title,
                            credibility: (0, credibility_1.assessDomainCredibility)(pages[0].url),
                            content: pages[0].error ? null : pages[0].text,
                        }
                        : null,
                });
                await (0, utils_1.sleep)(350);
            }
            return (0, utils_1.json)({
                claim,
                domain: domain || null,
                search_results: results,
                credibility_priority: ["government", "academic institution", "academic/research", "established news outlet"],
                instruction: [
                    "Find the single most authoritative source that originally made this claim.",
                    "Prefer: peer-reviewed journals, government reports, official org publications.",
                    "Avoid: secondary citations (articles that cite the study, not the study itself).",
                    "State the publisher, year, and direct URL if found.",
                    "If no primary source exists, say so clearly — the claim may be fabricated.",
                ].join(" "),
            });
        },
        search_recent: async ({ query, window, read_pages }, ctx) => {
            ctx.status(`Searching (last ${window}): ${query}`);
            const timeMap = { day: "d", week: "w", month: "m", year: "y" };
            const { hits, pages } = await sar(query, config.maxResults, read_pages, timeMap[window], undefined, ctx.signal, ctx.status);
            const successUrls = pages.filter((p) => !p.error).map((p) => p.url);
            return (0, utils_1.json)({
                query,
                window,
                results_found: hits.length,
                independent_publishers_read: new Set(successUrls.map(utils_1.rootDomain)).size,
                results: hits.map((h) => ({
                    title: h.title,
                    url: h.url,
                    snippet: h.snippet,
                    credibility: (0, credibility_1.assessDomainCredibility)(h.url),
                })),
                pages_read: pages.map((p) => ({
                    url: p.url,
                    title: p.title,
                    credibility: (0, credibility_1.assessDomainCredibility)(p.url),
                    content: p.error ? null : p.text,
                    ...(p.error ? { error: p.error } : {}),
                })),
                instruction: (0, utils_1.publisherDiversityInstruction)(successUrls) + " Focus on what is NEW here. Note publication dates when visible in the content. Flag if results are actually older than the requested window.",
            });
        },
        compare_sources: async ({ topic, urls, num_sources }, ctx) => {
            ctx.status(`Comparing sources on: ${topic}`);
            let targetUrls = urls;
            if (targetUrls.length === 0) {
                const hits = await ddg(topic, num_sources * 2, undefined, ctx.signal, ctx.status);
                // Pick sources with varied domains for diversity
                const seen = new Set();
                for (const h of hits) {
                    if (targetUrls.length >= num_sources)
                        break;
                    try {
                        const domain = new URL(h.url).hostname;
                        if (!seen.has(domain)) {
                            seen.add(domain);
                            targetUrls.push(h.url);
                        }
                    }
                    catch { /* skip */ }
                }
            }
            const pages = [];
            for (const url of targetUrls) {
                if (ctx.signal.aborted)
                    break;
                ctx.status(`Reading: ${url}`);
                const p = await (0, read_1.fetchPage)(url, config.timeoutMs, 8000, ctx.signal);
                pages.push({
                    url,
                    title: p.title,
                    credibility: (0, credibility_1.assessDomainCredibility)(url),
                    content: p.error ? null : p.text,
                    ...(p.error ? { error: p.error } : {}),
                });
                await (0, utils_1.sleep)(300);
            }
            return (0, utils_1.json)({
                topic,
                sources_compared: pages.length,
                sources: pages,
                instruction: [
                    "After reading all sources, identify:",
                    "1. AGREEMENTS — facts all sources agree on (high confidence).",
                    "2. CONFLICTS — where sources say different things (flag explicitly).",
                    "3. FRAMING DIFFERENCES — same facts, different emphasis or spin.",
                    "4. UNIQUE CLAIMS — things only one source reports (treat with lower confidence).",
                    "Note the credibility level of each source when weighing disagreements.",
                ].join(" "),
            });
        },
        find_expert_views: async ({ topic, field }, ctx) => {
            ctx.status(`Finding expert views on: ${topic}`);
            const base = field ? `${topic} ${field}` : topic;
            const searches = [
                { angle: "consensus", query: `${base} expert consensus scientists agree research shows` },
                { angle: "research", query: `${base} peer reviewed study findings evidence` },
                { angle: "official", query: `${base} official position WHO CDC government report` },
                { angle: "dissent", query: `${base} experts disagree controversy scientific debate` },
            ];
            const results = [];
            for (const [i, s] of searches.entries()) {
                ctx.status(`Expert angle ${i + 1}/4: ${s.angle}`);
                const { hits, pages } = await sar(s.query, config.maxResults, Math.min(config.maxPages, 2), undefined, undefined, ctx.signal, ctx.status);
                results.push({
                    angle: s.angle,
                    hits: hits.map((h) => ({
                        title: h.title, url: h.url, snippet: h.snippet,
                        credibility: (0, credibility_1.assessDomainCredibility)(h.url),
                    })),
                    top_pages: pages.map((p) => ({
                        url: p.url, title: p.title,
                        credibility: (0, credibility_1.assessDomainCredibility)(p.url),
                        content: p.error ? null : p.text,
                        ...(p.error ? { error: p.error } : {}),
                    })),
                });
                await (0, utils_1.sleep)(400);
            }
            return (0, utils_1.json)({
                topic,
                field: field || null,
                search_results: results,
                instruction: [
                    "Prioritise HIGH-credibility sources (academic, gov, established science outlets).",
                    "Clearly separate: (a) established consensus, (b) areas of active debate, (c) minority/fringe views.",
                    "Quote or paraphrase specific expert statements with attribution.",
                    "If consensus and dissent both exist, explain why — methodological differences, new evidence, etc.",
                ].join(" "),
            });
        },
        search_academic: async ({ topic, source, year_from }, ctx) => {
            ctx.status(`Searching academic sources for: ${topic}`);
            // DuckDuckGo does not support Google's `after:` operator — append year as a term instead
            const yearStr = year_from ? ` ${year_from}` : "";
            const sourceMap = {
                arxiv: [`site:arxiv.org ${topic}${yearStr}`],
                pubmed: [`site:pubmed.ncbi.nlm.nih.gov ${topic}${yearStr}`],
                semantic_scholar: [`site:semanticscholar.org ${topic}${yearStr}`],
                all: [
                    `site:arxiv.org ${topic}${yearStr}`,
                    `site:pubmed.ncbi.nlm.nih.gov ${topic}${yearStr}`,
                    `site:semanticscholar.org ${topic}${yearStr}`,
                ],
            };
            const queries = sourceMap[source] ?? sourceMap.all;
            const allHits = [];
            for (const q of queries) {
                const hits = await ddg(q, config.maxResults, undefined, ctx.signal, ctx.status);
                allHits.push(...hits);
                await (0, utils_1.sleep)(400);
            }
            // Deduplicate by URL
            const seen = new Set();
            const dedupedHits = allHits.filter((h) => {
                if (seen.has(h.url))
                    return false;
                seen.add(h.url);
                return true;
            });
            // Fetch top papers to get abstracts
            const paperPages = [];
            for (const h of dedupedHits.slice(0, Math.min(config.maxPages, 3))) {
                const p = await (0, read_1.fetchPage)(h.url, config.timeoutMs, 4000, ctx.signal);
                paperPages.push(p);
                await (0, utils_1.sleep)(300);
            }
            return (0, utils_1.json)({
                topic,
                source,
                year_from: year_from ?? null,
                papers_found: dedupedHits.length,
                results: dedupedHits.map((h) => ({
                    title: h.title,
                    url: h.url,
                    snippet: h.snippet,
                })),
                paper_content: paperPages.map((p) => ({
                    url: p.url,
                    title: p.title,
                    content: p.error ? null : p.text,
                    ...(p.error ? { error: p.error } : {}),
                })),
                instruction: [
                    "Extract: paper title, authors (if visible), publication year, key findings, methodology.",
                    "Distinguish: (a) preprints (not peer reviewed), (b) peer-reviewed journal papers, (c) review papers.",
                    "Note sample sizes, confidence intervals, and limitations where visible.",
                    "Do not overstate findings — say 'the study found X in Y context' not 'it is proven that X'.",
                ].join(" "),
            });
        },
        research_topic: async ({ topic, depth, focus }, ctx) => {
            const focusStr = focus ? ` (focus: ${focus})` : "";
            const base = focus ? `${topic} ${focus}` : topic;
            const angleTemplates = {
                overview: [
                    `${base} what is overview`,
                    `${base} key facts evidence`,
                    `${base} expert opinion research`,
                ],
                detailed: [
                    `${base} definition background history`,
                    `${base} evidence research studies findings`,
                    `${base} criticism limitations problems`,
                    `${base} expert consensus latest developments`,
                    `${base} practical implications examples`,
                ],
                comprehensive: [
                    `${base} overview definition`,
                    `${base} historical background`,
                    `${base} recent research ${new Date().getFullYear()} studies`,
                    `${base} evidence data statistics`,
                    `${base} criticism counterargument debate`,
                    `${base} expert consensus official position`,
                    `${base} practical applications examples case studies`,
                ],
            };
            const pagesPerAngle = { overview: 2, detailed: 2, comprehensive: 3 };
            const angles = angleTemplates[depth];
            const ppa = pagesPerAngle[depth];
            const sections = [];
            ctx.status(`Researching "${topic}" (${depth}, ${angles.length} angles)…`);
            // Dedup: never fetch the same URL twice across angles
            const fetchedUrls = new Set();
            for (const [i, angle] of angles.entries()) {
                ctx.status(`Research angle ${i + 1}/${angles.length}: ${angle.slice(0, 60)}`);
                const { hits, pages } = await sar(angle, config.maxResults, ppa, undefined, fetchedUrls, ctx.signal, ctx.status);
                sections.push({
                    angle,
                    pages: pages.map((p) => ({
                        url: p.url,
                        title: p.title,
                        credibility: (0, credibility_1.assessDomainCredibility)(p.url),
                        content: p.error ? null : p.text,
                        ...(p.error ? { error: p.error } : {}),
                    })),
                    additional_hits: hits.slice(ppa).map((h) => ({
                        title: h.title, url: h.url, snippet: h.snippet,
                    })),
                });
                await (0, utils_1.sleep)(400);
            }
            return (0, utils_1.json)({
                topic,
                focus: focus || null,
                depth,
                angles_covered: angles.length,
                research_sections: sections,
                instruction: [
                    `Produce a structured research brief on: "${topic}${focusStr}".`,
                    "Structure your answer:",
                    "1. OVERVIEW — what is this, why it matters (2–3 sentences).",
                    "2. KEY ESTABLISHED FACTS — what the evidence clearly shows (cite sources).",
                    "3. CONTESTED AREAS — where sources disagree or evidence is mixed.",
                    "4. EXPERT CONSENSUS — what the mainstream expert view is.",
                    "5. OPEN QUESTIONS — what remains unknown or actively debated.",
                    "6. KEY SOURCES — the 3–5 most credible sources found.",
                    "7. CONFIDENCE ASSESSMENT — overall confidence in the picture (high/medium/low) and why.",
                    "Be direct. Cite sources. Never pad with filler.",
                ].join(" "),
            });
        },
        search_news: async ({ query, window, read_pages }, ctx) => {
            ctx.status(`Searching news (last ${window}): ${query}`);
            const timeMap = { day: "d", week: "w", month: "m", any: undefined };
            const time = timeMap[window];
            // Run two queries: one general news query, one targeting known news sites
            const queries = [
                query,
                `${query} site:reuters.com OR site:apnews.com OR site:bbc.com OR site:theguardian.com OR site:npr.org`,
            ];
            const allHits = [];
            const seenUrls = new Set();
            for (const q of queries) {
                const hits = await ddg(q, config.maxResults, time, ctx.signal, ctx.status);
                for (const h of hits) {
                    if (!seenUrls.has(h.url)) {
                        seenUrls.add(h.url);
                        allHits.push(h);
                    }
                }
                await (0, utils_1.sleep)(350);
            }
            // Precompute credibility once per hit — used for ranking, output, and count
            const hitsWithCred = allHits.map((h) => ({ ...h, cred: (0, credibility_1.assessDomainCredibility)(h.url) }));
            // Rank: high-credibility news sources first
            const ranked = [
                ...hitsWithCred.filter((h) => h.cred.type === "established news outlet"),
                ...hitsWithCred.filter((h) => h.cred.type !== "established news outlet"),
            ];
            // allHits is already deduped by seenUrls — no fetchedUrls Set needed here
            const pages = [];
            for (const h of ranked) {
                if (pages.length >= read_pages)
                    break;
                if (ctx.signal.aborted)
                    break;
                ctx.status(`Reading article: ${h.title.slice(0, 60)}`);
                const p = await (0, read_1.fetchPage)(h.url, config.timeoutMs, 8000, ctx.signal);
                pages.push({
                    url: h.url,
                    title: p.title || h.title,
                    credibility: h.cred,
                    content: p.error ? null : p.text,
                    ...(p.error ? { error: p.error } : {}),
                });
                await (0, utils_1.sleep)(300);
            }
            const successUrls = pages.filter((p) => !p.error).map((p) => p.url);
            return (0, utils_1.json)({
                query,
                window,
                total_results: ranked.length,
                high_credibility_count: ranked.filter((h) => h.cred.credibility === "high").length,
                independent_publishers_read: new Set(successUrls.map(utils_1.rootDomain)).size,
                results: ranked.map((h) => ({
                    title: h.title,
                    url: h.url,
                    snippet: h.snippet,
                    credibility: h.cred,
                })),
                articles_read: pages,
                instruction: (0, utils_1.publisherDiversityInstruction)(successUrls) + " Focus on what the HIGH-credibility news sources report. Note: (1) who is reporting it, (2) what primary sources they cite, (3) what is confirmed vs alleged. Distinguish official statements, named sources, and anonymous sources.",
            });
        },
        check_source: async ({ url }, ctx) => {
            ctx.status(`Assessing source: ${url}`);
            // Normalize to domain
            let domain = url;
            try {
                domain = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
            }
            catch { /* use as-is */ }
            const credibility = (0, credibility_1.assessDomainCredibility)(url.startsWith("http") ? url : `https://${url}`);
            // Search for reputation info about this source
            const reputationSearches = [
                `"${domain}" media bias reliability credibility`,
                `"${domain}" about publication editorial standards`,
            ];
            const repResults = [];
            for (const q of reputationSearches) {
                const hits = await ddg(q, 5, undefined, ctx.signal, ctx.status);
                repResults.push({
                    query: q,
                    hits: hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })),
                });
                await (0, utils_1.sleep)(300);
            }
            // Also fetch the source's About page if we have a full URL
            let aboutPage = { content: null };
            const aboutUrl = url.startsWith("http")
                ? new URL(url).origin + "/about"
                : `https://${domain}/about`;
            const fetched = await (0, read_1.fetchPage)(aboutUrl, Math.min(config.timeoutMs, 5000), 3000, ctx.signal);
            aboutPage = { content: fetched.error ? null : fetched.text };
            return (0, utils_1.json)({
                url,
                domain,
                credibility_assessment: credibility,
                about_page: {
                    url: aboutUrl,
                    content: aboutPage.content,
                },
                reputation_search: repResults,
                red_flags_to_check: [
                    "No named authors or editorial team",
                    "No 'About' page or contact information",
                    "Domain registered recently with no track record",
                    "Known for publishing misleading or sensationalist content",
                    "Listed on media bias databases as unreliable",
                    "Primary revenue from clickbait advertising",
                    "No corrections policy",
                ],
                instruction: [
                    "Give a credibility verdict: HIGH / MEDIUM / LOW / UNKNOWN.",
                    "Explain what you found about this source.",
                    "Note any red flags.",
                    "Say whether it is safe to cite this source for factual claims.",
                ].join(" "),
            });
        },
    };
}

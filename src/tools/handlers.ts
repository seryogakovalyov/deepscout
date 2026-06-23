import type { SearchConfig } from "../core/config";
import { ddgSearch, searchAndRead } from "../core/search";
import { assessDomainCredibility } from "../core/credibility";
import { fetchPage } from "../core/read";
import type { PageResult, SearchHit, SourceCredibility } from "../core/types";
import type { SearchTimeWindow } from "../core/config";
import { json, publisherDiversityInstruction, rootDomain, sleep, truncateAtWord } from "../core/utils";
import type { ToolHandlers } from "./types";

const AMBIGUOUS_TERMS: Record<string, string[]> = {
  python:   ["programming language", "snake (animal)"],
  java:     ["programming language", "island in Indonesia", "coffee"],
  swift:    ["programming language", "Taylor Swift", "swift bird"],
  mercury:  ["planet", "element", "car brand", "Greek god"],
  bank:     ["financial institution", "river bank", "data bank"],
  apple:    ["tech company", "fruit"],
  meta:     ["Meta (Facebook)", "meta as a concept/adjective"],
  bat:      ["cricket/baseball bat", "flying mammal"],
  spring:   ["Spring framework (Java)", "season", "water spring"],
  rust:     ["Rust programming language", "corrosion"],
  go:       ["Go programming language", "board game", "verb"],
  ruby:     ["Ruby programming language", "gemstone"],
  crane:    ["construction crane", "bird"],
};

function currentDateTimePayload(): string {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localDateTime = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(now);

  return json({
    current_date: now.toISOString().slice(0, 10),
    current_time_iso: now.toISOString(),
    local_datetime: localDateTime,
    timezone: timeZone,
    unix_ms: now.getTime(),
    current_fact_policy: {
      date_check_only: true,
      sufficient_to_answer_current_factual_questions: false,
      requires_followup_research_for_current_facts: true,
      recommended_next_tools: ["search_recent", "search_news", "search", "fetch_and_read"],
    },
    instruction: [
      "Use this as the current date/time anchor.",
      "If the user asks about current, latest, recent, or availability/status facts, do not answer from model memory.",
      "This date check is not sufficient evidence for claims about what currently exists, what was released, or what happened recently.",
      "Call search_recent, search_news, search, fetch_and_read, or another appropriate research tool after this date check.",
      "When answering, state dates explicitly and avoid stale timeline claims.",
    ].join(" "),
  });
}

export function __test_aiModelReleaseQueries(query: string): string[] {
  const lower = query.toLowerCase();
  const isAiModelQuery = /\b(ai|llm|model|models|open[- ]?weight|local model|foundation model|release|released|benchmark|instruct|chat model)\b/i.test(lower);
  if (!isAiModelQuery) return [];

  return [
    `${query} site:huggingface.co`,
    `${query} site:github.com`,
    `${query} site:modelscope.cn`,
  ];
}

function credibilityRank(credibility: SourceCredibility): number {
  if (credibility.credibility === "high") return 0;
  if (credibility.credibility === "medium") return 1;
  if (credibility.credibility === "unknown") return 2;
  return 3;
}

export function __test_evidenceConfidence(
  hits: Array<{ credibility: SourceCredibility }>,
  pages: Array<{ credibility: SourceCredibility; content: string | null }>,
): "high" | "medium" | "low" {
  const readablePages = pages.filter((p) => p.content);
  const highReadable = readablePages.filter((p) => p.credibility.credibility === "high").length;
  const mediumReadable = readablePages.filter((p) => p.credibility.credibility === "medium").length;
  const allHitsWeak = hits.length === 0 || hits.every((h) => ["unknown", "low"].includes(h.credibility.credibility));

  if (highReadable >= 2) return "high";
  if (highReadable >= 1 || mediumReadable >= 1 || !allHitsWeak) return "medium";
  return "low";
}

function detectAmbiguitySignals(question: string): string[] {
  const signals: string[] = [];
  const lower = question.toLowerCase();
  const words = lower.split(/\s+/);

  if (words.length < 4) signals.push("query is very short — likely underspecified");

  for (const [term, meanings] of Object.entries(AMBIGUOUS_TERMS)) {
    if (new RegExp(`\\b${term}\\b`).test(lower)) {
      signals.push(`"${term}" is ambiguous — could mean: ${meanings.join(" or ")}`);
    }
  }

  const timeWords = ["latest", "recent", "current", "now", "today", "new", "best", "top"];
  const hasTimeSensitive = timeWords.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
  const hasTimeContext = /\b(20\d{2}|last (week|month|year)|in \d{4})\b/i.test(question);
  if (hasTimeSensitive && !hasTimeContext) {
    signals.push("time-sensitive terms detected — use get_datetime, then search_recent/search_news/search before answering");
  }

  // "here" omitted — too common a false positive ("here is how it works")
  const locationWords = ["near me", "nearby", "in my area", "around me", "local to"];
  if (locationWords.some((w) => lower.includes(w))) {
    signals.push("location-dependent query — which country/city/region?");
  }

  return signals;
}

export function createToolHandlers(config: SearchConfig): ToolHandlers {
  const searxngRetry = {
    attempts: config.searxngRetryAttempts,
    delayMs: config.searxngRetryDelayMs,
    backoffMultiplier: config.searxngRetryBackoffMultiplier,
  };
  const ddg = (query: string, max: number, time?: SearchTimeWindow, signal?: AbortSignal, status?: (text: string) => void) =>
    ddgSearch(query, max, time, config.locale, config.searxngUrl, signal, status, searxngRetry, config.exaApiKey);
  const sar = (query: string, max: number, pages: number, time?: SearchTimeWindow, dedup?: Set<string>, signal?: AbortSignal, status?: (text: string) => void) =>
    searchAndRead(query, max, pages, config.timeoutMs, time, config.locale, dedup, config.searxngUrl, config.embeddingsUrl, signal, status, searxngRetry, config.exaApiKey);

  return {
    get_datetime: async () => {
      return currentDateTimePayload();
    },

    clarify: async ({ question }, ctx) => {
      ctx.status("Analysing query…");
      const signals = detectAmbiguitySignals(question);

      if (signals.length === 0) {
        return json({
          status: "READY",
          refined_query: question,
          instruction: "Question is specific enough. Call the appropriate search tool now using refined_query.",
        });
      }

      return json({
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
        credibility: assessDomainCredibility(p.url),
        content: p.error ? null : p.text,
      }));

      const snippetOnlyHits = hits.slice(max_pages_to_read).map((h) => ({
        title: h.title,
        url: h.url,
        snippet: h.snippet,
        credibility: assessDomainCredibility(h.url),
      }));

      const successUrls = pages.filter((p) => !p.error).map((p) => p.url);

      return json({
        query,
        total_results_found: hits.length,
        pages_read: successUrls.length,
        independent_publishers_read: new Set(successUrls.map(rootDomain)).size,
        pages_read_content: pageDetails,
        additional_snippets: snippetOnlyHits,
        instruction: publisherDiversityInstruction(successUrls) + " Cite specific sources. Distinguish facts from inferences.",
      });
    },

    fetch_and_read: async ({ url, max_chars }, ctx) => {
      ctx.status(`Fetching: ${url}`);
      const page = await fetchPage(url, config.timeoutMs, max_chars, ctx.signal);
      if (page.error) {
        return json({ url, error: page.error, hint: "Try a different URL or use the search tool." });
      }
      const cred = assessDomainCredibility(url);
      return json({
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

      const results: Array<{
        angle: string;
        query: string;
        hits: SearchHit[];
        pages: Array<{ url: string; title: string; credibility: SourceCredibility; content: string | null; error?: string }>;
      }> = [];

      ctx.status(`Deep-searching "${topic}" across ${searchAngles.length} angles…`);
      // Dedup: never fetch the same URL twice across angles
      const fetchedUrls = new Set<string>();

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
            credibility: assessDomainCredibility(p.url),
            content: p.error ? null : p.text,
            ...(p.error ? { error: p.error } : {}),
          })),
        });
        await sleep(400);
      }

      return json({
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
        { angle: "direct",    query: claim },
        { angle: "opposing",  query: `"${truncateAtWord(claim, 60)}" false wrong debunked myth` },
        { angle: "evidence",  query: `evidence research study "${truncateAtWord(claim, 80)}"` },
        { angle: "expert",    query: `experts scientists say ${claim.slice(0, 80)}` },
      ];

      const angleResults: Array<{
        angle: string;
        hits: SearchHit[];
        pages: Array<{ url: string; title: string; credibility: SourceCredibility; content: string | null; error?: string }>;
      }> = [];

      for (const [i, s] of searches.entries()) {
        ctx.status(`Checking angle ${i + 1}/4: ${s.angle}`);
        const { hits, pages } = await sar(s.query, config.maxResults, Math.min(config.maxPages, 2), undefined, undefined, ctx.signal, ctx.status);
        angleResults.push({
          angle: s.angle,
          hits: hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })),
          pages: pages.map((p) => ({
            url: p.url,
            title: p.title,
            credibility: assessDomainCredibility(p.url),
            content: p.error ? null : p.text,
            ...(p.error ? { error: p.error } : {}),
          })),
        });
        await sleep(350);
      }

      return json({
        claim,
        search_angles: angleResults,
        verdict_guide: {
          supported:   "Multiple independent, credible sources directly confirm the claim.",
          disputed:    "Credible sources exist on both sides — the claim is contested.",
          unsupported: "No solid evidence found; sources either don't address it or contradict it.",
          nuanced:     "Partially true — accurate in a specific context but misleading as a general statement.",
          uncertain:   "Coverage is thin, very recent, or sources are inconclusive.",
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
        { angle: "direct",          query: base },
        { angle: "primary_source",  query: `source study report "${statistic.slice(0, 60)}" original data` },
        { angle: "fact_check",      query: `${statistic.slice(0, 80)} true false actual number` },
        { angle: "updated_data",    query: `latest ${base} statistics data ${new Date().getFullYear()}` },
      ];

      const results: Array<{
        angle: string;
        hits: Array<{ title: string; url: string; snippet: string; credibility: SourceCredibility }>;
        pages: Array<{ url: string; title: string; credibility: SourceCredibility; content: string | null; error?: string }>;
      }> = [];

      for (const [i, s] of searches.entries()) {
        ctx.status(`Verifying angle ${i + 1}/4: ${s.angle}`);
        const { hits, pages } = await sar(s.query, config.maxResults, Math.min(config.maxPages, 2), undefined, undefined, ctx.signal, ctx.status);
        results.push({
          angle: s.angle,
          hits: hits.map((h) => ({
            title: h.title, url: h.url, snippet: h.snippet,
            credibility: assessDomainCredibility(h.url),
          })),
          pages: pages.map((p) => ({
            url: p.url,
            title: p.title,
            credibility: assessDomainCredibility(p.url),
            content: p.error ? null : p.text,
            ...(p.error ? { error: p.error } : {}),
          })),
        });
        await sleep(350);
      }

      return json({
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
        { angle: "original_study",   query: `original study research "${truncateAtWord(claim, 70)}"` },
        { angle: "first_published",  query: `first published source "${truncateAtWord(claim, 70)}" journal report` },
        { angle: "official_source",  query: `official government organization report ${base}` },
        { angle: "citation_trace",   query: `cite source reference ${base} who found` },
      ];

      const results: Array<{
        angle: string;
        hits: Array<{ title: string; url: string; snippet: string; credibility: SourceCredibility }>;
        top_page: { url: string; title: string; credibility: SourceCredibility; content: string | null } | null;
      }> = [];

      for (const [i, s] of searches.entries()) {
        ctx.status(`Source angle ${i + 1}/4: ${s.angle}`);
        const { hits, pages } = await sar(s.query, config.maxResults, 1, undefined, undefined, ctx.signal, ctx.status);
        results.push({
          angle: s.angle,
          hits: hits.map((h) => ({
            title: h.title, url: h.url, snippet: h.snippet,
            credibility: assessDomainCredibility(h.url),
          })),
          top_page: pages[0]
            ? {
                url: pages[0].url,
                title: pages[0].title,
                credibility: assessDomainCredibility(pages[0].url),
                content: pages[0].error ? null : pages[0].text,
              }
            : null,
        });
        await sleep(350);
      }

      return json({
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
      const timeMap = { day: "d", week: "w", month: "m", year: "y" } as const;
      const time = timeMap[window];
      const queries = [query, ...__test_aiModelReleaseQueries(query)];
      const allHits: SearchHit[] = [];
      const seenUrls = new Set<string>();

      for (const [i, q] of queries.entries()) {
        ctx.status(i === 0 ? `Recent search: ${q}` : `Official-source search: ${q}`);
        const hits = await ddg(q, config.maxResults, time, ctx.signal, ctx.status);
        for (const h of hits) {
          if (!seenUrls.has(h.url)) {
            seenUrls.add(h.url);
            allHits.push(h);
          }
        }
        await sleep(350);
      }

      const rankedHits = allHits
        .map((h, index) => ({ ...h, index, credibility: assessDomainCredibility(h.url) }))
        .sort((a, b) => credibilityRank(a.credibility) - credibilityRank(b.credibility) || a.index - b.index);

      const pages: Array<{
        url: string;
        title: string;
        credibility: SourceCredibility;
        content: string | null;
        error?: string;
      }> = [];

      for (const h of rankedHits) {
        if (ctx.signal.aborted) break;
        if (pages.filter((p) => p.content).length >= read_pages) break;
        if (pages.length >= Math.max(read_pages * 3, read_pages)) break;
        ctx.status(`Reading recent source: ${h.title.slice(0, 60)}`);
        const p = await fetchPage(h.url, config.timeoutMs, 8000, ctx.signal);
        pages.push({
          url: h.url,
          title: p.title || h.title,
          credibility: h.credibility,
          content: p.error ? null : p.text,
          ...(p.error ? { error: p.error } : {}),
        });
        await sleep(300);
      }

      const successUrls = pages.filter((p) => p.content).map((p) => p.url);
      const confidence = __test_evidenceConfidence(rankedHits, pages);
      const lowConfidenceInstruction = confidence === "low"
        ? " Evidence confidence is LOW because all available sources are unknown/low credibility or unreadable. Do not make definitive claims; label conclusions as unverified and prefer saying what could not be confirmed."
        : "";

      return json({
        query,
        window,
        official_source_strategy: {
          enabled: queries.length > 1,
          queries_used: queries.slice(1),
        },
        results_found: rankedHits.length,
        high_credibility_count: rankedHits.filter((h) => h.credibility.credibility === "high").length,
        confidence,
        independent_publishers_read: new Set(successUrls.map(rootDomain)).size,
        results: rankedHits.map((h) => ({
          title: h.title,
          url: h.url,
          snippet: h.snippet,
          credibility: h.credibility,
        })),
        pages_read: pages,
        instruction: publisherDiversityInstruction(successUrls) + " Focus on what is NEW here. Note publication dates when visible in the content. Flag if results are actually older than the requested window." + lowConfidenceInstruction,
      });
    },

    compare_sources: async ({ topic, urls, num_sources }, ctx) => {
      ctx.status(`Comparing sources on: ${topic}`);
      let targetUrls: string[] = urls;

      if (targetUrls.length === 0) {
        const hits = await ddg(topic, num_sources * 2, undefined, ctx.signal, ctx.status);
        // Pick sources with varied domains for diversity
        const seen = new Set<string>();
        for (const h of hits) {
          if (targetUrls.length >= num_sources) break;
          try {
            const domain = new URL(h.url).hostname;
            if (!seen.has(domain)) { seen.add(domain); targetUrls.push(h.url); }
          } catch { /* skip */ }
        }
      }

      const pages: Array<{
        url: string;
        title: string;
        credibility: SourceCredibility;
        content: string | null;
        error?: string;
      }> = [];

      for (const url of targetUrls) {
        if (ctx.signal.aborted) break;
        ctx.status(`Reading: ${url}`);
        const p = await fetchPage(url, config.timeoutMs, 8000, ctx.signal);
        pages.push({
          url,
          title: p.title,
          credibility: assessDomainCredibility(url),
          content: p.error ? null : p.text,
          ...(p.error ? { error: p.error } : {}),
        });
        await sleep(300);
      }

      return json({
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
        { angle: "consensus",   query: `${base} expert consensus scientists agree research shows` },
        { angle: "research",    query: `${base} peer reviewed study findings evidence` },
        { angle: "official",    query: `${base} official position WHO CDC government report` },
        { angle: "dissent",     query: `${base} experts disagree controversy scientific debate` },
      ];

      const results: Array<{
        angle: string;
        hits: Array<{ title: string; url: string; snippet: string; credibility: SourceCredibility }>;
        top_pages: Array<{ url: string; title: string; credibility: SourceCredibility; content: string | null; error?: string }>;
      }> = [];

      for (const [i, s] of searches.entries()) {
        ctx.status(`Expert angle ${i + 1}/4: ${s.angle}`);
        const { hits, pages } = await sar(s.query, config.maxResults, Math.min(config.maxPages, 2), undefined, undefined, ctx.signal, ctx.status);
        results.push({
          angle: s.angle,
          hits: hits.map((h) => ({
            title: h.title, url: h.url, snippet: h.snippet,
            credibility: assessDomainCredibility(h.url),
          })),
          top_pages: pages.map((p) => ({
            url: p.url, title: p.title,
            credibility: assessDomainCredibility(p.url),
            content: p.error ? null : p.text,
            ...(p.error ? { error: p.error } : {}),
          })),
        });
        await sleep(400);
      }

      return json({
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

      const sourceMap: Record<string, string[]> = {
        arxiv:           [`site:arxiv.org ${topic}${yearStr}`],
        pubmed:          [`site:pubmed.ncbi.nlm.nih.gov ${topic}${yearStr}`],
        semantic_scholar:[`site:semanticscholar.org ${topic}${yearStr}`],
        all: [
          `site:arxiv.org ${topic}${yearStr}`,
          `site:pubmed.ncbi.nlm.nih.gov ${topic}${yearStr}`,
          `site:semanticscholar.org ${topic}${yearStr}`,
        ],
      };

      const queries = sourceMap[source] ?? sourceMap.all;
      const allHits: SearchHit[] = [];

      for (const q of queries) {
        const hits = await ddg(q, config.maxResults, undefined, ctx.signal, ctx.status);
        allHits.push(...hits);
        await sleep(400);
      }

      // Deduplicate by URL
      const seen = new Set<string>();
      const dedupedHits = allHits.filter((h) => {
        if (seen.has(h.url)) return false;
        seen.add(h.url); return true;
      });

      // Fetch top papers to get abstracts
      const paperPages: PageResult[] = [];
      for (const h of dedupedHits.slice(0, Math.min(config.maxPages, 3))) {
        const p = await fetchPage(h.url, config.timeoutMs, 4000, ctx.signal);
        paperPages.push(p);
        await sleep(300);
      }

      return json({
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

      const sections: Array<{
        angle: string;
        pages: Array<{ url: string; title: string; credibility: SourceCredibility; content: string | null; error?: string }>;
        additional_hits: Array<{ title: string; url: string; snippet: string }>;
      }> = [];

      ctx.status(`Researching "${topic}" (${depth}, ${angles.length} angles)…`);
      // Dedup: never fetch the same URL twice across angles
      const fetchedUrls = new Set<string>();

      for (const [i, angle] of angles.entries()) {
        ctx.status(`Research angle ${i + 1}/${angles.length}: ${angle.slice(0, 60)}`);
        const { hits, pages } = await sar(angle, config.maxResults, ppa, undefined, fetchedUrls, ctx.signal, ctx.status);
        sections.push({
          angle,
          pages: pages.map((p) => ({
            url: p.url,
            title: p.title,
            credibility: assessDomainCredibility(p.url),
            content: p.error ? null : p.text,
            ...(p.error ? { error: p.error } : {}),
          })),
          additional_hits: hits.slice(ppa).map((h) => ({
            title: h.title, url: h.url, snippet: h.snippet,
          })),
        });
        await sleep(400);
      }

      return json({
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
      const timeMap = { day: "d", week: "w", month: "m", any: undefined } as const;
      const time = timeMap[window];

      // Run two queries: one general news query, one targeting known news sites
      const queries = [
        query,
        `${query} site:reuters.com OR site:apnews.com OR site:bbc.com OR site:theguardian.com OR site:npr.org`,
      ];

      const allHits: SearchHit[] = [];
      const seenUrls = new Set<string>();

      for (const q of queries) {
        const hits = await ddg(q, config.maxResults, time, ctx.signal, ctx.status);
        for (const h of hits) {
          if (!seenUrls.has(h.url)) { seenUrls.add(h.url); allHits.push(h); }
        }
        await sleep(350);
      }

      // Precompute credibility once per hit — used for ranking, output, and count
      const hitsWithCred = allHits.map((h) => ({ ...h, cred: assessDomainCredibility(h.url) }));

      // Rank: high-credibility news sources first
      const ranked = [
        ...hitsWithCred.filter((h) => h.cred.type === "established news outlet"),
        ...hitsWithCred.filter((h) => h.cred.type !== "established news outlet"),
      ];

      // allHits is already deduped by seenUrls — no fetchedUrls Set needed here
      const pages: Array<{ url: string; title: string; credibility: SourceCredibility; content: string | null; error?: string }> = [];

      for (const h of ranked) {
        if (pages.length >= read_pages) break;
        if (ctx.signal.aborted) break;
        ctx.status(`Reading article: ${h.title.slice(0, 60)}`);
        const p = await fetchPage(h.url, config.timeoutMs, 8000, ctx.signal);
        pages.push({
          url: h.url,
          title: p.title || h.title,
          credibility: h.cred,
          content: p.error ? null : p.text,
          ...(p.error ? { error: p.error } : {}),
        });
        await sleep(300);
      }

      const successUrls = pages.filter((p) => !p.error).map((p) => p.url);

      return json({
        query,
        window,
        total_results: ranked.length,
        high_credibility_count: ranked.filter((h) => h.cred.credibility === "high").length,
        independent_publishers_read: new Set(successUrls.map(rootDomain)).size,
        results: ranked.map((h) => ({
          title: h.title,
          url: h.url,
          snippet: h.snippet,
          credibility: h.cred,
        })),
        articles_read: pages,
        instruction: publisherDiversityInstruction(successUrls) + " Focus on what the HIGH-credibility news sources report. Note: (1) who is reporting it, (2) what primary sources they cite, (3) what is confirmed vs alleged. Distinguish official statements, named sources, and anonymous sources.",
      });
    },

    check_source: async ({ url }, ctx) => {
      ctx.status(`Assessing source: ${url}`);
      // Normalize to domain
      let domain = url;
      try { domain = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, ""); } catch { /* use as-is */ }

      const credibility = assessDomainCredibility(url.startsWith("http") ? url : `https://${url}`);

      // Search for reputation info about this source
      const reputationSearches = [
        `"${domain}" media bias reliability credibility`,
        `"${domain}" about publication editorial standards`,
      ];

      const repResults: Array<{ query: string; hits: Array<{ title: string; url: string; snippet: string }> }> = [];

      for (const q of reputationSearches) {
        const hits = await ddg(q, 5, undefined, ctx.signal, ctx.status);
        repResults.push({
          query: q,
          hits: hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })),
        });
        await sleep(300);
      }

      // Also fetch the source's About page if we have a full URL
      let aboutPage: { content: string | null; error?: string } = { content: null };
      const aboutUrl = url.startsWith("http")
        ? new URL(url).origin + "/about"
        : `https://${domain}/about`;
      const fetched = await fetchPage(aboutUrl, Math.min(config.timeoutMs, 5000), 3000, ctx.signal);
      aboutPage = { content: fetched.error ? null : fetched.text };

      return json({
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

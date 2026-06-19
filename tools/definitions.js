"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolDefinitionList = exports.toolDefinitions = void 0;
const zod_1 = require("zod");
exports.toolDefinitions = {
    clarify: {
        name: "clarify",
        description: `
        Detect ambiguity in the user's question. Call this when the request lacks
        enough detail for a precise search (e.g., missing scope, context, or specifics).

        Two outcomes:
          STATUS: READY    — question is specific enough, search immediately with the refined_query.
          STATUS: CLARIFY  — question is ambiguous or underspecified. Ask the user the listed
                             questions first. Do NOT search until the user answers.

        Skip this tool when the user provides a clear, specific query.
      `,
        parameters: {
            question: zod_1.z.string().describe("The user's question exactly as they asked it."),
        },
    },
    search: {
        name: "search",
        description: `
        The primary research tool. Unlike a basic search engine, this tool:
        • Retrieves search results AND actually reads the top pages (not just snippets)
        • Returns structured facts with source attribution
        • Surfaces the full page text for you to reason over
        • Flags source credibility for each result

        Use for: most questions that need factual answers from the web.
        Prefer deep_search when you need multiple angles or research_topic for comprehensive reports.
      `,
        parameters: {
            query: zod_1.z.string().describe("What you want to find. Be specific — vague queries get vague results."),
            max_pages_to_read: zod_1.z.coerce.number().int().min(1).max(6).default(3)
                .describe("How many pages to actually fetch and read (1=quick, 3=default, 6=thorough)."),
        },
    },
    fetch_and_read: {
        name: "fetch_and_read",
        description: `
        Fetch a specific URL and read its full content. This is the tool that regular
        search CANNOT do — it gives you the actual article text, not a short snippet.

        Use when:
        • The user shares a URL and wants you to read it
        • A search result looks relevant but you need the full text
        • You need the exact wording of a policy, study, or article
        • You want to verify what a source actually says vs what's quoted elsewhere
      `,
        parameters: {
            url: zod_1.z.string().url().describe("The full URL to fetch and read."),
            max_chars: zod_1.z.coerce.number().int().min(1000).max(20000).default(8000)
                .describe("How many characters of text to extract (default 8000, max 20000 for very long pages)."),
        },
    },
    deep_search: {
        name: "deep_search",
        description: `
        Multi-angle research. Runs 3–5 separate searches from different perspectives
        on the same topic, reads pages for each, and returns everything together.

        This defeats single-search bias — you get coverage from different angles,
        not just the top SEO results for one query.

        Angles can be: different framings, pro/con, historical vs current, expert vs critic,
        technical vs practical, etc. Provide your own angles or let the tool pick.

        Use when: you need a complete picture, not just one answer. Complex topics,
        controversies, research questions, anything where one search could miss something important.
      `,
        parameters: {
            topic: zod_1.z.string().describe("The central topic to research deeply."),
            angles: zod_1.z.array(zod_1.z.string()).max(5).default([])
                .describe("Specific search angles (e.g. ['benefits', 'risks', 'recent studies', 'expert criticism']). Leave empty to use default angles."),
            pages_per_angle: zod_1.z.coerce.number().int().min(1).max(3).default(2)
                .describe("Pages to read per search angle (1=faster, 2=default, 3=thorough)."),
        },
    },
    fact_check: {
        name: "fact_check",
        description: `
        Cross-check a specific claim against multiple sources — both supporting
        and opposing. Returns evidence for and against, then a verdict signal.

        Verdict signals:
          supported    — multiple independent sources confirm it
          disputed     — credible sources on both sides
          unsupported  — no solid evidence found for it
          nuanced      — true in some context but misleading as stated
          uncertain    — thin coverage, very recent, or inconclusive

        Use when: someone asserts something as fact and you want to verify it
        before repeating it, or when the user asks "is it true that...".
      `,
        parameters: {
            claim: zod_1.z.string().describe("The specific claim to check, stated clearly and concisely."),
        },
    },
    verify_statistic: {
        name: "verify_statistic",
        description: `
        Verify a specific number, percentage, or statistic and trace it to its
        primary source. Essential because statistics are often:
        • Outdated (cited from a 10-year-old study)
        • Misquoted (the real number is different)
        • Out of context (applies to a subset, not the general claim)
        • Fabricated (no original source exists)

        Returns: primary source candidates, original publisher, date, actual number found.
      `,
        parameters: {
            statistic: zod_1.z.string().describe("The specific stat to verify, e.g. '90% of startups fail in year one'."),
            context: zod_1.z.string().default("").describe("Domain context to narrow the search, e.g. 'venture-backed US tech startups'."),
        },
    },
    find_primary_source: {
        name: "find_primary_source",
        description: `
        Trace a claim back to its original source — the study, report, speech,
        or official document where it was first published. This matters because
        secondary and tertiary sources often distort the original finding.

        Use when: something is widely cited but the original source is unclear,
        or when you want the most authoritative version of a claim.
      `,
        parameters: {
            claim: zod_1.z.string().describe("The claim to trace back to its origin."),
            domain: zod_1.z.string().default("").describe("Domain hint — e.g. 'medical', 'economics', 'climate science'."),
        },
    },
    search_recent: {
        name: "search_recent",
        description: `
        Time-filtered search — only returns results from the specified window.
        Critical for fast-moving topics where older results can be actively misleading.

        Use when: asking about current events, recent developments, new research,
        product releases, policy changes, or anything where recency matters.
      `,
        parameters: {
            query: zod_1.z.string().describe("What to search for."),
            window: zod_1.z.enum(["day", "week", "month", "year"]).default("week")
                .describe("Time window: 'day' (last 24h), 'week', 'month', 'year'."),
            read_pages: zod_1.z.coerce.number().int().min(1).max(4).default(2)
                .describe("How many pages to fetch and read."),
        },
    },
    compare_sources: {
        name: "compare_sources",
        description: `
        Fetch multiple sources on the same topic and surface where they agree,
        where they conflict, and what each source uniquely claims.

        This is the tool for detecting spin, bias, and framing differences.
        The same fact can be framed very differently by different publications.

        Use when: you have multiple URLs to compare, or want to compare coverage
        of an event/topic across different types of sources.
      `,
        parameters: {
            topic: zod_1.z.string().describe("The topic or event to compare sources on."),
            urls: zod_1.z.array(zod_1.z.string().url()).max(5).default([])
                .describe("Specific URLs to compare. Leave empty to search and pick top sources automatically."),
            num_sources: zod_1.z.coerce.number().int().min(2).max(5).default(3)
                .describe("If no URLs given, how many sources to find and compare."),
        },
    },
    find_expert_views: {
        name: "find_expert_views",
        description: `
        Find what domain experts, researchers, and authoritative institutions
        actually say about a topic — not what random websites claim they say.

        Targets: academic papers, official statements, expert interviews,
        research organization reports, professional body guidelines.

        Use when: you need the scientific/expert consensus, not just the popular view.
        Especially useful for health, science, policy, and technical topics.
      `,
        parameters: {
            topic: zod_1.z.string().describe("Topic to find expert views on."),
            field: zod_1.z.string().default("").describe("Relevant field (e.g. 'medicine', 'climate science', 'AI safety', 'economics')."),
        },
    },
    search_academic: {
        name: "search_academic",
        description: `
        Search specifically for academic papers, studies, and research publications.
        Targets: arXiv, Semantic Scholar, PubMed, and major research journals.

        Returns: paper titles, authors, abstracts, publication year, direct links.

        Use when: the question requires scientific evidence, medical guidance,
        technical research, or any topic where peer review matters.
      `,
        parameters: {
            topic: zod_1.z.string().describe("Research topic to search for."),
            source: zod_1.z.enum(["arxiv", "pubmed", "semantic_scholar", "all"]).default("all")
                .describe("Which academic database to search. 'all' searches across multiple."),
            year_from: zod_1.z.coerce.number().int().min(1900).max(2030).optional()
                .describe("Only return papers published from this year onwards."),
        },
    },
    research_topic: {
        name: "research_topic",
        description: `
        Full multi-step research. Runs multiple searches from different angles,
        reads key pages, and assembles everything into a structured research brief.

        Returns a comprehensive evidence base: key facts, source diversity,
        open questions, and confidence map.

        Depth levels:
          overview      — 3 search angles, 1–2 pages each (faster)
          detailed      — 5 angles, 2–3 pages each
          comprehensive — 7 angles, 3 pages each (thorough, takes longer)

        Use when: someone asks a complex question that needs a full picture,
        not a quick answer — and you want to do it properly in one call.
      `,
        parameters: {
            topic: zod_1.z.string().describe("The topic to research thoroughly."),
            depth: zod_1.z.enum(["overview", "detailed", "comprehensive"]).default("detailed")
                .describe("How deep to go. 'comprehensive' fetches many more pages."),
            focus: zod_1.z.string().default("").describe("Optional focus area within the topic (e.g. 'health implications', 'economic impact')."),
        },
    },
    search_news: {
        name: "search_news",
        description: `
        News-specific search. Targets established journalism and press sources,
        not SEO content farms. Returns recent news coverage with publication signals.

        Unlike search_recent (which filters by date), this filters by SOURCE TYPE —
        it actively prefers news outlets over blogs, product pages, and opinion sites.

        Use when: the question is about a current event, breaking news, policy change,
        corporate announcement, or anything where journalistic sourcing matters.
        Pair with search_recent for time-filtered news coverage.
      `,
        parameters: {
            query: zod_1.z.string().describe("News topic or event to search for."),
            window: zod_1.z.enum(["day", "week", "month", "any"]).default("week")
                .describe("Time window for news: 'day', 'week', 'month', or 'any' for no time filter."),
            read_pages: zod_1.z.coerce.number().int().min(1).max(4).default(2)
                .describe("How many articles to actually fetch and read."),
        },
    },
    check_source: {
        name: "check_source",
        description: `
        Assess the credibility and reliability of a URL or domain. Returns:
        • Domain type (government, academic, news, blog, etc.)
        • Known credibility signals from the URL
        • Search results about the publication's reputation
        • Red flags to watch for

        Use when: a source looks unfamiliar, suspicious, or you want to know
        how much weight to give it before citing it.
      `,
        parameters: {
            url: zod_1.z.string().describe("The URL or domain to assess."),
        },
    },
};
exports.toolDefinitionList = Object.values(exports.toolDefinitions);

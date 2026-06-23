# DeepScout

**Research-grade web search with reasoning, source verification, and multi-angle research.**

DeepScout exposes **15 research tools** via MCP (stdio or HTTP) and OpenAI-compatible APIs. It goes beyond search snippets by fetching and reading pages, cross-verifying claims across sources, ranking by semantic relevance, and surfacing credibility signals — all without API keys.

---

## Search Backend Chain

No API keys required. Results flow through a three-tier fallback:

1. **SearXNG** — self-hosted instance (set `SEARXNG_URL`). Fastest, most reliable, full time-filter support.
2. **DuckDuckGo** — HTML scraper (`html.duckduckgo.com/html/`). Falls back automatically if no SearXNG or zero results.
3. **Bing** — final fallback (`www.bing.com/search`). Regex-based extraction from `<li class="b_algo">` blocks.

---

## Semantic Reranking

If `EMBEDDINGS_BASE_URL` points to a running embeddings model (default: llama.cpp `localhost:8000`), search results are reranked by cosine similarity to the query before any pages are fetched. The most semantically relevant pages are read first. Silently falls back to raw search ranking if the model is unavailable.

---

## Publisher Diversity Signal

After fetching pages, DeepScout counts distinct root domains among successful reads and injects a dynamic instruction into the result:

| Publishers read | Instruction to LLM |
|---|---|
| 0 | Do not assert any facts — re-search or inform the user |
| 1 | Hard UNVERIFIED warning — label every claim as unverified |
| 2+ | Report publisher count — flag single-source claims as UNVERIFIED |

This prevents the LLM from repeating a claim as fact based on a single website.

---

## Source Credibility

Every URL gets an automatic credibility assessment based on domain signals:

| Domain Type | Credibility | Examples |
|---|---|---|
| Government | HIGH | `.gov`, `.mil`, WHO, CDC |
| Academic institution | HIGH | `.edu`, `.ac.uk`, universities |
| Academic platforms | HIGH | arXiv, PubMed, Semantic Scholar, JSTOR |
| Established news | HIGH | Reuters, AP, BBC, NYT, Economist, Bloomberg |
| Wikipedia | MEDIUM | Good overview — verify citations |
| User-generated / blogs | LOW | Blogspot, WordPress, Reddit, Quora, Medium |
| Unknown | UNKNOWN | Check About page and author credentials |

---

## Tools

All 15 tools are defined with Zod schemas and exposed via `tools/list`. Each tool's handler lives in `src/tools/handlers.ts`.

### `get_datetime` — Current date/time anchor

Returns the current date and time from the tool runtime.

```
get_datetime()
```

Returns: `current_date`, `current_time_iso`, `local_datetime`, `timezone`, `unix_ms`, `current_fact_policy`, `instruction`.

Use this before answering questions that depend on "today", "now", "current", "latest", recent releases, or current availability. It establishes the date only; current factual claims still require `search_recent`, `search_news`, `search`, or `fetch_and_read`.

### `clarify` — Ambiguity check (always called first)

Detects ambiguous queries and asks focused clarification questions before searching.

```
clarify(question: string)
```

Returns: `status: "READY"` or `"CLARIFY"` with `ambigu_signals` and clarification `instruction`.

Ambiguity signals: short/vague queries, ambiguous terms (python, java, swift, mercury, bank, etc.), time-sensitive terms without context ("latest", "current"), location-dependent queries ("near me").

---

### `search` — Core search with page reading

The main search tool. Fetches and reads the most semantically relevant pages.

```
search(query: string, max_pages_to_read?: number = 3)
```

`max_pages_to_read`: 1–6 (default 3).

Returns: `query`, `total_results_found`, `pages_read` (with `url`, `title`, `status`, `credibility`, `content`), `additional_snippets`, `independent_publishers_read`, dynamic `instruction`.

---

### `fetch_and_read` — Read a specific URL

Fetch any URL and return extracted text content.

```
fetch_and_read(url: string, max_chars?: number = 8000)
```

`max_chars`: 1000–20000 (default 8000).

Returns: `url`, `title`, `word_count`, `source_credibility`, `content`.

---

### `deep_search` — Multi-angle research

Runs 3–5 separate searches from different perspectives on the same topic.

```
deep_search(topic: string, angles?: string[], pages_per_angle?: number = 2)
```

`angles`: max 5 custom search angles (default: overview facts, latest research, criticism/limitations, expert consensus).

Returns: `topic`, `angles_searched`, `results` (each with `angle`, `query`, `hits`, `pages`).

---

### `fact_check` — Verify a specific claim

Cross-checks a claim across four search angles: direct confirmation, debunking, evidence, and expert opinion.

```
fact_check(claim: string)
```

Returns: `claim`, `search_angles` (4 angles with hits and pages), `verdict_guide` (supported/disputed/unsupported/nuanced/uncertain), `instruction`.

---

### `verify_statistic` — Verify a number or percentage

Searches for a stat, its primary source, fact-check results, and updated data.

```
verify_statistic(statistic: string, context?: string = "")
```

Returns: `statistic`, `context`, `search_results` (4 angles), `instruction`.

---

### `find_primary_source` — Trace a claim to its origin

Searches for the original study, report, or document where a claim first appeared.

```
find_primary_source(claim: string, domain?: string = "")
```

Prioritises: peer-reviewed journals, government reports, official publications over secondary citations.

Returns: `claim`, `domain`, `search_results` (4 angles), `credibility_priority`, `instruction`.

---

### `search_recent` — Time-filtered search

Returns results only from the specified time window.

```
search_recent(query: string, window?: "day" | "week" | "month" | "year" = "week", read_pages?: number = 2)
```

Returns: `query`, `window`, `official_source_strategy`, `results_found`, `high_credibility_count`, `confidence`, `independent_publishers_read`, `results`, `pages_read`, `instruction`.

For current AI model/release queries, this tool adds a small neutral source-search set across model registries and code hosts, then reads high-credibility sources first. If all sources are unknown/low credibility, it returns `confidence: "low"` and instructs the model not to make definitive claims.

---

### `compare_sources` — Surface agreements and conflicts

Fetches multiple sources on the same topic and returns them side by side.

```
compare_sources(topic: string, urls?: string[], num_sources?: number = 3)
```

`urls`: max 5 specific URLs to compare. `num_sources`: 2–5 (default 3).

Returns: `topic`, `sources_compared`, `sources` (each with `url`, `title`, `credibility`, `content`), `instruction`.

---

### `find_expert_views` — Expert consensus and dissent

Searches for academic research, official positions, expert interviews, and scientific consensus.

```
find_expert_views(topic: string, field?: string = "")
```

Searches four angles: expert consensus, peer-reviewed research, official institutional positions, active scientific debate.

Returns: `topic`, `field`, `search_results` (4 angles), `instruction`.

---

### `search_academic` — Academic papers only

Searches arXiv, PubMed, and Semantic Scholar.

```
search_academic(topic: string, source?: "arxiv" | "pubmed" | "semantic_scholar" | "all" = "all", year_from?: number)
```

`year_from`: 1900–2030 (optional).

Returns: `topic`, `source`, `year_from`, `papers_found`, `results`, `paper_content`.

---

### `research_topic` — Full multi-step research brief

Runs multiple searches from different angles and produces a structured research brief.

```
research_topic(topic: string, depth?: "overview" | "detailed" | "comprehensive" = "detailed", focus?: string = "")
```

Depths:
- `overview` — 3 angles, 2 pages each
- `detailed` — 5 angles, 2 pages each (default)
- `comprehensive` — 7 angles, 3 pages each

Returns: `topic`, `focus`, `depth`, `angles_covered`, `research_sections` (each with `angle`, `pages`, `additional_hits`), `instruction`.

---

### `search_news` — News-specific search

News-filtered search that ranks established journalism above blogs and content farms. Runs two queries and ranks high-credibility results first.

```
search_news(query: string, window?: "day" | "week" | "month" | "any" = "week", read_pages?: number = 2)
```

Returns: `query`, `window`, `total_results`, `high_credibility_count`, `independent_publishers_read`, `results`, `articles_read`, `instruction`.

---

### `check_source` — Source credibility assessment

Assesses a URL or domain's credibility type, reputation, and red flags.

```
check_source(url: string)
```

Returns: `url`, `domain`, `credibility_assessment`, `about_page`, `reputation_search`, `red_flags_to_check`, `instruction`.

---

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `MAX_SEARCH_RESULTS` | `8` | Results retrieved per query |
| `MAX_PAGES_PER_SEARCH` | `3` | Pages fetched and read per search |
| `FETCH_TIMEOUT_MS` | `8000` | Per-page fetch timeout (ms) |
| `SEARCH_LANGUAGE` | `"en-us"` | Locale/language for results |
| `SEARCH_RECENCY_WINDOW` | — | Optional global time filter: `day` / `week` / `month` / `year`. Leave empty for general search; `search_recent` passes an explicit window. |
| `EXA_API_KEY` | — | Optional Exa API key. When configured, Exa is tried before SearXNG/HTML fallbacks. |
| `SEARXNG_URL` | — | Self-hosted SearXNG instance (recommended) |
| `SEARXNG_RETRY_ATTEMPTS` | `3` | Total SearXNG attempts before falling back |
| `SEARXNG_RETRY_DELAY_MS` | `1500` | Initial delay before retrying an empty/throttled SearXNG response |
| `SEARXNG_RETRY_BACKOFF_MULTIPLIER` | `2` | Multiplier for each subsequent SearXNG retry delay |
| `EMBEDDINGS_BASE_URL` | `http://localhost:8000` | Embeddings model for semantic reranking |
| `MCP_HTTP_HOST` | `"127.0.0.1"` | MCP HTTP server bind address |
| `MCP_HTTP_PORT` | `8787` | MCP HTTP server port |

See `.env.example` for a ready-to-copy template.

---

## Architecture

```
                    MCP Clients               OpenAI
                  (LM Studio, Claude)        Compatible
                        │                        │
          ┌─────────────┼─────────────┐          │
          │             │             │          │
     ┌────┴────┐   ┌────┴────┐  ┌─────┴─────┐    │
     │  Stdio  │   │  HTTP   │  │  ToolLoop │    │
     │  Server │   │ :8787   │  │  (OpenAI  │◄───┘
     │         │   │         │  │  Adapter) │
     └────┬────┘   └────┬────┘  └────┬──────┘
          │             │            │
          └─────────────┴────────────┘
                        │
              executeToolCall()
             (provider-agnostic)
                        │
              ┌─────────┼───────────┐
              │         │           │
         ┌────┴────┐ ┌──┴───┐ ┌─────┴──────┐
         │   15    │ │Config│ │   Core     │
         │  Tools  │ │& Env │ │  Engines   │
         │Handlers │ │      │ │            │
         └─────────┘ └──────┘ └─────┬──────┘
                                    │
                       ┌────────────┼────────────┐
                       │            │            │
                  ┌────┴─────┐ ┌────┴───┐ ┌──────┴────┐
                  │Credibili │ │ Rerank │ │  Search   │
                  │Assessment│ │ (emb.) │ │ Backends  │
                  └──────────┘ └────────┘ └────┬──────┘
                                               │
                                   ┌───────────┼────────┐
                                   │           │        │   
                              ┌────┴────┐ ┌────┴──┐ ┌───┴───┐
                              │ SearXNG │ │  DDG  │ │ Bing  │
                              └─────────┘ └───────┘ └───────┘
```

### Key design decisions

- **Provider-agnostic core** — all search, reading, credibility, and reranking logic lives in `src/core/`. The provider layer (`src/providers/openai/`, `src/providers/mcp/`) wraps the core with its specific protocol.
- **No external API keys** — all three search backends scrape HTML. SearXNG is recommended for reliability.
- **AbortSignal propagation** — every async operation (search, fetch, embeddings) supports cancellation via `AbortSignal`.
- **Zod schema-driven tools** — all tool definitions use Zod schemas for both runtime validation and JSON Schema generation.

---

## Installation

```bash
npm install
npm run build
```

Requires Node.js 20+ (ES2022 target).

---

## Running

### MCP via stdio (LM Studio, Claude Desktop, etc.)

```bash
npm run mcp:stdio
```

### MCP via HTTP

```bash
npm run mcp:http
# Health check: curl http://localhost:8787/health
```

### OpenAI-compatible tool loop (with a local LLM)

```bash
# Run smoke test against llama.cpp / LM Studio
npm run smoke:llamacpp
```

The tool loop limits search/research fan-out to one search-class tool call per assistant turn by default. Extra same-turn search calls receive a controlled tool error, so the model must continue iteratively instead of flooding SearXNG/upstream engines.

---

## Example Queries

| Query type | Command flow |
|---|---|
| Simple fact | `clarify` (READY) → `search("What is the Dunning-Kruger effect?")` |
| Ambiguous query | `clarify("Tell me about python")` (CLARIFY) → `search("What is Python 3.13?")` |
| Verify a claim | `clarify` (READY) → `fact_check("Humans only use 10% of their brains")` |
| Verify a statistic | `clarify` (READY) → `verify_statistic("50,000 species go extinct per year", "global biodiversity")` |
| Recent news | `clarify` (READY) → `search_recent("What has happened with GPT-5 this week?", window: "week")` |
| Compare sources | `clarify` (READY) → `compare_sources("Are seed oils bad for your health?", num_sources: 4)` |
| Academic research | `clarify` (READY) → `search_academic("Does quantum error correction work in practice?", source: "arxiv", year_from: 2022)` |
| Deep research | `clarify` (READY) → `research_topic("Give me a thorough research brief on intermittent fasting", depth: "comprehensive")` |
| Check source | `clarify` (READY) → `check_source("naturalhealth365.com")` |

---

## Reasoning System

The tools return structured JSON that the LLM interprets using five non-negotiable rules:

1. **Single-source rule** — a claim from one source only is labeled "unverified"
2. **Conflict rule** — when sources disagree, surface the disagreement rather than picking a side
3. **Statistics rule** — every number must cite who published it, when, and the sample
4. **AI/ML/tech rule** — vendor blogs, press releases, and LinkedIn posts are not evidence of capability claims
5. **Wire service rule** — multiple outlets reporting the same wire story does not count as independent verification

### Confidence labels

| Label | Criteria |
|---|---|
| **HIGH** | 2+ independent publishers agree AND at least one is a primary source (.gov, .edu, peer-reviewed) |
| **MEDIUM** | 2+ sources agree but no primary source, OR 1 high-credibility primary source alone |
| **LOW** | Only 1 source found, OR all sources from the same publisher or wire service |
| **UNVERIFIED** | Claim was found but no corroboration exists |
| **UNCERTAIN** | Sources conflict, coverage is thin, or claim is under 2 weeks old |

---

## License

MIT

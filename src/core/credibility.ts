import type { SourceCredibility } from "./types";

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

function isAiModelRegistryOrProjectSource(hostname: string, pathname: string): boolean {
  if ([
    "huggingface.co",
    "github.com",
    "modelscope.cn",
    "arxiv.org",
    "paperswithcode.com",
  ].includes(hostname)) {
    return true;
  }

  const normalizedPath = pathname.toLowerCase();
  if ([
    "ai.google.dev",
    "developers.googleblog.com",
    "blog.google",
    "googleblog.com",
    "openai.com",
    "anthropic.com",
    "mistral.ai",
    "ai.meta.com",
    "deepmind.google",
    "cohere.com",
  ].includes(hostname)) {
    return /ai|model|llm|release|research|developer|docs|blog|news/i.test(normalizedPath);
  }

  return false;
}

export function assessDomainCredibility(url: string): SourceCredibility {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, "");
    const pathname = parsed.pathname;
    const signals: string[] = [];
    let type = "website";
    let credibility: "high" | "medium" | "low" | "unknown" = "unknown";

    if (isAiModelRegistryOrProjectSource(hostname, pathname)) {
      type = "AI model registry/project source"; credibility = "high"; signals.push("known AI model registry, code host, research, or vendor source");
    } else if (GOV_DOMAINS.test(hostname)) {
      type = "government"; credibility = "high"; signals.push("government domain");
    } else if (EDU_DOMAINS.test(hostname)) {
      type = "academic institution"; credibility = "high"; signals.push("educational domain");
    } else if (ACADEMIC_DOMAINS.has(hostname)) {
      type = "academic/research"; credibility = "high"; signals.push("known academic platform");
    } else if (NEWS_DOMAINS.has(hostname)) {
      type = "established news outlet"; credibility = "high"; signals.push("established journalism");
    } else if (hostname === "wikipedia.org" || hostname.endsWith(".wikipedia.org")) {
      type = "encyclopedia"; credibility = "medium";
      signals.push("Wikipedia — reliable overview but verify citations for facts");
    } else if (LOW_CREDIBILITY_SIGNALS.some((s) => hostname.includes(s))) {
      type = "user-generated content"; credibility = "low";
      signals.push("user-generated / blog platform — verify claims independently");
    } else {
      credibility = "unknown";
      signals.push("unknown publication — check About page, author credentials, citations");
    }

    return { type, credibility, signals };
  } catch {
    return { type: "unknown", credibility: "unknown", signals: ["could not parse URL"] };
  }
}

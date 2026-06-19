// Re-export from core/config for backwards compatibility
export type { SearchTimeWindow } from "./config";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface PageResult {
  url: string;
  title: string;
  text: string;
  wordCount: number;
  error?: string;
}

export type SourceCredibility = {
  type: string;
  credibility: "high" | "medium" | "low" | "unknown";
  signals: string[];
};

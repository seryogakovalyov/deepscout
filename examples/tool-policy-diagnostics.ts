const {
  __test_aiModelReleaseQueries,
  __test_evidenceConfidence,
} = require("../tools/handlers");

function credibility(level: "high" | "medium" | "low" | "unknown") {
  return { type: "diagnostic", credibility: level, signals: [] };
}

function printQueries(query: string): void {
  const expanded = __test_aiModelReleaseQueries(query);
  console.log(`query: ${query}`);
  console.log(`extra_queries_count: ${expanded.length}`);
  for (const item of expanded) console.log(`- ${item}`);
  console.log("");
}

function main(): void {
  console.log("=== AI MODEL QUERY FAN-OUT ===");
  printQueries("current open-weight LLM model releases 2026");
  printQueries("latest Ukraine peace talks");

  console.log("=== EVIDENCE CONFIDENCE ===");
  console.log(`weak_sources: ${__test_evidenceConfidence(
    [{ credibility: credibility("unknown") }, { credibility: credibility("low") }],
    [{ credibility: credibility("unknown"), content: "text" }],
  )}`);
  console.log(`one_high_source: ${__test_evidenceConfidence(
    [{ credibility: credibility("high") }],
    [{ credibility: credibility("high"), content: "official model card" }],
  )}`);
  console.log(`two_high_sources: ${__test_evidenceConfidence(
    [{ credibility: credibility("high") }],
    [
      { credibility: credibility("high"), content: "official model card" },
      { credibility: credibility("high"), content: "release notes" },
    ],
  )}`);
}

main();

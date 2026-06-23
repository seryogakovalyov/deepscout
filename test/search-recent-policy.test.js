const test = require("node:test");
const assert = require("node:assert/strict");

const {
  __test_aiModelReleaseQueries,
  __test_evidenceConfidence,
} = require("../tools/handlers");

function credibility(level) {
  return { type: "test", credibility: level, signals: [] };
}

test("AI model release query expansion stays provider-neutral and bounded", () => {
  const queries = __test_aiModelReleaseQueries("current open-weight LLM model releases 2026");

  assert.deepEqual(queries, [
    "current open-weight LLM model releases 2026 site:huggingface.co",
    "current open-weight LLM model releases 2026 site:github.com",
    "current open-weight LLM model releases 2026 site:modelscope.cn",
  ]);
  assert.ok(queries.length <= 3);
  assert.ok(queries.every((query) => !/gemma|qwen/i.test(query)));
});

test("AI model release query expansion skips non-model topics", () => {
  assert.deepEqual(__test_aiModelReleaseQueries("latest Ukraine peace talks"), []);
});

test("evidence confidence is low when all evidence is weak or unreadable", () => {
  const confidence = __test_evidenceConfidence(
    [
      { credibility: credibility("unknown") },
      { credibility: credibility("low") },
    ],
    [
      { credibility: credibility("unknown"), content: "text" },
      { credibility: credibility("low"), content: null },
    ],
  );

  assert.equal(confidence, "low");
});

test("evidence confidence rises with readable high-credibility sources", () => {
  assert.equal(__test_evidenceConfidence(
    [{ credibility: credibility("high") }],
    [{ credibility: credibility("high"), content: "official model card" }],
  ), "medium");

  assert.equal(__test_evidenceConfidence(
    [{ credibility: credibility("high") }],
    [
      { credibility: credibility("high"), content: "official model card" },
      { credibility: credibility("high"), content: "release notes" },
    ],
  ), "high");
});

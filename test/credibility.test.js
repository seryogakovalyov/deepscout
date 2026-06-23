const test = require("node:test");
const assert = require("node:assert/strict");

const { assessDomainCredibility } = require("../core/credibility");

test("assessDomainCredibility recognizes AI model registry and project sources", () => {
  for (const url of [
    "https://huggingface.co/bigscience/bloom",
    "https://github.com/huggingface/transformers",
    "https://modelscope.cn/models/Qwen/Qwen2.5-7B-Instruct",
    "https://arxiv.org/abs/1706.03762",
    "https://paperswithcode.com/paper/attention-is-all-you-need",
    "https://ai.google.dev/gemma/docs",
    "https://openai.com/research/gpt-4",
    "https://mistral.ai/news/la-plateforme",
  ]) {
    const credibility = assessDomainCredibility(url);
    assert.equal(credibility.type, "AI model registry/project source", url);
    assert.equal(credibility.credibility, "high", url);
  }
});

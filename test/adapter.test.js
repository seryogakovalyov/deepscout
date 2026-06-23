const test = require("node:test");
const assert = require("node:assert/strict");

const { exportTools, executeToolCall } = require("../providers/openai");
const { createRuntimeConfig } = require("../providers/shared/runtimeConfig");

function getTool(name) {
  const tool = exportTools().find((item) => item.function.name === name);
  assert.ok(tool, `Expected tool ${name} to be exported`);
  return tool;
}

test("exportTools returns unique OpenAI-compatible tool definitions", () => {
  const tools = exportTools();
  assert.equal(tools.length, 15);

  const names = tools.map((item) => item.function.name);
  assert.equal(new Set(names).size, names.length);

  for (const tool of tools) {
    assert.equal(tool.type, "function");
    assert.equal(typeof tool.function.name, "string");
    assert.equal(typeof tool.function.description, "string");
    assert.equal(tool.function.parameters.type, "object");
    assert.equal(tool.function.parameters.additionalProperties, false);
  }

  for (const requiredName of ["get_datetime", "search", "fetch_and_read", "fact_check", "check_source"]) {
    assert.ok(names.includes(requiredName), `Missing ${requiredName}`);
  }
});

test("schema conversion preserves key field constraints", () => {
  const search = getTool("search").function.parameters;
  assert.equal(search.properties.max_pages_to_read.type, "integer");
  assert.equal(search.properties.max_pages_to_read.minimum, 1);
  assert.equal(search.properties.max_pages_to_read.maximum, 6);
  assert.equal(search.properties.max_pages_to_read.default, 3);
  assert.deepEqual(search.required, ["query"]);

  const fetchAndRead = getTool("fetch_and_read").function.parameters;
  assert.equal(fetchAndRead.properties.url.type, "string");
  assert.equal(fetchAndRead.properties.url.format, "uri");
  assert.deepEqual(fetchAndRead.required, ["url"]);

  const searchRecent = getTool("search_recent").function.parameters;
  assert.deepEqual(searchRecent.properties.window.enum, ["day", "week", "month", "year"]);
  assert.deepEqual(searchRecent.required, ["query"]);

  const searchNews = getTool("search_news").function.parameters;
  assert.deepEqual(searchNews.properties.window.enum, ["day", "week", "month", "any"]);
  assert.deepEqual(searchNews.required, ["query"]);

  const getDatetime = getTool("get_datetime").function.parameters;
  assert.deepEqual(getDatetime.required, []);
  assert.deepEqual(getDatetime.properties, {});
});

test("executeToolCall executes get_datetime with explicit current date guidance", async () => {
  const result = await executeToolCall({
    name: "get_datetime",
    arguments: {},
  });
  const parsed = JSON.parse(result);
  assert.match(parsed.current_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof parsed.current_time_iso, "string");
  assert.equal(typeof parsed.timezone, "string");
  assert.equal(parsed.current_fact_policy.sufficient_to_answer_current_factual_questions, false);
  assert.equal(parsed.current_fact_policy.requires_followup_research_for_current_facts, true);
  assert.ok(parsed.current_fact_policy.recommended_next_tools.includes("search_recent"));
  assert.match(parsed.instruction, /do not answer from model memory/i);
});

test("executeToolCall executes clarify with OpenAI-style tool call shape", async () => {
  const result = await executeToolCall({
    function: {
      name: "clarify",
      arguments: JSON.stringify({ question: "python" }),
    },
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.status, "CLARIFY");
  assert.ok(Array.isArray(parsed.ambiguity_signals));
});

test("executeToolCall executes clarify with direct tool call shape", async () => {
  const result = await executeToolCall({
    name: "clarify",
    arguments: { question: "What is llama.cpp server architecture?" },
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.status, "READY");
});

test("executeToolCall returns tool_error for unknown tool", async () => {
  const result = await executeToolCall({
    name: "not_a_tool",
    arguments: {},
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.tool_error, true);
  assert.equal(parsed.tool, "not_a_tool");
  assert.match(parsed.error, /Unknown tool/);
});

test("executeToolCall returns tool_error for malformed JSON arguments", async () => {
  const result = await executeToolCall({
    function: {
      name: "clarify",
      arguments: "{bad json",
    },
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.tool_error, true);
  assert.equal(parsed.tool, "clarify");
});

test("executeToolCall returns cancelled when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await executeToolCall({
    name: "clarify",
    arguments: { question: "What is llama.cpp?" },
  }, {
    signal: controller.signal,
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.tool_error, true);
  assert.equal(parsed.tool, "clarify");
  assert.equal(parsed.error, "cancelled");
});

test("createRuntimeConfig reads search provider settings from env", () => {
  const previous = {
    exaApiKey: process.env.EXA_API_KEY,
    searxngUrl: process.env.SEARXNG_URL,
    attempts: process.env.SEARXNG_RETRY_ATTEMPTS,
    delay: process.env.SEARXNG_RETRY_DELAY_MS,
    backoff: process.env.SEARXNG_RETRY_BACKOFF_MULTIPLIER,
  };
  process.env.EXA_API_KEY = "test-exa-key";
  process.env.SEARXNG_URL = "http://localhost:8080";
  process.env.SEARXNG_RETRY_ATTEMPTS = "4";
  process.env.SEARXNG_RETRY_DELAY_MS = "2500";
  process.env.SEARXNG_RETRY_BACKOFF_MULTIPLIER = "1.5";
  try {
    const config = createRuntimeConfig();
    assert.equal(config.exaApiKey, "test-exa-key");
    assert.equal(config.searxngUrl, "http://localhost:8080");
    assert.equal(config.searxngRetryAttempts, 4);
    assert.equal(config.searxngRetryDelayMs, 2500);
    assert.equal(config.searxngRetryBackoffMultiplier, 1.5);
  } finally {
    if (previous.exaApiKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = previous.exaApiKey;
    if (previous.searxngUrl === undefined) delete process.env.SEARXNG_URL;
    else process.env.SEARXNG_URL = previous.searxngUrl;
    if (previous.attempts === undefined) delete process.env.SEARXNG_RETRY_ATTEMPTS;
    else process.env.SEARXNG_RETRY_ATTEMPTS = previous.attempts;
    if (previous.delay === undefined) delete process.env.SEARXNG_RETRY_DELAY_MS;
    else process.env.SEARXNG_RETRY_DELAY_MS = previous.delay;
    if (previous.backoff === undefined) delete process.env.SEARXNG_RETRY_BACKOFF_MULTIPLIER;
    else process.env.SEARXNG_RETRY_BACKOFF_MULTIPLIER = previous.backoff;
  }
});

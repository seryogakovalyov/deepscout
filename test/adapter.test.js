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
  assert.equal(tools.length, 14);

  const names = tools.map((item) => item.function.name);
  assert.equal(new Set(names).size, names.length);

  for (const tool of tools) {
    assert.equal(tool.type, "function");
    assert.equal(typeof tool.function.name, "string");
    assert.equal(typeof tool.function.description, "string");
    assert.equal(tool.function.parameters.type, "object");
    assert.equal(tool.function.parameters.additionalProperties, false);
  }

  for (const requiredName of ["search", "fetch_and_read", "fact_check", "check_source"]) {
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
  const previous = process.env.SEARXNG_URL;
  process.env.SEARXNG_URL = "http://localhost:8080";
  try {
    const config = createRuntimeConfig();
    assert.equal(config.searxngUrl, "http://localhost:8080");
  } finally {
    if (previous === undefined) delete process.env.SEARXNG_URL;
    else process.env.SEARXNG_URL = previous;
  }
});

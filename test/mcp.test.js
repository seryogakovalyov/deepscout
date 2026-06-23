const test = require("node:test");
const assert = require("node:assert/strict");

const { exportMcpTools, handleMcpRequest } = require("../providers/mcp/server");

test("exportMcpTools maps tools to MCP inputSchema shape", () => {
  const tools = exportMcpTools();
  assert.equal(tools.length, 15);

  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  assert.equal(typeof search.description, "string");
  assert.equal(search.inputSchema.type, "object");
  assert.equal(search.inputSchema.properties.query.type, "string");
});

test("handleMcpRequest responds to initialize", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2024-11-05");
  assert.equal(response.result.serverInfo.name, "web-search");
  assert.ok(response.result.capabilities.tools);
});

test("handleMcpRequest responds to tools/list", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: "tools",
    method: "tools/list",
  });

  assert.equal(response.id, "tools");
  assert.equal(response.result.tools.length, 15);
  assert.ok(response.result.tools.some((tool) => tool.name === "get_datetime"));
  assert.ok(response.result.tools.some((tool) => tool.name === "clarify"));
});

test("handleMcpRequest executes tools/call", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: "call",
    method: "tools/call",
    params: {
      name: "clarify",
      arguments: { question: "python" },
    },
  });

  assert.equal(response.id, "call");
  assert.equal(response.result.isError, false);
  assert.equal(response.result.content[0].type, "text");
  const parsed = JSON.parse(response.result.content[0].text);
  assert.equal(parsed.status, "CLARIFY");
});

test("handleMcpRequest marks tool errors as MCP isError", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: "bad-call",
    method: "tools/call",
    params: {
      name: "missing_tool",
      arguments: {},
    },
  });

  assert.equal(response.result.isError, true);
  const parsed = JSON.parse(response.result.content[0].text);
  assert.equal(parsed.tool_error, true);
});

test("handleMcpRequest returns method-not-found error", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: "missing",
    method: "missing/method",
  });

  assert.equal(response.error.code, -32601);
});

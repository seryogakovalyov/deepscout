const test = require("node:test");
const assert = require("node:assert/strict");

const { runToolLoop } = require("../providers/openai/toolLoop");

const tools = [
  {
    type: "function",
    function: {
      name: "clarify",
      description: "test",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

function toolCall(name, args, id = `${name}-1`) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

test("runToolLoop stops on assistant response without tool_calls", async () => {
  const seenTools = [];
  const result = await runToolLoop({
    messages: [{ role: "user", content: "hello" }],
    tools,
    chat: async (_messages, passedTools) => {
      seenTools.push(passedTools);
      return { role: "assistant", content: "done" };
    },
    executeToolCall: async () => "{}",
  });

  assert.equal(result.completedNormally, true);
  assert.equal(result.iterationsUsed, 1);
  assert.deepEqual(result.calledTools, []);
  assert.equal(result.finalAssistantResponse.content, "done");
  assert.equal(seenTools.length, 1);
  assert.equal(seenTools[0], tools);
});

test("runToolLoop supports Model -> Tool -> Model -> Tool -> Model", async () => {
  const seenTools = [];
  const responses = [
    { role: "assistant", content: null, tool_calls: [toolCall("clarify", { question: "python" }, "call-1")] },
    { role: "assistant", content: null, tool_calls: [toolCall("search", { query: "llama.cpp" }, "call-2")] },
    { role: "assistant", content: "final answer" },
  ];
  const executed = [];

  const result = await runToolLoop({
    messages: [{ role: "user", content: "hello" }],
    tools,
    chat: async (_messages, passedTools) => {
      seenTools.push(passedTools);
      return responses.shift();
    },
    executeToolCall: async (call) => {
      executed.push(call.function.name);
      return JSON.stringify({ ok: true, tool: call.function.name });
    },
  });

  assert.equal(result.completedNormally, true);
  assert.equal(result.iterationsUsed, 3);
  assert.deepEqual(result.calledTools, ["clarify", "search"]);
  assert.deepEqual(executed, ["clarify", "search"]);
  assert.equal(result.toolResults.length, 2);
  assert.equal(result.finalAssistantResponse.content, "final answer");
  assert.equal(seenTools.length, 3);
  assert.ok(seenTools.every((item) => item === tools));
});

test("runToolLoop stops when maxIterations is reached", async () => {
  let count = 0;
  const result = await runToolLoop({
    messages: [{ role: "user", content: "loop" }],
    tools,
    maxIterations: 2,
    chat: async () => {
      count += 1;
      return {
        role: "assistant",
        content: null,
        tool_calls: [toolCall("clarify", { question: `q${count}` }, `call-${count}`)],
      };
    },
    executeToolCall: async () => "{}",
  });

  assert.equal(result.completedNormally, false);
  assert.equal(result.iterationsUsed, 2);
  assert.equal(result.abortedReason, "max_iterations reached (2)");
  assert.deepEqual(result.calledTools, ["clarify", "clarify"]);
});

test("runToolLoop aborts safely on repeated identical tool calls", async () => {
  const repeated = toolCall("clarify", { question: "python" }, "call-1");
  const result = await runToolLoop({
    messages: [{ role: "user", content: "loop" }],
    tools,
    maxIterations: 10,
    chat: async () => ({
      role: "assistant",
      content: null,
      tool_calls: [repeated],
    }),
    executeToolCall: async () => "{}",
  });

  assert.equal(result.completedNormally, false);
  assert.equal(result.iterationsUsed, 2);
  assert.match(result.abortedReason, /repeated identical tool call detected/);
  assert.deepEqual(result.calledTools, ["clarify"]);
  assert.equal(result.toolResults.length, 1);
});

test("runToolLoop emits tool call and result events", async () => {
  const events = [];
  const result = await runToolLoop({
    messages: [{ role: "user", content: "hello" }],
    tools,
    chat: async (messages) => {
      if (messages.some((message) => message.role === "tool")) {
        return { role: "assistant", content: "done" };
      }
      return { role: "assistant", content: null, tool_calls: [toolCall("clarify", { question: "python" })] };
    },
    executeToolCall: async () => JSON.stringify({ ok: true }),
    onEvent: (event) => events.push(event.type),
  });

  assert.equal(result.completedNormally, true);
  assert.deepEqual(events, ["assistant_message", "tool_call", "tool_result", "assistant_message"]);
});

test("runToolLoop limits search tool fan-out per assistant turn", async () => {
  const executed = [];
  const events = [];
  const result = await runToolLoop({
    messages: [{ role: "user", content: "research current models" }],
    tools,
    chat: async (messages) => {
      if (messages.some((message) => message.role === "tool")) {
        return { role: "assistant", content: "done" };
      }
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          toolCall("search_recent", { query: "open weight models" }, "search-1"),
          toolCall("search", { query: "model releases" }, "search-2"),
          toolCall("search_news", { query: "AI model news" }, "search-3"),
        ],
      };
    },
    executeToolCall: async (call) => {
      executed.push(call.function.name);
      return JSON.stringify({ ok: true, tool: call.function.name });
    },
    onEvent: (event) => events.push(event.type),
  });

  assert.equal(result.completedNormally, true);
  assert.deepEqual(executed, ["search_recent"]);
  assert.deepEqual(result.calledTools, ["search_recent", "search", "search_news"]);
  assert.equal(result.toolResults.length, 3);
  assert.equal(JSON.parse(result.toolResults[1].result).tool_error, true);
  assert.match(JSON.parse(result.toolResults[1].result).error, /too many search\/research tool calls/);
  assert.equal(events.filter((event) => event === "tool_denied").length, 2);
});

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type ToolCall = {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments?: string;
  };
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: ChatMessage;
  }>;
};

type ModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
};

type TestCase = {
  name: string;
  expectedTool: string;
  prompt: string;
};

type TestResult = {
  name: string;
  expectedTool: string;
  calledTools: string[];
  iterationsUsed: number;
  finalAssistantResponse: ChatMessage | null;
  completedNormally: boolean;
  success: boolean;
  reason: string;
};

const { exportTools, executeToolCall } = require("../providers/openai");
const { runToolLoop } = require("../providers/openai/toolLoop");

const baseUrl = process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8000";
const configuredModel = process.env.LLAMA_MODEL;
const maxIterations = Number.parseInt(process.env.MAX_ITERATIONS ?? "10", 10);

const testCases: TestCase[] = [
  {
    name: "clarify",
    expectedTool: "clarify",
    prompt: "Question to validate: latest llama.cpp function calling support",
  },
  {
    name: "search",
    expectedTool: "search",
    prompt: "Search for current llama.cpp function calling documentation and read one page.",
  },
  {
    name: "search_recent",
    expectedTool: "search_recent",
    prompt: "Search recent news from the last month about llama.cpp tool calling.",
  },
  {
    name: "fetch_and_read",
    expectedTool: "fetch_and_read",
    prompt: "Read this specific page and summarize the title/content: https://example.com/",
  },
  {
    name: "fact_check",
    expectedTool: "fact_check",
    prompt: "Fact check this claim: llama.cpp exposes an OpenAI-compatible chat completions endpoint.",
  },
  {
    name: "check_source",
    expectedTool: "check_source",
    prompt: "Assess the credibility of this source: https://github.com/ggml-org/llama.cpp",
  },
];

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${init?.method ?? "GET"} ${url} failed before HTTP response: ${message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} failed: HTTP ${res.status}\n${text}`);
  }
  return text ? JSON.parse(text) as T : {} as T;
}

async function detectModel(): Promise<string> {
  if (configuredModel?.trim()) return configuredModel.trim();

  const models = await requestJson<ModelsResponse>(`${baseUrl}/v1/models`);
  const model = models.data?.find((item) => item.id)?.id;
  if (!model) {
    throw new Error(`No models returned from ${baseUrl}/v1/models`);
  }
  return model;
}

async function chat(model: string, messages: ChatMessage[], tools?: unknown[]): Promise<ChatMessage> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await requestJson<ChatCompletionResponse>(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const message = response.choices?.[0]?.message;
  if (!message) {
    throw new Error(`No assistant message returned:\n${JSON.stringify(response, null, 2)}`);
  }
  return message;
}

function parseArguments(args: string | undefined): unknown {
  if (!args?.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function preview(value: string, maxChars = 1200): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n... [truncated ${value.length - maxChars} chars]`;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function systemPrompt(expectedTool: string): string {
  return [
    "You are running a tool-calling integration test.",
    `For the next user message, call the ${expectedTool} tool exactly once before answering.`,
    "Use the user's wording to fill the tool arguments.",
    "After the tool result is returned, produce a short final answer that explicitly uses the tool result.",
    "Do not call any other tool unless the requested tool cannot be called.",
  ].join(" ");
}

async function runTest(model: string, tools: unknown[], test: TestCase): Promise<TestResult> {
  console.log(`=== TEST: ${test.name} ===`);
  console.log("=== USER PROMPT ===");
  console.log(test.prompt);
  console.log("");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(test.expectedTool) },
    { role: "user", content: test.prompt },
  ];

  let toolErrorReturned = false;
  let executionFailure = "";

  const loopResult = await runToolLoop({
    messages,
    tools,
    chat: (loopMessages: ChatMessage[], loopTools: unknown[]) => chat(model, loopMessages, loopTools),
    executeToolCall,
    maxIterations,
    config: {
      embeddingsUrl: baseUrl,
    },
    status: (message: string) => console.log(`[tool status] ${message}`),
    onEvent: (event: {
      type: string;
      message?: ChatMessage;
      toolCall?: ToolCall;
      parsedArguments?: unknown;
      result?: string;
    }) => {
      if (event.type === "assistant_message") {
        const toolCalls = event.message?.tool_calls ?? [];
        if (toolCalls.length > 0) {
          console.log("=== SELECTED TOOL CALLS ===");
          console.log(toolCalls.map((call) => call.function.name).join(", "));
          console.log("");
        }
        return;
      }
      if (event.type === "tool_call" && event.toolCall) {
      console.log("=== TOOL CALL ===");
        printJson(event.toolCall);
      console.log("");

      console.log("=== PARSED ARGUMENTS ===");
        printJson(event.parsedArguments);
      console.log("");
        return;
      }
      if (event.type === "tool_result" && event.result) {
      console.log("=== TOOL RESULT ===");
        console.log(preview(event.result));
      console.log("");

      try {
          const parsedResult = JSON.parse(event.result);
        if (parsedResult?.tool_error) {
            toolErrorReturned = true;
          executionFailure = String(parsedResult.error ?? "tool_error returned");
        }
      } catch {
        // Non-JSON tool results are still valid strings for this adapter.
      }
      }
    },
  });

  console.log("=== FINAL RESPONSE ===");
  if (loopResult.finalAssistantResponse) printJson(loopResult.finalAssistantResponse);
  else console.log(loopResult.abortedReason || "(no final assistant response)");
  console.log("");

  const expectedCalled = loopResult.calledTools.includes(test.expectedTool);
  const reason = !expectedCalled
    ? `expected ${test.expectedTool}, got ${loopResult.calledTools.join(", ") || "none"}`
    : loopResult.abortedReason || executionFailure || "ok";

  return {
    name: test.name,
    expectedTool: test.expectedTool,
    calledTools: loopResult.calledTools,
    iterationsUsed: loopResult.iterationsUsed,
    finalAssistantResponse: loopResult.finalAssistantResponse,
    completedNormally: loopResult.completedNormally,
    success: expectedCalled && !toolErrorReturned && loopResult.completedNormally,
    reason,
  };
}

async function main(): Promise<void> {
  console.log(`Base URL: ${baseUrl}`);
  const model = await detectModel();
  const tools = exportTools();

  console.log(`Model: ${model}`);
  console.log(`Model source: ${configuredModel?.trim() ? "LLAMA_MODEL" : "auto-detected from /v1/models"}`);
  console.log("");

  console.log("=== AVAILABLE TOOLS ===");
  console.log(tools.map((item: { function: { name: string } }) => item.function.name).join(", "));
  console.log("");

  const results: TestResult[] = [];
  for (const test of testCases) {
    try {
      results.push(await runTest(model, tools, test));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log("=== TEST ERROR ===");
      console.log(reason);
      console.log("");
      results.push({
        name: test.name,
        expectedTool: test.expectedTool,
        calledTools: [],
        iterationsUsed: 0,
        finalAssistantResponse: null,
        completedNormally: false,
        success: false,
        reason,
      });
    }
  }

  console.log("=== SUMMARY ===");
  for (const result of results) {
    console.log(`${result.success ? "PASS" : "FAIL"} ${result.name}: expected=${result.expectedTool}; called=${result.calledTools.join(", ") || "none"}; iterations=${result.iterationsUsed}; completed=${result.completedNormally}; reason=${result.reason}`);
  }

  if (results.some((result) => !result.success)) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error("Smoke test failed.");
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});

import type { RuntimeConfig } from "../../core/config";
import type { ExecuteToolCallOptions, OpenAICompatibleTool, ToolCallInput } from ".";

export type OpenAICompatibleToolCall = {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments?: string;
  };
};

export type OpenAICompatibleMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAICompatibleToolCall[];
  tool_call_id?: string;
};

export type ToolLoopChat = (
  messages: OpenAICompatibleMessage[],
  tools: OpenAICompatibleTool[],
) => Promise<OpenAICompatibleMessage>;

export type ToolLoopEvent =
  | { type: "assistant_message"; iteration: number; message: OpenAICompatibleMessage }
  | { type: "tool_call"; iteration: number; toolCall: OpenAICompatibleToolCall; parsedArguments: unknown }
  | { type: "tool_result"; iteration: number; toolCall: OpenAICompatibleToolCall; result: string };

export type ToolLoopOptions = {
  messages: OpenAICompatibleMessage[];
  tools: OpenAICompatibleTool[];
  chat: ToolLoopChat;
  executeToolCall: (call: ToolCallInput, options?: ExecuteToolCallOptions) => Promise<string>;
  maxIterations?: number;
  config?: Partial<RuntimeConfig>;
  signal?: AbortSignal;
  status?: (text: string) => void;
  onEvent?: (event: ToolLoopEvent) => void;
};

export type ToolLoopResult = {
  messages: OpenAICompatibleMessage[];
  calledTools: string[];
  iterationsUsed: number;
  toolResults: Array<{
    toolCall: OpenAICompatibleToolCall;
    result: string;
  }>;
  finalAssistantResponse: OpenAICompatibleMessage | null;
  completedNormally: boolean;
  abortedReason: string;
};

function parseArguments(args: string | undefined): unknown {
  if (!args?.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function toolCallSignature(toolCall: OpenAICompatibleToolCall): string {
  return JSON.stringify({
    name: toolCall.function.name,
    arguments: parseArguments(toolCall.function.arguments),
  });
}

export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const maxIterations = options.maxIterations ?? 10;
  const messages = [...options.messages];
  const calledTools: string[] = [];
  const toolResults: ToolLoopResult["toolResults"] = [];
  const seenToolCalls = new Set<string>();
  let iterationsUsed = 0;
  let finalAssistantResponse: OpenAICompatibleMessage | null = null;
  let completedNormally = false;
  let abortedReason = "";

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    iterationsUsed = iteration;
    const assistantMessage = await options.chat(messages, options.tools);
    options.onEvent?.({ type: "assistant_message", iteration, message: assistantMessage });
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      finalAssistantResponse = assistantMessage;
      completedNormally = true;
      break;
    }

    for (const toolCall of toolCalls) {
      const signature = toolCallSignature(toolCall);
      if (seenToolCalls.has(signature)) {
        abortedReason = `repeated identical tool call detected: ${signature}`;
        break;
      }
      seenToolCalls.add(signature);
      calledTools.push(toolCall.function.name);
      options.onEvent?.({
        type: "tool_call",
        iteration,
        toolCall,
        parsedArguments: parseArguments(toolCall.function.arguments),
      });

      const result = await options.executeToolCall(toolCall, {
        config: options.config,
        signal: options.signal,
        status: options.status,
      });
      toolResults.push({ toolCall, result });
      options.onEvent?.({ type: "tool_result", iteration, toolCall, result });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    if (abortedReason) break;
  }

  if (!completedNormally && !abortedReason && iterationsUsed >= maxIterations) {
    abortedReason = `max_iterations reached (${maxIterations})`;
  }

  return {
    messages,
    calledTools,
    iterationsUsed,
    toolResults,
    finalAssistantResponse,
    completedNormally,
    abortedReason,
  };
}

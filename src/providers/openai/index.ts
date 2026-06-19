import type { RuntimeConfig } from "../../core/config";
import { toolDefinitions, toolDefinitionList } from "../../tools/definitions";
import { createToolHandlers } from "../../tools/handlers";
import type { ToolName, ToolParams } from "../../tools/types";
import { createRuntimeConfig } from "../shared/runtimeConfig";
import { parseFieldMap, parseJsonArguments, zodFieldMapToJsonSchema, type JsonSchema } from "../shared/schema";

export type OpenAICompatibleTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
};

export type ToolCallInput =
  | {
      name: string;
      arguments?: unknown;
    }
  | {
      function: {
        name: string;
        arguments?: unknown;
      };
    };

export type ExecuteToolCallOptions = {
  config?: Partial<RuntimeConfig>;
  signal?: AbortSignal;
  status?: (text: string) => void;
};

function getToolCallName(call: ToolCallInput): string {
  return "function" in call ? call.function.name : call.name;
}

function getToolCallArguments(call: ToolCallInput): unknown {
  return "function" in call ? call.function.arguments : call.arguments;
}

function isToolName(name: string): name is ToolName {
  return name in toolDefinitions;
}

function toolError(name: string, error: string): string {
  return JSON.stringify({
    tool_error: true,
    tool: name,
    error,
    hint: "Read the error above, adjust the parameters if needed, and retry.",
  }, null, 2);
}

export function exportTools(): OpenAICompatibleTool[] {
  return toolDefinitionList.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: zodFieldMapToJsonSchema(definition.parameters),
    },
  }));
}

export async function executeToolCall(
  call: ToolCallInput,
  options: ExecuteToolCallOptions = {},
): Promise<string> {
  const name = getToolCallName(call);
  if (!isToolName(name)) {
    return toolError(name, `Unknown tool: ${name}`);
  }

  const controller = options.signal ? undefined : new AbortController();
  const signal = options.signal ?? controller?.signal;
  if (!signal) return toolError(name, "No AbortSignal available");
  if (signal.aborted) {
    return JSON.stringify({ tool_error: true, tool: name, error: "cancelled" });
  }

  try {
    const definition = toolDefinitions[name];
    const parsedArgs = parseFieldMap(definition.parameters, parseJsonArguments(getToolCallArguments(call))) as ToolParams[typeof name];
    const config = createRuntimeConfig(options.config);
    const handlers = createToolHandlers(config);
    const handler = handlers[name] as (params: ToolParams[ToolName], ctx: { signal: AbortSignal; status(text: string): void }) => Promise<string>;

    return await handler(parsedArgs, {
      signal,
      status: options.status ?? (() => undefined),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return JSON.stringify({ tool_error: true, tool: name, error: "cancelled" });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(name, msg);
  }
}

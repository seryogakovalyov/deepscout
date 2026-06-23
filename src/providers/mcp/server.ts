import type { SearchConfig, SearchTimeWindow } from "../../core/config";
import { executeToolCall, exportTools } from "../openai";

declare const process: {
  env: Record<string, string | undefined>;
  stdin: {
    setEncoding(encoding: string): void;
    on(event: "data", listener: (chunk: string) => void): void;
  };
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
};
declare const require: { main?: unknown };
declare const module: unknown;

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      error: {
        code: number;
        message: string;
        data?: unknown;
      };
    };

type McpServerOptions = {
  config?: Partial<SearchConfig>;
  status?: (message: string) => void;
};

const SERVER_INFO = {
  name: "web-search",
  version: "1.0.1",
};

function parseTimeWindow(value: string | undefined): SearchTimeWindow | undefined {
  const map: Record<string, SearchTimeWindow> = { day: "d", week: "w", month: "m", year: "y" };
  if (!value) return undefined;
  return map[value.trim().toLowerCase()] ?? undefined;
}

export function runtimeConfigFromEnv(env: Record<string, string | undefined> = process.env): Partial<SearchConfig> {
  return {
    maxResults: env.MAX_SEARCH_RESULTS ? Number.parseInt(env.MAX_SEARCH_RESULTS, 10) : undefined,
    maxPages: env.MAX_PAGES_PER_SEARCH ? Number.parseInt(env.MAX_PAGES_PER_SEARCH, 10) : undefined,
    timeoutMs: env.FETCH_TIMEOUT_MS ? Number.parseInt(env.FETCH_TIMEOUT_MS, 10) : undefined,
    locale: env.SEARCH_LANGUAGE,
    searxngUrl: env.SEARXNG_URL,
    searxngRetryAttempts: env.SEARXNG_RETRY_ATTEMPTS ? Number.parseInt(env.SEARXNG_RETRY_ATTEMPTS, 10) : undefined,
    searxngRetryDelayMs: env.SEARXNG_RETRY_DELAY_MS ? Number.parseInt(env.SEARXNG_RETRY_DELAY_MS, 10) : undefined,
    searxngRetryBackoffMultiplier: env.SEARXNG_RETRY_BACKOFF_MULTIPLIER ? Number.parseFloat(env.SEARXNG_RETRY_BACKOFF_MULTIPLIER) : undefined,
    embeddingsUrl: env.LM_STUDIO_URL ?? env.EMBEDDINGS_BASE_URL,
    searchWindow: parseTimeWindow(env.SEARCH_RECENCY_WINDOW),
  };
}

function cleanConfig(config: Partial<SearchConfig>): Partial<SearchConfig> {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined && value !== ""),
  ) as Partial<SearchConfig>;
}

export function exportMcpTools() {
  return exportTools().map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    inputSchema: tool.function.parameters,
  }));
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function protocolVersion(request: JsonRpcRequest): string {
  const requested = request.params?.protocolVersion;
  return typeof requested === "string" && requested.trim() ? requested : "2024-11-05";
}

export async function handleMcpRequest(
  request: JsonRpcRequest,
  options: McpServerOptions = {},
): Promise<JsonRpcResponse | null> {
  if (request.id === undefined) return null;
  const id = request.id;

  if (request.jsonrpc && request.jsonrpc !== "2.0") {
    return failure(id, -32600, "Invalid JSON-RPC version");
  }

  switch (request.method) {
    case "initialize":
      return success(id, {
        protocolVersion: protocolVersion(request),
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
      });

    case "ping":
      return success(id, {});

    case "tools/list":
      return success(id, {
        tools: exportMcpTools(),
      });

    case "tools/call": {
      const name = request.params?.name;
      if (typeof name !== "string") {
        return failure(id, -32602, "tools/call requires params.name");
      }
      const args = request.params?.arguments ?? {};
      const result = await executeToolCall({
        name,
        arguments: args,
      }, {
        config: cleanConfig({
          ...runtimeConfigFromEnv(),
          ...options.config,
        }),
        status: options.status,
      });

      let isError = false;
      try {
        const parsed = JSON.parse(result);
        isError = Boolean(parsed?.tool_error);
      } catch {
        isError = false;
      }

      return success(id, {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
        isError,
      });
    }

    default:
      return failure(id, -32601, `Method not found: ${request.method ?? "(missing)"}`);
  }
}

function startStdioServer(): void {
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      void (async () => {
        try {
          const request = JSON.parse(trimmed) as JsonRpcRequest;
          const response = await handleMcpRequest(request, {
            status: (message) => process.stderr.write(`[tool status] ${message}\n`),
          });
          if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const response = failure(null, -32700, "Parse error", message);
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      })();
    }
  });
}

if (require.main === module) {
  startStdioServer();
}

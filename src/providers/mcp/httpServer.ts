import { handleMcpRequest } from "./server";
import { mcpHttpConfigFromEnv } from "../../core/config";
import { loadEnvFile } from "../../core/env";

declare const process: {
  env: Record<string, string | undefined>;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
};
declare const require: {
  (name: string): {
  createServer(listener: (req: HttpRequest, res: HttpResponse) => void): {
    listen(port: number, host: string, callback: () => void): void;
  };
};
  main?: unknown;
};
declare const module: unknown;

type HttpRequest = {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "end", listener: () => void): void;
};

type HttpResponse = {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

type Buffer = {
  toString(encoding?: string): string;
};

const http = require("node:http");

function headerValue(req: HttpRequest, name: string): string | undefined {
  const value = req.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

function setCorsHeaders(req: HttpRequest, res: HttpResponse): void {
  const origin = headerValue(req, "origin");
  const requestedHeaders = headerValue(req, "access-control-request-headers");

  res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
  res.setHeader("Vary", "Origin, Access-Control-Request-Headers");
  if (origin) res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Headers",
    requestedHeaders ??
      "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function sendJson(req: HttpRequest, res: HttpResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  setCorsHeaders(req, res);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: HttpRequest): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
  });
}

export async function handleHttpRequest(req: HttpRequest, res: HttpResponse): Promise<void> {
  const method = req.method ?? "GET";
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (method === "OPTIONS") {
    res.statusCode = 204;
    setCorsHeaders(req, res);
    res.end();
    return;
  }

  if (method === "GET" && path === "/health") {
    sendJson(req, res, 200, { status: "ok" });
    return;
  }

  if (method !== "POST" || path !== "/mcp") {
    sendJson(req, res, 404, { error: "Not found" });
    return;
  }

  try {
    const body = await readBody(req);
    const parsed = body.trim() ? JSON.parse(body) : {};
    const requests = Array.isArray(parsed) ? parsed : [parsed];
    const responses = [];

    for (const request of requests) {
      const response = await handleMcpRequest(request, {
        status: (message) => process.stderr.write(`[tool status] ${message}\n`),
      });
      if (response) responses.push(response);
    }

    if (Array.isArray(parsed)) {
      sendJson(req, res, 200, responses);
    } else if (responses[0]) {
      sendJson(req, res, 200, responses[0]);
    } else {
      res.statusCode = 202;
      setCorsHeaders(req, res);
      res.end();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(req, res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: "Parse error",
        data: message,
      },
    });
  }
}

export function startMcpHttpServer(): void {
  loadEnvFile();
  const { host, port } = mcpHttpConfigFromEnv();
  const server = http.createServer((req, res) => {
    void handleHttpRequest(req, res);
  });

  server.listen(port, host, () => {
    process.stdout.write(`MCP HTTP server listening on http://${host}:${port}/mcp\n`);
  });
}

if (require.main === module) {
  startMcpHttpServer();
}

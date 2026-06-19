"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleHttpRequest = handleHttpRequest;
exports.startMcpHttpServer = startMcpHttpServer;
const server_1 = require("./server");
const config_1 = require("../../core/config");
const env_1 = require("../../core/env");
const http = require("node:http");
function headerValue(req, name) {
    const value = req.headers?.[name.toLowerCase()];
    if (Array.isArray(value))
        return value.join(", ");
    return value;
}
function setCorsHeaders(req, res) {
    const origin = headerValue(req, "origin");
    const requestedHeaders = headerValue(req, "access-control-request-headers");
    res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
    res.setHeader("Vary", "Origin, Access-Control-Request-Headers");
    if (origin)
        res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", requestedHeaders ??
        "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
}
function sendJson(req, res, statusCode, body) {
    res.statusCode = statusCode;
    setCorsHeaders(req, res);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
}
function readBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => {
            body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        req.on("end", () => resolve(body));
    });
}
async function handleHttpRequest(req, res) {
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
            const response = await (0, server_1.handleMcpRequest)(request, {
                status: (message) => process.stderr.write(`[tool status] ${message}\n`),
            });
            if (response)
                responses.push(response);
        }
        if (Array.isArray(parsed)) {
            sendJson(req, res, 200, responses);
        }
        else if (responses[0]) {
            sendJson(req, res, 200, responses[0]);
        }
        else {
            res.statusCode = 202;
            setCorsHeaders(req, res);
            res.end();
        }
    }
    catch (err) {
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
function startMcpHttpServer() {
    (0, env_1.loadEnvFile)();
    const { host, port } = (0, config_1.mcpHttpConfigFromEnv)();
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

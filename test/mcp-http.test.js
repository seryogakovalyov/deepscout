const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { handleHttpRequest } = require("../providers/mcp/httpServer");

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for MCP HTTP server")), 5000);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (pattern.test(text)) {
        clearTimeout(timeout);
        resolve(text);
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (/EADDRINUSE|Error/i.test(text)) {
        clearTimeout(timeout);
        reject(new Error(text));
      }
    });
  });
}

function mockResponse() {
  const headers = {};
  return {
    res: {
      statusCode: 0,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      end(body = "") {
        this.body = body;
      },
    },
    headers,
  };
}

test("MCP HTTP preflight reflects browser-requested headers", async () => {
  const { res, headers } = mockResponse();
  await handleHttpRequest({
    method: "OPTIONS",
    url: "/mcp",
    headers: {
      origin: "http://localhost:8000",
      "access-control-request-headers": "content-type,mcp-protocol-version,mcp-session-id",
    },
    on() {},
  }, res);

  assert.equal(res.statusCode, 204);
  assert.equal(headers["access-control-allow-origin"], "http://localhost:8000");
  assert.equal(headers["access-control-allow-credentials"], "true");
  assert.equal(headers["access-control-allow-headers"], "content-type,mcp-protocol-version,mcp-session-id");
  assert.equal(headers["access-control-expose-headers"], "mcp-session-id");
  assert.equal(headers["access-control-allow-private-network"], "true");
});

test("MCP HTTP server exposes health and tools/list", async (t) => {
  const port = 18787;
  const child = spawn(process.execPath, ["providers/mcp/httpServer.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    try {
      await waitForOutput(child, /MCP HTTP server listening/);
    } catch (err) {
      if (err instanceof Error && /listen EPERM/.test(err.message)) {
        t.skip("sandbox does not allow binding a local HTTP port");
        return;
      }
      throw err;
    }

    const health = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.json());
    assert.deepEqual(health, { status: "ok" });

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((res) => res.json());

    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.ok(response.result.tools.some((tool) => tool.name === "search"));
  } finally {
    child.kill();
  }
});

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { requestUnity } from "./connector.mjs";

let server;
let baseUrl;

before(async () => {
  server = http.createServer((request, response) => {
    if (request.url === "/health") return;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

describe("Unity bridge request timeout", () => {
  it("aborts an accepted but unresponsive Unity request within the configured bound", async () => {
    const startedAt = Date.now();
    await assert.rejects(
      requestUnity({ unityBridgeUrl: baseUrl, bridgeToken: "test" }, "/health", { timeoutMs: 60 }),
      (error) => error?.name === "TimeoutError" || error?.name === "AbortError",
    );
    assert.ok(Date.now() - startedAt < 1000);
  });

  it("still returns ordinary Unity JSON responses", async () => {
    const result = await requestUnity({ unityBridgeUrl: baseUrl }, "/ready", { timeoutMs: 500 });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { ok: true });
  });
});
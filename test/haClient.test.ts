import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { callService } from "../src/haClient.ts";

function startServer(handler: (url: string, body: string) => { status: number }): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { status } = handler(req.url ?? "", body);
        res.writeHead(status);
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

test("2xx → ok, posts to /api/services/<domain>/<service>", async () => {
  let seenUrl = "";
  let seenBody = "";
  const srv = await startServer((url, body) => { seenUrl = url; seenBody = body; return { status: 200 }; });
  const r = await callService(srv.url, "tok", "light.turn_on", { entity_id: "light.x" }, { connectMs: 300, readMs: 2000 });
  srv.close();
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(seenUrl, "/api/services/light/turn_on");
  assert.deepEqual(JSON.parse(seenBody), { entity_id: "light.x" });
});

test("4xx → not ok with http_4xx", async () => {
  const srv = await startServer(() => ({ status: 401 }));
  const r = await callService(srv.url, "tok", "light.turn_on", {}, { connectMs: 300, readMs: 2000 });
  srv.close();
  assert.equal(r.ok, false);
  assert.equal(r.error, "http_4xx");
  assert.equal(r.status, 401);
});

test("connection refused → connection_error", async () => {
  // port 1 is reserved / not listening
  const r = await callService("http://127.0.0.1:1", "tok", "light.turn_on", {}, { connectMs: 300, readMs: 2000 });
  assert.equal(r.ok, false);
  assert.ok(r.error === "connection_error" || r.error === "timeout");
});

test("preserves reverse-proxy path prefix", async () => {
  let seenUrl = "";
  const srv = await startServer((url) => { seenUrl = url; return { status: 200 }; });
  await callService(srv.url + "/ha", "tok", "light.turn_on", {}, { connectMs: 300, readMs: 2000 });
  srv.close();
  assert.equal(seenUrl, "/ha/api/services/light/turn_on");
});

test("rejects bad service shape", async () => {
  await assert.rejects(() => callService("http://h", "t", "bogus", {}, { connectMs: 300, readMs: 2000 }));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("e2e: dist/bin.js hook on_stop calls HA and logs ok", async () => {
  assert.ok(existsSync("dist/bin.js"), "run `npm run build` first");
  const calls: string[] = [];
  const server = createServer((req, res) => { calls.push(req.url ?? ""); res.writeHead(200); res.end("{}"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const dir = mkdtempSync(join(tmpdir(), "ahh-e2e-"));
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({
    ha: { url: `http://127.0.0.1:${port}`, token: "t" },
    events: { on_stop: [{ service: "light.turn_on", data: { entity_id: "light.x" } }] },
  }));

  // Run the compiled bin asynchronously so this process's event loop stays
  // free to serve the mock HA request (a sync execFileSync would deadlock the
  // in-process server and the hook would time out).
  await new Promise<void>((resolve, reject) => {
    const child = execFile("node", ["dist/bin.js", "hook", "on_stop"], {
      env: { ...process.env, AGENT_HASS_HOOK_CONFIG: cfg, AGENT_HASS_HOOK_STATE_DIR: dir },
    }, (err) => (err ? reject(err) : resolve()));
    child.stdin?.end(JSON.stringify({ cwd: dir }));
  });
  server.close();

  assert.deepEqual(calls, ["/api/services/light/turn_on"]);
  assert.ok(readFileSync(join(dir, "hook.log"), "utf-8").includes('"result":"ok"'));
});

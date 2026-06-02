import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { runHook } from "../src/dispatch.ts";

function tmp(): string { return mkdtempSync(join(tmpdir(), "ahh-")); }

function paths(dir: string, cfgPath: string) {
  return { configPath: cfgPath, stateDir: dir, logPath: join(dir, "hook.log"), breakerPath: join(dir, "breaker.json") };
}

async function mockHA(status = 200): Promise<{ url: string; calls: string[]; close: () => void }> {
  const calls: string[] = [];
  return await new Promise((resolve) => {
    const server = createServer((req, res) => { calls.push(req.url ?? ""); res.writeHead(status); res.end("{}"); });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, calls, close: () => server.close() });
    });
  });
}

test("AGENT_HASS_HOOK_DISABLE=1 exits 0 without calling HA", async () => {
  const dir = tmp();
  const code = await runHook("on_stop", "", { AGENT_HASS_HOOK_DISABLE: "1" }, paths(dir, "/nope.json"));
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, "hook.log")), false);
});

test(".no-hass-hook marker in cwd skips", async () => {
  const dir = tmp();
  const proj = tmp();
  writeFileSync(join(proj, ".no-hass-hook"), "");
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ ha: { url: "http://h", token: "t" }, events: { on_stop: [{ service: "light.turn_on", data: {} }] } }));
  const code = await runHook("on_stop", JSON.stringify({ cwd: proj }), {}, paths(dir, cfg));
  assert.equal(code, 0);
  const log = readFileSync(join(dir, "hook.log"), "utf-8");
  assert.ok(log.includes("project_disabled"));
});

test("empty event = no-op, no breaker file written", async () => {
  const dir = tmp();
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ ha: { url: "http://h", token: "t" }, events: { on_stop: [{ service: "light.turn_on", data: {} }] } }));
  const code = await runHook("on_user_prompt_submit", "", {}, paths(dir, cfg));
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, "breaker.json")), false);
});

test("happy path calls HA and logs ok", async () => {
  const dir = tmp();
  const ha = await mockHA(200);
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ ha: { url: ha.url, token: "t" }, events: { on_stop: [{ service: "light.turn_on", data: { entity_id: "light.x" } }] } }));
  const code = await runHook("on_stop", "", {}, paths(dir, cfg));
  ha.close();
  assert.equal(code, 0);
  assert.deepEqual(ha.calls, ["/api/services/light/turn_on"]);
  assert.ok(readFileSync(join(dir, "hook.log"), "utf-8").includes('"result":"ok"'));
});

test("config error logged, returns 0", async () => {
  const dir = tmp();
  const code = await runHook("on_stop", "", {}, paths(dir, join(dir, "missing.json")));
  assert.equal(code, 0);
  assert.ok(readFileSync(join(dir, "hook.log"), "utf-8").includes("config_error"));
});

test("malformed ha.url (ftp scheme) resolves to 0 and logs an error, never throws", async () => {
  const dir = tmp();
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ ha: { url: "ftp://example.com/", token: "t" }, events: { on_stop: [{ service: "light.turn_on", data: {} }] } }));
  const code = await runHook("on_stop", "", {}, paths(dir, cfg));
  assert.equal(code, 0);
  const log = readFileSync(join(dir, "hook.log"), "utf-8");
  assert.ok(log.includes('"result":"failed"'));
  assert.ok(log.includes("error"));
});

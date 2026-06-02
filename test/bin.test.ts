import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

// Runs the real entry via tsx so stdin handling is exercised end-to-end.
function runBin(args: string[], stdin: string, env: Record<string, string>): string {
  return execFileSync("node", ["--import", "tsx", "src/bin.ts", ...args], {
    input: stdin,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

function tmp(): string { return mkdtempSync(join(tmpdir(), "ahh-bin-")); }

// Async spawn so the parent event loop keeps serving the in-process mock HA
// (execFileSync would block the loop and the mock would never accept).
function runBinAsync(args: string[], stdin: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", "src/bin.ts", ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
    child.stdin.end(stdin);
  });
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

test("hook event with no config for that event is a silent no-op (exit 0)", () => {
  const dir = tmp();
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ ha: { url: "http://h", token: "t" }, events: { on_stop: [{ service: "light.turn_on", data: {} }] } }));
  // on_user_prompt_submit not configured → no-op, exit 0, no throw
  runBin(["hook", "on_user_prompt_submit"], "", { AGENT_HASS_HOOK_CONFIG: cfg, AGENT_HASS_HOOK_STATE_DIR: dir });
});

test("disable env short-circuits", () => {
  runBin(["hook", "on_stop"], "", { AGENT_HASS_HOOK_DISABLE: "1" });
});

test("happy path: real bin calls mock HA and logs ok", async () => {
  const dir = tmp();
  const ha = await mockHA(200);
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({
    ha: { url: ha.url, token: "t" },
    events: { on_stop: [{ service: "light.turn_on", data: { entity_id: "light.x" } }] },
  }));
  const code = await runBinAsync(["hook", "on_stop"], JSON.stringify({ cwd: dir }), {
    AGENT_HASS_HOOK_CONFIG: cfg, AGENT_HASS_HOOK_STATE_DIR: dir,
  });
  ha.close();
  assert.equal(code, 0);
  assert.deepEqual(ha.calls, ["/api/services/light/turn_on"]);
  const log = readFileSync(join(dir, "hook.log"), "utf-8");
  assert.ok(log.includes('"result":"ok"'));
});

test("broken setup (missing config) still exits 0 and logs config_error", () => {
  const dir = tmp();
  const missing = join(dir, "does-not-exist.json");
  const res = spawnSync("node", ["--import", "tsx", "src/bin.ts", "hook", "on_stop"], {
    input: JSON.stringify({ cwd: dir }),
    env: { ...process.env, AGENT_HASS_HOOK_CONFIG: missing, AGENT_HASS_HOOK_STATE_DIR: dir },
    encoding: "utf-8",
  });
  assert.equal(res.status, 0); // never block Claude Code
  const log = readFileSync(join(dir, "hook.log"), "utf-8");
  assert.ok(log.includes("config_error"));
});

test("uninstall round-trip removes our hook, preserves foreign hook", () => {
  const home = tmp();
  const claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");
  const ourCmd = 'node "/home/u/.npm/@swim2sun/agent-hass-hook/dist/bin.js" hook on_stop';
  const foreignCmd = "my-tool --do-thing";
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: ourCmd }] },
        { matcher: "", hooks: [{ type: "command", command: foreignCmd }] },
      ],
    },
  }));

  runBin(["uninstall"], "", { HOME: home });

  const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
  const cmds = (after.hooks?.Stop ?? []).flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command));
  assert.ok(!cmds.includes(ourCmd), "our hook should be removed");
  assert.ok(cmds.includes(foreignCmd), "foreign hook should remain");
});

test("uninstall on malformed settings.json exits 0 with a friendly stderr line", () => {
  const home = tmp();
  const claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");
  writeFileSync(settingsPath, "{ broken json");

  const res = spawnSync("node", ["--import", "tsx", "src/bin.ts", "uninstall"], {
    env: { ...process.env, HOME: home },
    encoding: "utf-8",
  });
  assert.equal(res.status, 0);
  assert.ok(/not valid JSON/.test(res.stderr));
  // file untouched
  assert.equal(readFileSync(settingsPath, "utf-8"), "{ broken json");
});

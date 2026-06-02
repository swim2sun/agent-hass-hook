import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Runs the real entry via tsx so stdin handling is exercised end-to-end.
function runBin(args: string[], stdin: string, env: Record<string, string>): string {
  return execFileSync("node", ["--import", "tsx", "src/bin.ts", ...args], {
    input: stdin,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

test("hook event with no config for that event is a silent no-op (exit 0)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahh-"));
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ ha: { url: "http://h", token: "t" }, events: { on_stop: [{ service: "light.turn_on", data: {} }] } }));
  // on_user_prompt_submit not configured → no-op, exit 0, no throw
  runBin(["hook", "on_user_prompt_submit"], "", { AGENT_HASS_HOOK_CONFIG: cfg, AGENT_HASS_HOOK_STATE_DIR: dir });
});

test("disable env short-circuits", () => {
  runBin(["hook", "on_stop"], "", { AGENT_HASS_HOOK_DISABLE: "1" });
});

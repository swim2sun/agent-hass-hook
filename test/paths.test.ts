import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePaths } from "../src/paths.ts";

test("defaults use XDG home layout", () => {
  const p = resolvePaths({ HOME: "/home/u" });
  assert.equal(p.configPath, "/home/u/.config/agent-hass-hook/config.json");
  assert.equal(p.stateDir, "/home/u/.local/state/agent-hass-hook");
  assert.equal(p.logPath, "/home/u/.local/state/agent-hass-hook/hook.log");
  assert.equal(p.breakerPath, "/home/u/.local/state/agent-hass-hook/breaker.json");
});

test("XDG_CONFIG_HOME / XDG_STATE_HOME respected", () => {
  const p = resolvePaths({ HOME: "/home/u", XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/st" });
  assert.equal(p.configPath, "/cfg/agent-hass-hook/config.json");
  assert.equal(p.stateDir, "/st/agent-hass-hook");
});

test("explicit env overrides win", () => {
  const p = resolvePaths({
    HOME: "/home/u",
    AGENT_HASS_HOOK_CONFIG: "/tmp/c.json",
    AGENT_HASS_HOOK_STATE_DIR: "/tmp/state",
  });
  assert.equal(p.configPath, "/tmp/c.json");
  assert.equal(p.stateDir, "/tmp/state");
});

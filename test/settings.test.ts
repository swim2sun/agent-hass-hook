import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerEvents, removeOurHooks, readSettings, EVENT_MAP } from "../src/settings.ts";

// Realistic installed path: always contains the package name, which is what
// removeOurHooks keys on. (A bare "/abs/dist/bin.js" would not be detected.)
const CMD = "/home/u/.npm/@swim2sun/agent-hass-hook/dist/bin.js";

test("registerEvents adds Stop + UserPromptSubmit idempotently", () => {
  let s: any = {};
  s = registerEvents(s, ["on_stop", "on_user_prompt_submit"], CMD);
  assert.equal(s.hooks.Stop[0].hooks[0].command, `node "${CMD}" hook on_stop`);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, `node "${CMD}" hook on_user_prompt_submit`);
  // idempotent: second call does not duplicate
  s = registerEvents(s, ["on_stop"], CMD);
  assert.equal(s.hooks.Stop.length, 1);
});

test("registerEvents quotes the bin path (handles spaces)", () => {
  const spaced = "/Users/First Last/.npm/@swim2sun/agent-hass-hook/dist/bin.js";
  const s: any = registerEvents({}, ["on_stop"], spaced);
  assert.equal(s.hooks.Stop[0].hooks[0].command, `node "${spaced}" hook on_stop`);
});

test("registerEvents preserves unrelated hooks", () => {
  const s: any = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }] } };
  const out = registerEvents(s, ["on_stop"], CMD);
  const cmds = out.hooks.Stop.flatMap((e: any) => e.hooks.map((h: any) => h.command));
  assert.ok(cmds.includes("other"));
  assert.ok(cmds.includes(`node "${CMD}" hook on_stop`));
});

test("removeOurHooks strips only our entries across all events", () => {
  const s: any = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: `node "${CMD}" hook on_stop` }, { type: "command", command: "keepme" }] }],
      UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: `node "${CMD}" hook on_user_prompt_submit` }] }],
    },
  };
  const out = removeOurHooks(s);
  assert.deepEqual(out.hooks.Stop[0].hooks.map((h: any) => h.command), ["keepme"]);
  assert.equal(out.hooks.UserPromptSubmit, undefined); // emptied → key removed
});

test("removeOurHooks preserves a foreign command lacking an on_ token (e.g. a .bak)", () => {
  const s: any = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "node /opt/agent-hass-hook/bin.js.bak --backup" }] }],
    },
  };
  const out = removeOurHooks(s);
  assert.deepEqual(out.hooks.Stop[0].hooks.map((h: any) => h.command), ["node /opt/agent-hass-hook/bin.js.bak --backup"]);
});

test("removeOurHooks removes legacy bash hook.sh form", () => {
  const legacy = "/home/u/.local/share/agent-hass-hook/adapters/claude-code/hook.sh on_stop";
  const s: any = {
    hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: legacy }, { type: "command", command: "keepme" }] }] },
  };
  const out = removeOurHooks(s);
  assert.deepEqual(out.hooks.Stop[0].hooks.map((h: any) => h.command), ["keepme"]);
});

test("readSettings throws a clear error on malformed JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahh-set-"));
  const p = join(dir, "settings.json");
  writeFileSync(p, "{ broken json");
  assert.throws(() => readSettings(p), /not valid JSON/);
});

test("EVENT_MAP maps known events", () => {
  assert.equal(EVENT_MAP.on_stop, "Stop");
  assert.equal(EVENT_MAP.on_user_prompt_submit, "UserPromptSubmit");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HookLogger } from "../src/logger.ts";

test("appends one JSON line per call", () => {
  const p = join(mkdtempSync(join(tmpdir(), "ahh-")), "hook.log");
  const log = new HookLogger(p, 1_000_000, () => "2026-06-02T00:00:00Z");
  log.log({ event: "on_stop", result: "ok" });
  log.log({ event: "on_stop", result: "failed" });
  const lines = readFileSync(p, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { ts: "2026-06-02T00:00:00Z", event: "on_stop", result: "ok" });
});

test("rotates to .1 when over max_bytes", () => {
  const p = join(mkdtempSync(join(tmpdir(), "ahh-")), "hook.log");
  writeFileSync(p, "x".repeat(50));
  const log = new HookLogger(p, 10, () => "2026-06-02T00:00:00Z"); // rotate on construct
  assert.ok(existsSync(p + ".1"));
  log.log({ event: "on_stop" });
  assert.ok(readFileSync(p, "utf-8").includes("on_stop"));
});

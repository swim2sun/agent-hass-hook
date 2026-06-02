import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CircuitBreaker } from "../src/circuitBreaker.ts";

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), "ahh-")), "breaker.json");
}

test("closed by default, no skip", () => {
  const cb = new CircuitBreaker(statePath(), 3, 300);
  assert.equal(cb.shouldSkip(), false);
});

test("trips open after threshold failures", () => {
  const p = statePath();
  let now = 1000;
  const cb = new CircuitBreaker(p, 3, 300, () => now);
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.shouldSkip(), false);
  cb.recordFailure();
  assert.equal(cb.shouldSkip(), true);
});

test("half-open after open_duration, success closes", () => {
  const p = statePath();
  let now = 1000;
  const cb = new CircuitBreaker(p, 1, 300, () => now);
  cb.recordFailure();
  assert.equal(cb.shouldSkip(), true);
  now = 1000 + 300;
  assert.equal(cb.shouldSkip(), false); // half-open trial allowed
  cb.recordSuccess();
  const reloaded = new CircuitBreaker(p, 1, 300, () => now);
  assert.equal(reloaded.shouldSkip(), false);
});

test("state persists across instances", () => {
  const p = statePath();
  let now = 5000;
  const a = new CircuitBreaker(p, 1, 300, () => now);
  a.recordFailure();
  const b = new CircuitBreaker(p, 1, 300, () => now);
  assert.equal(b.shouldSkip(), true);
});

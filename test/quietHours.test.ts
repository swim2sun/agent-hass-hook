import { test } from "node:test";
import assert from "node:assert/strict";
import { isWithinQuietHours, type QuietWindow } from "../src/quietHours.ts";

const sameDay: QuietWindow[] = [{ start: "09:00", end: "18:00" }];
const overnight: QuietWindow[] = [{ start: "22:00", end: "07:00" }];

function at(h: number, m: number): Date {
  return new Date(2026, 0, 1, h, m);
}

test("inside a same-day window is active", () => {
  const r = isWithinQuietHours(at(12, 0), sameDay);
  assert.equal(r.active, true);
  assert.equal(r.window, "09:00-18:00");
});

test("outside a same-day window is inactive", () => {
  assert.equal(isWithinQuietHours(at(20, 0), sameDay).active, false);
});

test("start boundary is inclusive (active)", () => {
  assert.equal(isWithinQuietHours(at(9, 0), sameDay).active, true);
});

test("end boundary is exclusive (inactive)", () => {
  assert.equal(isWithinQuietHours(at(18, 0), sameDay).active, false);
});

test("overnight window: before midnight is active", () => {
  const r = isWithinQuietHours(at(23, 0), overnight);
  assert.equal(r.active, true);
  assert.equal(r.window, "22:00-07:00");
});

test("overnight window: after midnight is active", () => {
  assert.equal(isWithinQuietHours(at(3, 0), overnight).active, true);
});

test("overnight window: mid-day is inactive", () => {
  assert.equal(isWithinQuietHours(at(12, 0), overnight).active, false);
});

test("multiple windows: matches the second", () => {
  const windows: QuietWindow[] = [
    { start: "09:00", end: "10:00" },
    { start: "13:00", end: "14:00" },
  ];
  const r = isWithinQuietHours(at(13, 30), windows);
  assert.equal(r.active, true);
  assert.equal(r.window, "13:00-14:00");
});

test("empty list is never active", () => {
  assert.equal(isWithinQuietHours(at(12, 0), []).active, false);
});

test("start == end is a zero-length window (never active)", () => {
  assert.equal(isWithinQuietHours(at(12, 0), [{ start: "12:00", end: "12:00" }]).active, false);
});

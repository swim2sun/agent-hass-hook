import { test } from "node:test";
import assert from "node:assert/strict";
import { render, PRESETS } from "../src/presets.ts";

test("preset A: off on submit, on on stop", () => {
  const ev = render("A", "light.x");
  assert.deepEqual(ev.on_user_prompt_submit, [{ service: "light.turn_off", data: { entity_id: "light.x" } }]);
  assert.deepEqual(ev.on_stop, [{ service: "light.turn_on", data: { entity_id: "light.x" } }]);
});

test("preset C: warm/dim on submit, cool/bright on stop", () => {
  const ev = render("C", "light.x", { warmKelvin: 2700, coolKelvin: 6500 });
  assert.deepEqual(ev.on_user_prompt_submit, [
    { service: "light.turn_on", data: { entity_id: "light.x", color_temp_kelvin: 2700, brightness_pct: 50 } },
  ]);
  assert.deepEqual(ev.on_stop, [
    { service: "light.turn_on", data: { entity_id: "light.x", color_temp_kelvin: 6500, brightness_pct: 100 } },
  ]);
});

test("unknown preset throws", () => {
  assert.throws(() => render("Z" as never, "light.x"));
  assert.ok(PRESETS.includes("A") && PRESETS.includes("C"));
});

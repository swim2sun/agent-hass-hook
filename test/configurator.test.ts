import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLights, renderConfigJson, parseQuietHours } from "../src/configurator.ts";

const states = [
  { entity_id: "light.desk", state: "on", attributes: { friendly_name: "Desk", supported_color_modes: ["color_temp"], min_color_temp_kelvin: 2202, max_color_temp_kelvin: 6535 } },
  { entity_id: "light.plain", state: "off", attributes: { friendly_name: "Plain", supported_color_modes: ["onoff"] } },
  { entity_id: "switch.fan", state: "off", attributes: {} },
];

test("parseLights picks light.* and reports color_temp support", () => {
  const lights = parseLights(states);
  assert.equal(lights.length, 2);
  assert.equal(lights[0].entityId, "light.desk");
  assert.equal(lights[0].supportsColorTemp, true);
  assert.equal(lights[0].warmKelvin, 2202);
  assert.equal(lights[0].coolKelvin, 6535);
  assert.equal(lights[1].supportsColorTemp, false);
});

test("parseLights guards non-array supported_color_modes (no throw, false)", () => {
  const lights = parseLights([
    { entity_id: "light.weird", state: "on", attributes: { friendly_name: "Weird", supported_color_modes: "color_temp" } },
  ]);
  assert.equal(lights.length, 1);
  assert.equal(lights[0].supportsColorTemp, false);
});

test("renderConfigJson builds full config object for preset A", () => {
  const cfg = renderConfigJson({ url: "http://h:8123/", token: "tok", entity: "light.desk", preset: "A" });
  assert.equal(cfg.ha.url, "http://h:8123/");
  assert.equal(cfg.ha.token, "tok");
  assert.equal(cfg.ha.verify_ssl, true);
  assert.deepEqual(cfg.events.on_stop, [{ service: "light.turn_on", data: { entity_id: "light.desk" } }]);
  assert.deepEqual(cfg.events.on_user_prompt_submit, [{ service: "light.turn_off", data: { entity_id: "light.desk" } }]);
});

test("renderConfigJson preset C carries kelvin", () => {
  const cfg = renderConfigJson({ url: "u", token: "t", entity: "light.desk", preset: "C", warmKelvin: 2200, coolKelvin: 6500 });
  assert.equal(cfg.events.on_stop[0].data.color_temp_kelvin, 6500);
  assert.equal(cfg.events.on_user_prompt_submit[0].data.color_temp_kelvin, 2200);
});

test("parseQuietHours parses a single range", () => {
  assert.deepEqual(parseQuietHours("09:00-18:00"), [{ start: "09:00", end: "18:00" }]);
});

test("parseQuietHours parses multiple comma-separated ranges", () => {
  assert.deepEqual(parseQuietHours("09:00-18:00, 22:00-07:00"), [
    { start: "09:00", end: "18:00" },
    { start: "22:00", end: "07:00" },
  ]);
});

test("parseQuietHours empty/whitespace input is []", () => {
  assert.deepEqual(parseQuietHours(""), []);
  assert.deepEqual(parseQuietHours("   "), []);
});

test("parseQuietHours throws on a malformed token", () => {
  assert.throws(() => parseQuietHours("9:00-18:00"), Error);
  assert.throws(() => parseQuietHours("09:00 18:00"), Error);
  assert.throws(() => parseQuietHours("24:00-18:00"), Error);
});

test("renderConfigJson includes quiet_hours when provided", () => {
  const cfg = renderConfigJson({
    url: "u", token: "t", entity: "light.desk", preset: "A",
    quietHours: [{ start: "09:00", end: "18:00" }],
  });
  assert.deepEqual((cfg as any).quiet_hours, [{ start: "09:00", end: "18:00" }]);
});

test("renderConfigJson omits quiet_hours when empty/absent", () => {
  const none = renderConfigJson({ url: "u", token: "t", entity: "light.desk", preset: "A" });
  assert.equal("quiet_hours" in none, false);
  const empty = renderConfigJson({ url: "u", token: "t", entity: "light.desk", preset: "A", quietHours: [] });
  assert.equal("quiet_hours" in empty, false);
});

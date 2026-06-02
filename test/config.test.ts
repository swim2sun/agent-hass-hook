import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, ConfigError } from "../src/config.ts";

function writeCfg(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ahh-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const valid = {
  ha: { url: "http://h:8123/", token: "t" },
  events: { on_stop: [{ service: "light.turn_on", data: { entity_id: "light.x" } }] },
};

test("loads a valid config with defaults", () => {
  const cfg = loadConfig(writeCfg(valid), {});
  assert.equal(cfg.ha.url, "http://h:8123/");
  assert.equal(cfg.ha.token, "t");
  assert.equal(cfg.ha.verifySsl, true);
  assert.equal(cfg.timeouts.connectMs, 300);
  assert.equal(cfg.timeouts.readMs, 2000);
  assert.equal(cfg.breaker.failureThreshold, 3);
  assert.equal(cfg.breaker.openDurationSec, 300);
  assert.deepEqual(cfg.events.on_stop, [{ service: "light.turn_on", data: { entity_id: "light.x" } }]);
});

test("missing file throws ConfigError", () => {
  assert.throws(() => loadConfig("/nope/config.json", {}), ConfigError);
});

test("missing url/token throws ConfigError", () => {
  assert.throws(() => loadConfig(writeCfg({ ha: { token: "t" }, events: valid.events }), {}), ConfigError);
  assert.throws(() => loadConfig(writeCfg({ ha: { url: "u" }, events: valid.events }), {}), ConfigError);
});

test("env overrides url/token/verify_ssl", () => {
  const cfg = loadConfig(writeCfg(valid), {
    AGENT_HASS_HOOK_HA_URL: "http://env:8123/",
    AGENT_HASS_HOOK_HA_TOKEN: "envtok",
    AGENT_HASS_HOOK_HA_VERIFY_SSL: "false",
  });
  assert.equal(cfg.ha.url, "http://env:8123/");
  assert.equal(cfg.ha.token, "envtok");
  assert.equal(cfg.ha.verifySsl, false);
});

test("at least one event required", () => {
  assert.throws(() => loadConfig(writeCfg({ ha: valid.ha, events: {} }), {}), ConfigError);
});

test("action service must be domain.service", () => {
  assert.throws(
    () => loadConfig(writeCfg({ ha: valid.ha, events: { on_stop: [{ service: "bogus", data: {} }] } }), {}),
    ConfigError,
  );
});

test("non-http(s) url scheme throws ConfigError", () => {
  assert.throws(() => loadConfig(writeCfg({ ha: { url: "ftp://x/", token: "t" }, events: valid.events }), {}), ConfigError);
});

test("unparseable url throws ConfigError", () => {
  assert.throws(() => loadConfig(writeCfg({ ha: { url: "not a url", token: "t" }, events: valid.events }), {}), ConfigError);
});

test("https url loads", () => {
  const cfg = loadConfig(writeCfg({ ha: { url: "https://h:8123/", token: "t" }, events: valid.events }), {});
  assert.equal(cfg.ha.url, "https://h:8123/");
});

test("non-numeric timeout throws ConfigError", () => {
  assert.throws(() => loadConfig(writeCfg({ ha: valid.ha, events: valid.events, timeouts: { connect_ms: "fast" } }), {}), ConfigError);
});

test("non-numeric breaker value throws ConfigError", () => {
  assert.throws(() => loadConfig(writeCfg({ ha: valid.ha, events: valid.events, circuit_breaker: { failure_threshold: "lots" } }), {}), ConfigError);
});

test("malformed JSON throws ConfigError", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahh-"));
  const p = join(dir, "config.json");
  writeFileSync(p, "{ not json");
  assert.throws(() => loadConfig(p, {}), ConfigError);
});

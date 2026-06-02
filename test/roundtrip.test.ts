import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderConfigJson } from "../src/configurator.ts";
import { writeConfig } from "../src/configFile.ts";
import { loadConfig } from "../src/config.ts";

test("renderConfigJson -> writeConfig -> loadConfig round-trips the snake_case seam", () => {
  const rendered = renderConfigJson({
    url: "http://h:8123/",
    token: "tok",
    entity: "light.x",
    preset: "C",
    warmKelvin: 2200,
    coolKelvin: 6500,
  });

  const dir = mkdtempSync(join(tmpdir(), "ahh-rt-"));
  const path = join(dir, "config.json");
  writeConfig(path, rendered);

  const cfg = loadConfig(path, {});

  assert.equal(cfg.ha.url, "http://h:8123/");
  assert.equal(cfg.ha.token, "tok");
  assert.equal(cfg.ha.verifySsl, true);
  assert.equal(cfg.timeouts.connectMs, 300);
  assert.equal(cfg.breaker.failureThreshold, 3);
  assert.equal(cfg.events.on_stop[0].data.color_temp_kelvin, 6500);
  assert.equal(cfg.events.on_user_prompt_submit[0].data.color_temp_kelvin, 2200);
});

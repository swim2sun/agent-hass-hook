import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { render, type Preset } from "./presets.ts";
import { registerEvents, readSettings, writeSettings, EVENT_MAP } from "./settings.ts";
import { writeConfig } from "./configFile.ts";
import type { Paths } from "./paths.ts";

export interface LightRow {
  entityId: string;
  state: string;
  friendlyName: string;
  supportsColorTemp: boolean;
  warmKelvin: number;
  coolKelvin: number;
}

export function parseLights(states: unknown[]): LightRow[] {
  const rows: LightRow[] = [];
  for (const s of states as Array<Record<string, any>>) {
    if (typeof s?.entity_id !== "string" || !s.entity_id.startsWith("light.")) continue;
    const a = s.attributes ?? {};
    rows.push({
      entityId: s.entity_id,
      state: s.state ?? "",
      friendlyName: a.friendly_name ?? "",
      supportsColorTemp: Array.isArray(a.supported_color_modes) && a.supported_color_modes.includes("color_temp"),
      warmKelvin: a.min_color_temp_kelvin ?? 2700,
      coolKelvin: a.max_color_temp_kelvin ?? 6500,
    });
  }
  return rows;
}

export interface RenderArgs {
  url: string; token: string; entity: string; preset: Preset;
  warmKelvin?: number; coolKelvin?: number;
}

export function renderConfigJson(args: RenderArgs): {
  ha: { url: string; token: string; verify_ssl: boolean };
  timeouts: { connect_ms: number; read_ms: number };
  circuit_breaker: { failure_threshold: number; open_duration_sec: number };
  events: Record<string, Array<{ service: string; data: Record<string, any> }>>;
} {
  const events = render(args.preset, args.entity, { warmKelvin: args.warmKelvin, coolKelvin: args.coolKelvin });
  return {
    ha: { url: args.url, token: args.token, verify_ssl: true },
    timeouts: { connect_ms: 300, read_ms: 2000 },
    circuit_breaker: { failure_threshold: 3, open_duration_sec: 300 },
    events,
  };
}

// Absolute path to this package's compiled bin (dist/bin.js).
export function resolveBinPath(): string {
  // configurator.ts and bin.ts compile next to each other in dist/.
  const here = fileURLToPath(new URL(".", import.meta.url));
  return realpathSync(`${here}bin.js`);
}

async function httpGetJson(url: string, token: string, path: string): Promise<unknown> {
  const res = await fetch(url.replace(/\/+$/, "") + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function runConfigurator(paths: Paths): Promise<number> {
  p.intro("agent-hass-hook setup");

  const url = await p.text({ message: "Home Assistant URL", placeholder: "http://192.168.1.100:8123" });
  if (p.isCancel(url)) { p.cancel("Aborted."); return 1; }
  const token = await p.password({ message: "Long-lived access token" });
  if (p.isCancel(token)) { p.cancel("Aborted."); return 1; }

  let lights: LightRow[];
  const s = p.spinner();
  s.start("Connecting & discovering lights");
  try {
    await httpGetJson(url, token, "/api/");
    const states = (await httpGetJson(url, token, "/api/states")) as unknown[];
    lights = parseLights(states);
    s.stop(`Connected — found ${lights.length} light(s)`);
  } catch (e) {
    s.stop(`Connection failed: ${(e as Error).message}`);
    p.cancel("Check URL/token and retry.");
    return 1;
  }

  const entity = await p.select({
    message: "Pick a light",
    options: lights.length
      ? lights.map((l) => ({ value: l.entityId, label: `${l.entityId} [${l.state}] ${l.friendlyName}` }))
      : [{ value: "__manual__", label: "(type an entity_id manually)" }],
  });
  if (p.isCancel(entity)) { p.cancel("Aborted."); return 1; }
  let chosen = entity as string;
  let row = lights.find((l) => l.entityId === chosen);
  if (chosen === "__manual__") {
    const manual = await p.text({ message: "entity_id", placeholder: "light.desk" });
    if (p.isCancel(manual)) { p.cancel("Aborted."); return 1; }
    chosen = manual as string;
    row = undefined;
  }

  const presetChoice = await p.select({
    message: "Behavior preset",
    options: [
      { value: "A", label: "A — off while working, on when done (recommended)" },
      { value: "C", label: "C — warm/dim while working, cool/bright when done" },
    ],
  });
  if (p.isCancel(presetChoice)) { p.cancel("Aborted."); return 1; }
  let preset = presetChoice as Preset;
  if (preset === "C" && row && !row.supportsColorTemp) {
    p.log.warn("Device has no color_temp support; falling back to preset A.");
    preset = "A";
  }

  const cfg = renderConfigJson({
    url: url as string, token: token as string, entity: chosen, preset,
    warmKelvin: row?.warmKelvin, coolKelvin: row?.coolKelvin,
  });
  writeConfig(paths.configPath, cfg);
  p.log.success(`Wrote ${paths.configPath} (chmod 600)`);

  const binPath = resolveBinPath();
  const settingsPath = `${process.env.HOME}/.claude/settings.json`;
  const settings = registerEvents(readSettings(settingsPath), Object.keys(cfg.events), binPath);
  writeSettings(settingsPath, settings);
  p.log.success(`Registered ${Object.keys(cfg.events).map((e) => EVENT_MAP[e]).join(" + ")} in ${settingsPath}`);

  p.outro("Done. Disable per-session with AGENT_HASS_HOOK_DISABLE=1, per-project with `touch .no-hass-hook`.");
  return 0;
}

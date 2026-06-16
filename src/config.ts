import { readFileSync } from "node:fs";
import type { QuietWindow } from "./quietHours.ts";

export class ConfigError extends Error {}

export interface HAConfig { url: string; token: string; verifySsl: boolean; }
export interface Timeouts { connectMs: number; readMs: number; }
export interface BreakerConfig { failureThreshold: number; openDurationSec: number; }
export interface Action { service: string; data: Record<string, unknown>; }
export interface Config {
  ha: HAConfig;
  timeouts: Timeouts;
  breaker: BreakerConfig;
  events: Record<string, Action[]>;
  quietHours: QuietWindow[];
}

const HHMM_RE = /^\d{2}:\d{2}$/;

function validateHHMM(key: string, raw: unknown): string {
  if (typeof raw !== "string" || !HHMM_RE.test(raw)) {
    throw new ConfigError(`${key} must be a "HH:MM" string, got ${JSON.stringify(raw)}`);
  }
  const [h, m] = raw.split(":").map(Number);
  if (h > 23 || m > 59) throw new ConfigError(`${key} is out of range (00:00–23:59), got ${JSON.stringify(raw)}`);
  return raw;
}

function parseQuietHours(raw: unknown): QuietWindow[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError("quiet_hours must be an array");
  return raw.map((entry, idx) => {
    if (!isObject(entry)) throw new ConfigError(`quiet_hours[${idx}] must be an object`);
    return {
      start: validateHHMM(`quiet_hours[${idx}].start`, entry.start),
      end: validateHHMM(`quiet_hours[${idx}].end`, entry.end),
    };
  });
}

const EVENT_PREFIX = "on_";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function envBool(value: string): boolean {
  return !["false", "0", "no", "off", ""].includes(value.trim().toLowerCase());
}

function num(key: string, raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

function parseActions(key: string, raw: unknown): Action[] {
  if (!Array.isArray(raw)) throw new ConfigError(`events.${key} must be an array`);
  return raw.map((entry, idx) => {
    if (!isObject(entry)) throw new ConfigError(`events.${key}[${idx}] must be an object`);
    const service = entry.service;
    if (typeof service !== "string" || !service.includes(".")) {
      throw new ConfigError(`events.${key}[${idx}].service must be "domain.service" (e.g. "light.turn_on")`);
    }
    const data = entry.data ?? {};
    if (!isObject(data)) throw new ConfigError(`events.${key}[${idx}].data must be an object`);
    return { service, data: { ...data } };
  });
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    throw new ConfigError(`Config file not found: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`Failed to parse JSON in ${path}: ${(e as Error).message}`);
  }
  if (!isObject(raw)) throw new ConfigError("config root must be an object");

  const haRaw = raw.ha;
  if (!isObject(haRaw)) throw new ConfigError("'ha' must be an object");

  const url = env.AGENT_HASS_HOOK_HA_URL || (haRaw.url as string | undefined);
  if (!url) throw new ConfigError("ha.url is required (or set AGENT_HASS_HOOK_HA_URL)");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ConfigError(`ha.url is not a valid URL: ${JSON.stringify(url)}`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new ConfigError(`ha.url must use http or https scheme, got ${JSON.stringify(url)}`);
  }
  const token = env.AGENT_HASS_HOOK_HA_TOKEN || (haRaw.token as string | undefined);
  if (!token) throw new ConfigError("ha.token is required (or set AGENT_HASS_HOOK_HA_TOKEN)");

  const verifyEnv = env.AGENT_HASS_HOOK_HA_VERIFY_SSL;
  const verifySsl = verifyEnv !== undefined ? envBool(verifyEnv) : haRaw.verify_ssl !== false;

  const tRaw = isObject(raw.timeouts) ? raw.timeouts : {};
  const timeouts: Timeouts = {
    connectMs: num("timeouts.connect_ms", tRaw.connect_ms, 300),
    readMs: num("timeouts.read_ms", tRaw.read_ms, 2000),
  };

  const bRaw = isObject(raw.circuit_breaker) ? raw.circuit_breaker : {};
  const breaker: BreakerConfig = {
    failureThreshold: num("circuit_breaker.failure_threshold", bRaw.failure_threshold, 3),
    openDurationSec: num("circuit_breaker.open_duration_sec", bRaw.open_duration_sec, 300),
  };

  const eventsRaw = raw.events;
  if (!isObject(eventsRaw)) throw new ConfigError("'events' must be an object");
  const events: Record<string, Action[]> = {};
  for (const [key, val] of Object.entries(eventsRaw)) {
    if (!key.startsWith(EVENT_PREFIX)) continue;
    const actions = parseActions(key, val);
    if (actions.length) events[key] = actions;
  }
  if (Object.keys(events).length === 0) {
    throw new ConfigError('at least one events.on_<event> with an action is required (e.g. events.on_stop)');
  }

  const quietHours = parseQuietHours(raw.quiet_hours);

  return { ha: { url, token, verifySsl }, timeouts, breaker, events, quietHours };
}

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Paths } from "./paths.ts";
import { loadConfig, ConfigError } from "./config.ts";
import { CircuitBreaker } from "./circuitBreaker.ts";
import { HookLogger } from "./logger.ts";
import { callService } from "./haClient.ts";

function findDisableMarker(start: string): string | null {
  let current = resolve(start);
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const candidate = join(current, ".no-hass-hook");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function runHook(
  event: string,
  stdinText: string,
  env: NodeJS.ProcessEnv,
  paths: Paths,
): Promise<number> {
  if (env.AGENT_HASS_HOOK_DISABLE === "1") return 0;

  let logger: HookLogger;
  try {
    logger = new HookLogger(paths.logPath);
  } catch (e) {
    process.stderr.write(`agent-hass-hook: cannot initialize state (${String((e as Error).message ?? e)})\n`);
    return 0;
  }

  try {
    return await runHookBody(event, stdinText, env, paths, logger);
  } catch (e) {
    // ConfigError is already handled (logged + returns 0) inside runHookBody, so
    // anything reaching here is an unexpected/catastrophic failure (e.g. breaker
    // state dir unwritable). Emit one concise line instead of a stack and exit 0.
    process.stderr.write(`agent-hass-hook: cannot initialize state (${String((e as Error).message ?? e)})\n`);
    return 0;
  }
}

async function runHookBody(
  event: string,
  stdinText: string,
  env: NodeJS.ProcessEnv,
  paths: Paths,
  logger: HookLogger,
): Promise<number> {
  let payload: Record<string, unknown> = {};
  if (stdinText.trim()) {
    try {
      const parsed = JSON.parse(stdinText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
    } catch { /* ignore non-JSON stdin */ }
  }
  const cwd = (typeof payload.cwd === "string" && payload.cwd) || process.cwd();

  const marker = findDisableMarker(cwd);
  if (marker) {
    logger.log({ event, cwd, result: "skipped", reason: "project_disabled", marker });
    return 0;
  }

  let cfg;
  try {
    cfg = loadConfig(paths.configPath, env);
  } catch (e) {
    if (e instanceof ConfigError) {
      logger.log({ event, cwd, result: "failed", error: "config_error", detail: e.message });
      process.stderr.write(`agent-hass-hook: config error: ${e.message}\n`);
      return 0;
    }
    throw e;
  }

  const actions = cfg.events[event] ?? [];
  if (actions.length === 0) return 0; // silent no-op, no breaker file

  const breaker = new CircuitBreaker(paths.breakerPath, cfg.breaker.failureThreshold, cfg.breaker.openDurationSec);
  if (breaker.shouldSkip()) {
    logger.log({ event, cwd, result: "skipped", reason: "breaker_open" });
    return 0;
  }

  let anyFailure = false;
  for (const action of actions) {
    let r;
    try {
      r = await callService(cfg.ha.url, cfg.ha.token, action.service, action.data, {
        connectMs: cfg.timeouts.connectMs,
        readMs: cfg.timeouts.readMs,
        verifySsl: cfg.ha.verifySsl,
      });
    } catch (e) {
      anyFailure = true;
      logger.log({ event, cwd, result: "failed", service: action.service, error: "call_error", detail: String((e as Error).message ?? e) });
      continue;
    }
    if (r.ok) {
      logger.log({ event, cwd, result: "ok", service: action.service, status: r.status, duration_ms: r.durationMs });
    } else {
      anyFailure = true;
      logger.log({ event, cwd, result: "failed", service: action.service, error: r.error, status: r.status, duration_ms: r.durationMs });
    }
  }

  if (anyFailure) breaker.recordFailure();
  else breaker.recordSuccess();
  return 0;
}

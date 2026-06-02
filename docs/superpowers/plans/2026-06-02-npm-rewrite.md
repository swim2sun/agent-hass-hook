# npm/Node Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite agent-hass-hook from a Python+bash tool into a single scoped npm package `@swim2sun/agent-hass-hook` that is both an `npx` interactive configurator and the per-event hook runtime.

**Architecture:** One npm package, one `bin` (`agent-hass-hook`) dispatched by subcommand: no-args launches a `@clack/prompts` wizard (configure/uninstall); `hook <event>` runs the runtime (load config → dispatch event→actions → call Home Assistant). TypeScript compiled to `dist/` (ESM); the hook registration in `settings.json` points at the absolute compiled entry path, not `npx`, to keep per-fire cold start minimal.

**Tech Stack:** Node.js >= 18 (native `fetch` not used for HA calls — `node:http`/`node:https` are used directly to preserve split connect/read timeouts), TypeScript, `@clack/prompts` (runtime dep, lazy-loaded only for the configurator), `node:test` + `tsx` (dev) for tests.

---

## File Structure

```
package.json            name @swim2sun/agent-hass-hook, bin, files: ["dist"], engines.node>=18, type: module
tsconfig.json           ESM, outDir dist, strict
src/
  bin.ts                entry: route `hook <event>` to runtime, else lazy-load configurator
  paths.ts              XDG config/state path resolution + env overrides
  config.ts             load/validate config.json, env overrides, events map
  presets.ts            preset A/C → events template (pure)
  circuitBreaker.ts     persisted breaker state machine
  logger.ts             JSONL append + size rotation
  haClient.ts           HA REST call with split connect/read timeouts (node:http/https)
  dispatch.ts           runtime orchestration (disable, marker, breaker, call, log)
  settings.ts           settings.json idempotent merge + .bak + uninstall removal
  configurator.ts       clack wizard: discover → pick entity → pick preset → write config → register
test/
  *.test.ts             node:test files, run via tsx
```

Runtime path (`hook <event>`) must NOT import `configurator.ts` or `@clack/prompts` — keep cold start lean. `bin.ts` lazy-imports the configurator only when no `hook` subcommand is given.

Config schema (`~/.config/agent-hass-hook/config.json`):

```jsonc
{
  "ha": { "url": "http://host:8123/", "token": "...", "verify_ssl": true },
  "timeouts": { "connect_ms": 300, "read_ms": 2000 },
  "circuit_breaker": { "failure_threshold": 3, "open_duration_sec": 300 },
  "events": {
    "on_stop": [ { "service": "light.turn_on", "data": { "entity_id": "light.x" } } ],
    "on_user_prompt_submit": [ { "service": "light.turn_off", "data": { "entity_id": "light.x" } } ]
  }
}
```

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore` (append), `src/bin.ts` (stub), `test/smoke.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@swim2sun/agent-hass-hook",
  "version": "0.1.0",
  "description": "Drive Home Assistant from Claude Code lifecycle hooks (Stop / UserPromptSubmit).",
  "type": "module",
  "bin": { "agent-hass-hook": "dist/bin.js" },
  "files": ["dist"],
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsc",
    "test": "node --import tsx --test test/*.test.ts",
    "prepublishOnly": "npm run build && npm test"
  },
  "dependencies": {
    "@clack/prompts": "^0.7.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Append build artifacts to `.gitignore`**

Append these lines to the existing `.gitignore`:

```
node_modules/
dist/
```

- [ ] **Step 4: Write `src/bin.ts` stub**

```typescript
#!/usr/bin/env node
async function main(argv: string[]): Promise<number> {
  if (argv[0] === "hook") {
    return 0; // runtime wired up in a later task
  }
  return 0; // configurator wired up in a later task
}
main(process.argv.slice(2)).then((code) => process.exit(code));
```

- [ ] **Step 5: Write `test/smoke.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";

test("smoke: test runner works", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 6: Install deps and run build + test**

Run: `npm install && npm run build && npm test`
Expected: build emits `dist/bin.js`; test prints `tests 1 ... pass 1`.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore src/bin.ts test/smoke.test.ts package-lock.json
git commit -m "chore: scaffold npm/TS project for @swim2sun/agent-hass-hook"
```

---

## Task 2: `paths.ts` — XDG paths + env overrides

Ports `default_paths()` from `core/agent_hass_hook.py:55-60`.

**Files:**
- Create: `src/paths.ts`, `test/paths.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePaths } from "../src/paths.ts";

test("defaults use XDG home layout", () => {
  const p = resolvePaths({ HOME: "/home/u" });
  assert.equal(p.configPath, "/home/u/.config/agent-hass-hook/config.json");
  assert.equal(p.stateDir, "/home/u/.local/state/agent-hass-hook");
  assert.equal(p.logPath, "/home/u/.local/state/agent-hass-hook/hook.log");
  assert.equal(p.breakerPath, "/home/u/.local/state/agent-hass-hook/breaker.json");
});

test("XDG_CONFIG_HOME / XDG_STATE_HOME respected", () => {
  const p = resolvePaths({ HOME: "/home/u", XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/st" });
  assert.equal(p.configPath, "/cfg/agent-hass-hook/config.json");
  assert.equal(p.stateDir, "/st/agent-hass-hook");
});

test("explicit env overrides win", () => {
  const p = resolvePaths({
    HOME: "/home/u",
    AGENT_HASS_HOOK_CONFIG: "/tmp/c.json",
    AGENT_HASS_HOOK_STATE_DIR: "/tmp/state",
  });
  assert.equal(p.configPath, "/tmp/c.json");
  assert.equal(p.stateDir, "/tmp/state");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/paths.test.ts`
Expected: FAIL (`resolvePaths` not found).

- [ ] **Step 3: Write `src/paths.ts`**

```typescript
import { join } from "node:path";

export interface Paths {
  configPath: string;
  stateDir: string;
  logPath: string;
  breakerPath: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv): Paths {
  const home = env.HOME ?? "";
  const configHome = env.XDG_CONFIG_HOME ?? join(home, ".config");
  const stateHome = env.XDG_STATE_HOME ?? join(home, ".local", "state");

  const configPath = env.AGENT_HASS_HOOK_CONFIG ?? join(configHome, "agent-hass-hook", "config.json");
  const stateDir = env.AGENT_HASS_HOOK_STATE_DIR ?? join(stateHome, "agent-hass-hook");

  return {
    configPath,
    stateDir,
    logPath: join(stateDir, "hook.log"),
    breakerPath: join(stateDir, "breaker.json"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/paths.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts test/paths.test.ts
git commit -m "feat(paths): XDG path resolution with env overrides"
```

---

## Task 3: `config.ts` — load/validate config.json

Ports `core/config.py`. JSON instead of TOML; same env overrides and validation.

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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

test("malformed JSON throws ConfigError", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahh-"));
  const p = join(dir, "config.json");
  writeFileSync(p, "{ not json");
  assert.throws(() => loadConfig(p, {}), ConfigError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/config.test.ts`
Expected: FAIL (`loadConfig` not found).

- [ ] **Step 3: Write `src/config.ts`**

```typescript
import { readFileSync } from "node:fs";

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
}

const EVENT_PREFIX = "on_";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function envBool(value: string): boolean {
  return !["false", "0", "no", "off", ""].includes(value.trim().toLowerCase());
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
  const token = env.AGENT_HASS_HOOK_HA_TOKEN || (haRaw.token as string | undefined);
  if (!token) throw new ConfigError("ha.token is required (or set AGENT_HASS_HOOK_HA_TOKEN)");

  const verifyEnv = env.AGENT_HASS_HOOK_HA_VERIFY_SSL;
  const verifySsl = verifyEnv !== undefined ? envBool(verifyEnv) : haRaw.verify_ssl !== false;

  const tRaw = isObject(raw.timeouts) ? raw.timeouts : {};
  const timeouts: Timeouts = {
    connectMs: Number(tRaw.connect_ms ?? 300),
    readMs: Number(tRaw.read_ms ?? 2000),
  };

  const bRaw = isObject(raw.circuit_breaker) ? raw.circuit_breaker : {};
  const breaker: BreakerConfig = {
    failureThreshold: Number(bRaw.failure_threshold ?? 3),
    openDurationSec: Number(bRaw.open_duration_sec ?? 300),
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

  return { ha: { url, token, verifySsl }, timeouts, breaker, events };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/config.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): load/validate config.json with env overrides"
```

---

## Task 4: `presets.ts` — preset A/C rendering

Ports `core/presets.py`.

**Files:**
- Create: `src/presets.ts`, `test/presets.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/presets.test.ts`
Expected: FAIL (`render` not found).

- [ ] **Step 3: Write `src/presets.ts`**

```typescript
import type { Action } from "./config.ts";

export const PRESETS = ["A", "C"] as const;
export type Preset = (typeof PRESETS)[number];

export interface RenderOpts { warmKelvin?: number; coolKelvin?: number; }

export function render(preset: Preset, entity: string, opts: RenderOpts = {}): Record<string, Action[]> {
  const warm = opts.warmKelvin ?? 2700;
  const cool = opts.coolKelvin ?? 6500;
  if (preset === "A") {
    return {
      on_user_prompt_submit: [{ service: "light.turn_off", data: { entity_id: entity } }],
      on_stop: [{ service: "light.turn_on", data: { entity_id: entity } }],
    };
  }
  if (preset === "C") {
    return {
      on_user_prompt_submit: [
        { service: "light.turn_on", data: { entity_id: entity, color_temp_kelvin: warm, brightness_pct: 50 } },
      ],
      on_stop: [
        { service: "light.turn_on", data: { entity_id: entity, color_temp_kelvin: cool, brightness_pct: 100 } },
      ],
    };
  }
  throw new Error(`unknown preset ${String(preset)} (expected one of ${PRESETS.join(", ")})`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/presets.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/presets.ts test/presets.test.ts
git commit -m "feat(presets): preset A/C → events templates"
```

---

## Task 5: `circuitBreaker.ts`

Ports `core/circuit_breaker.py`. Injectable `now()` for deterministic tests.

**Files:**
- Create: `src/circuitBreaker.ts`, `test/circuitBreaker.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/circuitBreaker.test.ts`
Expected: FAIL (`CircuitBreaker` not found).

- [ ] **Step 3: Write `src/circuitBreaker.ts`**

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private trippedAt: number | null = null;

  constructor(
    private readonly statePath: string,
    private readonly failureThreshold = 3,
    private readonly openDurationSec = 300,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {
    mkdirSync(dirname(statePath), { recursive: true });
    this.load();
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf-8"));
      this.consecutiveFailures = Number(raw.consecutive_failures ?? 0);
      this.trippedAt = raw.tripped_at != null ? Number(raw.tripped_at) : null;
    } catch {
      /* corrupt state — treat as closed */
    }
  }

  private save(): void {
    const payload = { consecutive_failures: this.consecutiveFailures, tripped_at: this.trippedAt };
    try {
      const tmp = this.statePath + ".tmp";
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, this.statePath);
    } catch {
      /* best effort */
    }
  }

  shouldSkip(): boolean {
    if (this.trippedAt === null) return false;
    return this.now() - this.trippedAt < this.openDurationSec;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.trippedAt = null;
    this.save();
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.trippedAt = this.now();
    }
    this.save();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/circuitBreaker.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/circuitBreaker.ts test/circuitBreaker.test.ts
git commit -m "feat(breaker): persisted circuit breaker state machine"
```

---

## Task 6: `logger.ts` — JSONL + rotation

Ports `core/logger.py`. Injectable `now()` returning the ISO timestamp.

**Files:**
- Create: `src/logger.ts`, `test/logger.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/logger.test.ts`
Expected: FAIL (`HookLogger` not found).

- [ ] **Step 3: Write `src/logger.ts`**

```typescript
import { existsSync, mkdirSync, statSync, renameSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

export class HookLogger {
  constructor(
    private readonly logPath: string,
    private readonly maxBytes = 1_000_000,
    private readonly now: () => string = utcNowIso,
  ) {
    mkdirSync(dirname(logPath), { recursive: true });
    this.maybeRotate();
  }

  private maybeRotate(): void {
    if (!existsSync(this.logPath)) return;
    try {
      if (statSync(this.logPath).size <= this.maxBytes) return;
      renameSync(this.logPath, this.logPath + ".1");
    } catch {
      /* best effort */
    }
  }

  log(fields: Record<string, unknown>): void {
    const record = { ts: this.now(), ...fields };
    try {
      appendFileSync(this.logPath, JSON.stringify(record) + "\n", "utf-8");
    } catch {
      /* never throw from logging */
    }
  }
}

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/logger.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts test/logger.test.ts
git commit -m "feat(logger): JSONL logging with size rotation"
```

---

## Task 7: `haClient.ts` — HA call with split connect/read timeouts

Ports `core/ha_client.py`. Uses `node:http`/`node:https` directly (NOT `fetch`) so the connect deadline and the read deadline are independent, matching the Python behavior (dead HA fails fast on `connect_ms`; slow-but-alive HA gets `read_ms`).

**Files:**
- Create: `src/haClient.ts`, `test/haClient.test.ts`

- [ ] **Step 1: Write the failing test (uses a local http server as mock HA)**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { callService } from "../src/haClient.ts";

function startServer(handler: (url: string, body: string) => { status: number }): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { status } = handler(req.url ?? "", body);
        res.writeHead(status);
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

test("2xx → ok, posts to /api/services/<domain>/<service>", async () => {
  let seenUrl = "";
  let seenBody = "";
  const srv = await startServer((url, body) => { seenUrl = url; seenBody = body; return { status: 200 }; });
  const r = await callService(srv.url, "tok", "light.turn_on", { entity_id: "light.x" }, { connectMs: 300, readMs: 2000 });
  srv.close();
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(seenUrl, "/api/services/light/turn_on");
  assert.deepEqual(JSON.parse(seenBody), { entity_id: "light.x" });
});

test("4xx → not ok with http_4xx", async () => {
  const srv = await startServer(() => ({ status: 401 }));
  const r = await callService(srv.url, "tok", "light.turn_on", {}, { connectMs: 300, readMs: 2000 });
  srv.close();
  assert.equal(r.ok, false);
  assert.equal(r.error, "http_4xx");
  assert.equal(r.status, 401);
});

test("connection refused → connection_error", async () => {
  // port 1 is reserved / not listening
  const r = await callService("http://127.0.0.1:1", "tok", "light.turn_on", {}, { connectMs: 300, readMs: 2000 });
  assert.equal(r.ok, false);
  assert.ok(r.error === "connection_error" || r.error === "timeout");
});

test("preserves reverse-proxy path prefix", async () => {
  let seenUrl = "";
  const srv = await startServer((url) => { seenUrl = url; return { status: 200 }; });
  await callService(srv.url + "/ha", "tok", "light.turn_on", {}, { connectMs: 300, readMs: 2000 });
  srv.close();
  assert.equal(seenUrl, "/ha/api/services/light/turn_on");
});

test("rejects bad service shape", async () => {
  await assert.rejects(() => callService("http://h", "t", "bogus", {}, { connectMs: 300, readMs: 2000 }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/haClient.test.ts`
Expected: FAIL (`callService` not found).

- [ ] **Step 3: Write `src/haClient.ts`**

```typescript
import { request as httpRequest } from "node:http";
import { request as httpsRequest, RequestOptions } from "node:https";

export interface HAResult {
  ok: boolean;
  error?: "timeout" | "connection_error" | "http_4xx" | "http_5xx";
  status?: number;
  durationMs?: number;
}

export interface CallTimeouts { connectMs: number; readMs: number; verifySsl?: boolean; }

export function callService(
  url: string,
  token: string,
  service: string,
  data: Record<string, unknown>,
  t: CallTimeouts,
): Promise<HAResult> {
  if (!service.includes(".")) {
    return Promise.reject(new Error(`service must be "domain.service", got ${JSON.stringify(service)}`));
  }
  const [domain, svc] = service.split(/\.(.*)/s) as [string, string];

  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Promise.reject(new Error(`unsupported URL scheme: ${url}`));
  }
  const isHttps = parsed.protocol === "https:";
  const prefix = parsed.pathname.replace(/\/+$/, "");
  const path = `${prefix}/api/services/${domain}/${svc}`;
  const body = Buffer.from(JSON.stringify(data), "utf-8");

  const options: RequestOptions = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
    },
    ...(isHttps && t.verifySsl === false ? { rejectUnauthorized: false } : {}),
  };

  return new Promise<HAResult>((resolve) => {
    const start = process.hrtime.bigint();
    const elapsedMs = () => Number(process.hrtime.bigint() - start) / 1e6;
    let settled = false;
    const done = (r: HAResult) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      resolve({ ...r, durationMs: Math.round(elapsedMs()) });
    };

    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(options, (res) => {
      // switch to the read timeout once connected
      req.setTimeout(t.readMs, () => done({ ok: false, error: "timeout" }));
      res.on("data", () => { /* drain */ });
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) return done({ ok: true, status });
        return done({ ok: false, error: status >= 400 && status < 500 ? "http_4xx" : "http_5xx", status });
      });
    });

    // connect timeout: applies until the socket connects
    req.setTimeout(t.connectMs, () => done({ ok: false, error: "timeout" }));
    req.on("socket", (socket) => {
      socket.on("connect", () => req.setTimeout(t.readMs, () => done({ ok: false, error: "timeout" })));
    });
    req.on("error", () => done({ ok: false, error: "connection_error" }));
    req.write(body);
    req.end();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/haClient.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/haClient.ts test/haClient.test.ts
git commit -m "feat(ha): HA REST client with split connect/read timeouts"
```

---

## Task 8: `dispatch.ts` — runtime orchestration

Ports `core/agent_hass_hook.py:main` (minus the env-restore dance, which is unnecessary in Node since we pass env explicitly). Preserves: `AGENT_HASS_HOOK_DISABLE` fast exit, `.no-hass-hook` marker walk-up using stdin `cwd`, empty-event fast path BEFORE breaker, breaker skip, per-action HA call + log, success/failure recording, always returns 0.

**Files:**
- Create: `src/dispatch.ts`, `test/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { runHook } from "../src/dispatch.ts";

function tmp(): string { return mkdtempSync(join(tmpdir(), "ahh-")); }

function paths(dir: string, cfgPath: string) {
  return { configPath: cfgPath, stateDir: dir, logPath: join(dir, "hook.log"), breakerPath: join(dir, "breaker.json") };
}

async function mockHA(status = 200): Promise<{ url: string; calls: string[]; close: () => void }> {
  const calls: string[] = [];
  return await new Promise((resolve) => {
    const server = createServer((req, res) => { calls.push(req.url ?? ""); res.writeHead(status); res.end("{}"); });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, calls, close: () => server.close() });
    });
  });
}

test("AGENT_HASS_HOOK_DISABLE=1 exits 0 without calling HA", async () => {
  const dir = tmp();
  const code = await runHook("on_stop", "", { AGENT_HASS_HOOK_DISABLE: "1" }, paths(dir, "/nope.json"));
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, "hook.log")), false);
});

test(".no-hass-hook marker in cwd skips", async () => {
  const dir = tmp();
  const proj = tmp();
  writeFileSync(join(proj, ".no-hass-hook"), "");
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ ha: { url: "http://h", token: "t" }, events: { on_stop: [{ service: "light.turn_on", data: {} }] } }));
  const code = await runHook("on_stop", JSON.stringify({ cwd: proj }), {}, paths(dir, cfg));
  assert.equal(code, 0);
  const log = readFileSync(join(dir, "hook.log"), "utf-8");
  assert.ok(log.includes("project_disabled"));
});

test("empty event = no-op, no breaker file written", async () => {
  const dir = tmp();
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ ha: { url: "http://h", token: "t" }, events: { on_stop: [{ service: "light.turn_on", data: {} }] } }));
  const code = await runHook("on_user_prompt_submit", "", {}, paths(dir, cfg));
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, "breaker.json")), false);
});

test("happy path calls HA and logs ok", async () => {
  const dir = tmp();
  const ha = await mockHA(200);
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ ha: { url: ha.url, token: "t" }, events: { on_stop: [{ service: "light.turn_on", data: { entity_id: "light.x" } }] } }));
  const code = await runHook("on_stop", "", {}, paths(dir, cfg));
  ha.close();
  assert.equal(code, 0);
  assert.deepEqual(ha.calls, ["/api/services/light/turn_on"]);
  assert.ok(readFileSync(join(dir, "hook.log"), "utf-8").includes('"result":"ok"'));
});

test("config error logged, returns 0", async () => {
  const dir = tmp();
  const code = await runHook("on_stop", "", {}, paths(dir, join(dir, "missing.json")));
  assert.equal(code, 0);
  assert.ok(readFileSync(join(dir, "hook.log"), "utf-8").includes("config_error"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/dispatch.test.ts`
Expected: FAIL (`runHook` not found).

- [ ] **Step 3: Write `src/dispatch.ts`**

```typescript
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

  const logger = new HookLogger(paths.logPath);

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
    const r = await callService(cfg.ha.url, cfg.ha.token, action.service, action.data, {
      connectMs: cfg.timeouts.connectMs,
      readMs: cfg.timeouts.readMs,
      verifySsl: cfg.ha.verifySsl,
    });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/dispatch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch.ts test/dispatch.test.ts
git commit -m "feat(dispatch): runtime orchestration (disable/marker/breaker/call/log)"
```

---

## Task 9: `settings.ts` — settings.json merge + uninstall

Ports the settings-merge logic in `install.sh` and the removal logic in `uninstall.sh`. Pure functions over a parsed settings object so they are unit-testable; thin file I/O wrappers on top.

**Files:**
- Create: `src/settings.ts`, `test/settings.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerEvents, removeOurHooks, EVENT_MAP } from "../src/settings.ts";

// Realistic installed path: always contains the package name, which is what
// removeOurHooks keys on. (A bare "/abs/dist/bin.js" would not be detected.)
const CMD = "/home/u/.npm/@swim2sun/agent-hass-hook/dist/bin.js";

test("registerEvents adds Stop + UserPromptSubmit idempotently", () => {
  let s: any = {};
  s = registerEvents(s, ["on_stop", "on_user_prompt_submit"], CMD);
  assert.equal(s.hooks.Stop[0].hooks[0].command, `node ${CMD} hook on_stop`);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, `node ${CMD} hook on_user_prompt_submit`);
  // idempotent: second call does not duplicate
  s = registerEvents(s, ["on_stop"], CMD);
  assert.equal(s.hooks.Stop.length, 1);
});

test("registerEvents preserves unrelated hooks", () => {
  const s: any = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }] } };
  const out = registerEvents(s, ["on_stop"], CMD);
  const cmds = out.hooks.Stop.flatMap((e: any) => e.hooks.map((h: any) => h.command));
  assert.ok(cmds.includes("other"));
  assert.ok(cmds.includes(`node ${CMD} hook on_stop`));
});

test("removeOurHooks strips only our entries across all events", () => {
  const s: any = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: `node ${CMD} hook on_stop` }, { type: "command", command: "keepme" }] }],
      UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: `node ${CMD} hook on_user_prompt_submit` }] }],
    },
  };
  const out = removeOurHooks(s);
  assert.deepEqual(out.hooks.Stop[0].hooks.map((h: any) => h.command), ["keepme"]);
  assert.equal(out.hooks.UserPromptSubmit, undefined); // emptied → key removed
});

test("EVENT_MAP maps known events", () => {
  assert.equal(EVENT_MAP.on_stop, "Stop");
  assert.equal(EVENT_MAP.on_user_prompt_submit, "UserPromptSubmit");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/settings.test.ts`
Expected: FAIL (`registerEvents` not found).

- [ ] **Step 3: Write `src/settings.ts`**

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

export const EVENT_MAP: Record<string, string> = {
  on_stop: "Stop",
  on_user_prompt_submit: "UserPromptSubmit",
};

interface HookCmd { type: string; command: string; }
interface HookEntry { matcher?: string; hooks?: HookCmd[]; }
interface Settings { hooks?: Record<string, HookEntry[]>; [k: string]: unknown; }

function ourCommand(cmd: string | undefined): boolean {
  const c = cmd ?? "";
  return c.includes("agent-hass-hook") && (c.includes("/bin.js") || c.includes("hook.sh") || c.includes("stop.sh"));
}

export function registerEvents(settings: Settings, events: string[], binPath: string): Settings {
  const hooks = settings.hooks ?? (settings.hooks = {});
  for (const ev of events) {
    const claude = EVENT_MAP[ev];
    if (!claude) continue;
    const cmd = `node ${binPath} hook ${ev}`;
    const arr = hooks[claude] ?? (hooks[claude] = []);
    const existing = arr.flatMap((e) => (e.hooks ?? []).map((h) => h.command));
    if (!existing.includes(cmd)) {
      arr.push({ matcher: "", hooks: [{ type: "command", command: cmd }] });
    }
  }
  return settings;
}

export function removeOurHooks(settings: Settings): Settings {
  const hooks = settings.hooks ?? {};
  for (const [event, arr] of Object.entries(hooks)) {
    if (!Array.isArray(arr)) continue;
    const newArr: HookEntry[] = [];
    for (const entry of arr) {
      const kept = (entry.hooks ?? []).filter((h) => !ourCommand(h.command));
      if (kept.length) newArr.push({ ...entry, hooks: kept });
    }
    if (newArr.length) hooks[event] = newArr;
    else delete hooks[event];
  }
  return settings;
}

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function writeSettings(path: string, settings: Settings, backup = true): void {
  mkdirSync(dirname(path), { recursive: true });
  if (backup && existsSync(path)) copyFileSync(path, path + ".bak-agent-hass-hook");
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/settings.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts test/settings.test.ts
git commit -m "feat(settings): idempotent settings.json merge + uninstall removal"
```

---

## Task 10: `configurator.ts` — pure helpers + clack wizard

The wizard itself is interactive (hard to unit-test), so split the testable pure logic into exported helpers and keep the clack flow thin. Helpers tested here: `discoverLights` (parse `/api/states` JSON into pickable rows), `renderConfigJson` (preset → config.json object), `resolveBinPath`.

**Files:**
- Create: `src/configurator.ts`, `test/configurator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLights, renderConfigJson } from "../src/configurator.ts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/configurator.test.ts`
Expected: FAIL (`parseLights` not found).

- [ ] **Step 3: Write `src/configurator.ts`**

```typescript
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
      supportsColorTemp: (a.supported_color_modes ?? []).includes("color_temp"),
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
```

- [ ] **Step 4: Create `src/configFile.ts` (0600 config writer, used by the configurator)**

```typescript
import { openSync, fchmodSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Writes config.json with 0600 perms, forcing perms even if the file pre-existed.
export function writeConfig(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify(obj, null, 2) + "\n");
  } finally {
    closeSync(fd);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test test/configurator.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/configurator.ts src/configFile.ts test/configurator.test.ts
git commit -m "feat(configurator): clack wizard + pure helpers + 0600 config writer"
```

---

## Task 11: `bin.ts` — entry point wiring

Replace the stub. Routes `hook <event>` to the runtime (reading stdin), `uninstall` to settings removal, anything else to the configurator (lazy-imported so the runtime path never loads clack).

**Files:**
- Modify: `src/bin.ts`
- Create: `test/bin.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Runs the real entry via tsx so stdin handling is exercised end-to-end.
function runBin(args: string[], stdin: string, env: Record<string, string>): string {
  return execFileSync("node", ["--import", "tsx", "src/bin.ts", ...args], {
    input: stdin,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

test("hook event with no config for that event is a silent no-op (exit 0)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahh-"));
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ ha: { url: "http://h", token: "t" }, events: { on_stop: [{ service: "light.turn_on", data: {} }] } }));
  // on_user_prompt_submit not configured → no-op, exit 0, no throw
  runBin(["hook", "on_user_prompt_submit"], "", { AGENT_HASS_HOOK_CONFIG: cfg, AGENT_HASS_HOOK_STATE_DIR: dir });
});

test("disable env short-circuits", () => {
  runBin(["hook", "on_stop"], "", { AGENT_HASS_HOOK_DISABLE: "1" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/bin.test.ts`
Expected: FAIL (the stub never reads stdin / no runtime wired).

- [ ] **Step 3: Write `src/bin.ts`**

```typescript
#!/usr/bin/env node
import { resolvePaths } from "./paths.ts";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function main(argv: string[]): Promise<number> {
  const paths = resolvePaths(process.env);

  if (argv[0] === "hook") {
    const { runHook } = await import("./dispatch.ts");
    const event = argv[1] ?? "on_stop";
    const stdinText = await readStdin();
    return runHook(event, stdinText, process.env, paths);
  }

  if (argv[0] === "uninstall") {
    const { readSettings, removeOurHooks, writeSettings } = await import("./settings.ts");
    const settingsPath = `${process.env.HOME}/.claude/settings.json`;
    writeSettings(settingsPath, removeOurHooks(readSettings(settingsPath)));
    process.stdout.write("agent-hass-hook: removed hooks from settings.json\n");
    return 0;
  }

  const { runConfigurator } = await import("./configurator.ts");
  return runConfigurator(paths);
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`agent-hass-hook: ${e?.stack ?? e}\n`);
  process.exit(0); // never block Claude Code on a hook crash
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/bin.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite + build**

Run: `npm run build && npm test`
Expected: build clean; all test files pass.

- [ ] **Step 6: Commit**

```bash
git add src/bin.ts test/bin.test.ts
git commit -m "feat(bin): entry point routing (hook runtime / uninstall / configurator)"
```

---

## Task 12: End-to-end smoke test

Mirrors the old `tests/test_e2e.sh`: build, write a config pointing at a local mock HA, run the compiled `dist/bin.js hook on_stop`, assert the service was called and `ok` logged.

**Files:**
- Create: `test/e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("e2e: dist/bin.js hook on_stop calls HA and logs ok", async () => {
  assert.ok(existsSync("dist/bin.js"), "run `npm run build` first");
  const calls: string[] = [];
  const server = createServer((req, res) => { calls.push(req.url ?? ""); res.writeHead(200); res.end("{}"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const dir = mkdtempSync(join(tmpdir(), "ahh-e2e-"));
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({
    ha: { url: `http://127.0.0.1:${port}`, token: "t" },
    events: { on_stop: [{ service: "light.turn_on", data: { entity_id: "light.x" } }] },
  }));

  execFileSync("node", ["dist/bin.js", "hook", "on_stop"], {
    input: JSON.stringify({ cwd: dir }),
    env: { ...process.env, AGENT_HASS_HOOK_CONFIG: cfg, AGENT_HASS_HOOK_STATE_DIR: dir },
  });
  server.close();

  assert.deepEqual(calls, ["/api/services/light/turn_on"]);
  assert.ok(readFileSync(join(dir, "hook.log"), "utf-8").includes('"result":"ok"'));
});
```

- [ ] **Step 2: Build then run**

Run: `npm run build && node --import tsx --test test/e2e.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3: Commit**

```bash
git add test/e2e.test.ts
git commit -m "test(e2e): compiled bin drives mock HA end-to-end"
```

---

## Task 13: README + remove Python/bash

Update docs for the npx workflow and remove the now-replaced Python core, bash adapters, TOML example, and shell installers (recoverable from git history).

**Files:**
- Modify: `README.md`
- Delete: `core/`, `adapters/`, `install.sh`, `uninstall.sh`, `config.example.toml`, `tests/` (Python tests + e2e shell)

- [ ] **Step 1: Rewrite `README.md`**

Replace the install/usage sections so the primary flow is:

````markdown
## Install

```bash
npx @swim2sun/agent-hass-hook
```

The interactive setup connects to Home Assistant, discovers your lights, lets you
pick a behavior preset (A: off-while-working / on-when-done, or C: warm-dim →
cool-bright), writes `~/.config/agent-hass-hook/config.json` (chmod 600), and
registers the `Stop` + `UserPromptSubmit` hooks in `~/.claude/settings.json`.

## Uninstall

```bash
npx @swim2sun/agent-hass-hook uninstall
```

## Disable

- Per session: `export AGENT_HASS_HOOK_DISABLE=1`
- Per project: `touch .no-hass-hook` at the project root

## How it works

The registered hook command is `node <abs path>/dist/bin.js hook on_stop`
(and `... on_user_prompt_submit`). On each event it loads the config, looks up
that event's action list, and calls the Home Assistant REST API. Presets are
just templates that fill in the generic `events` map — the runtime has no notion
of "modes", so custom setups are first-class (hand-edit `config.json`).

Logs: `~/.local/state/agent-hass-hook/hook.log` (JSONL).
````

- [ ] **Step 2: Delete the legacy implementation**

```bash
git rm -r core adapters tests install.sh uninstall.sh config.example.toml
```

- [ ] **Step 3: Build + full test suite (proves nothing depended on deleted files)**

Run: `npm run build && npm test`
Expected: build clean; all `test/*.test.ts` pass.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: npx-first README; remove legacy Python/bash implementation"
```

---

## Task 14: Final verification

- [ ] **Step 1: Clean build from scratch**

Run: `rm -rf dist && npm run build && npm test`
Expected: build emits `dist/`, every test passes.

- [ ] **Step 2: Pack dry-run (publish readiness)**

Run: `npm pack --dry-run`
Expected: tarball contents are `dist/**` + `package.json` + `README.md` only (no `src`, no `test`, no `node_modules`).

- [ ] **Step 3: Manual smoke of the configurator help path**

Run: `node dist/bin.js uninstall`
Expected: prints "removed hooks from settings.json" and exits 0 (idempotent even if nothing registered).

- [ ] **Step 4: Final commit if anything changed**

```bash
git add -A && git commit -m "chore: final build/verify for npm rewrite" || echo "nothing to commit"
```

---

## Self-Review Notes (addressed)

- **Split connect/read timeout** preserved via `node:http`/`node:https` + `setTimeout` on connect vs. response (Task 7), not `fetch`.
- **`.no-hass-hook` marker walk-up** and **stdin `cwd`** preserved (Task 8) — these were in the Python runtime, not just the spec.
- **Env overrides** (`AGENT_HASS_HOOK_HA_URL/TOKEN/VERIFY_SSL`), **timeouts/circuit_breaker config sections**, **reverse-proxy path prefix**, **log rotation**, **0600 config**, **idempotent settings merge + .bak**, **uninstall across all event arrays** all covered (Tasks 3/7/9/10).
- **Runtime never imports clack** — `bin.ts` lazy-imports `configurator.ts` only on the non-hook path (Task 11).
- **DIY**: the generic `events` map IS the DIY hook (hand-edit `config.json`); the wizard offers A/C, custom = edit the file. README states this. No separate DIY code path needed for self-use scope.
- `EVENT_MAP`, `render`, `callService`, `runHook`, `registerEvents`/`removeOurHooks` names are consistent across tasks.

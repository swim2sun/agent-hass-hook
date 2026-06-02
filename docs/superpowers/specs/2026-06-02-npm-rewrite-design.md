# Design: Rewrite agent-hass-hook as an npm package (`@swim2sun/agent-hass-hook`)

Date: 2026-06-02
Status: Approved (pending user spec review)

## Problem

The current tool is a Python 3.11+ stdlib core + bash adapters + a 241-line
`install.sh`. Configuring it for a user's local environment (Home Assistant URL,
long-lived token, discovering the right entity, picking a behavior preset) is
fiddly and bash-driven. We want the distribution/configuration experience that
tools like [ccstatusline](https://github.com/sirmalloc/ccstatusline) offer:
an npm package run via `npx`, with a friendly interactive CLI that discovers
devices, picks a preset, captures the token, and wires up `settings.json`.

The dominant pattern in the Claude Code ecosystem (ccstatusline,
`@timoaus/define-claude-code-hooks`, the built-in `/hooks` command) is
"`npx` an interactive command that auto-edits `settings.json`". ccstatusline
achieves a clean experience because it is **Node end-to-end**: the `npx` package
is both the configurator and the runtime, one language, one dependency story.

Our Python runtime breaks that promise — npm users expect `npx foo` to work with
only Node installed, not an extra Python 3.11+ requirement. Therefore the
decision (confirmed with the user) is a **full rewrite of the runtime to
Node/TypeScript**, distributed as a single npm package.

## Decisions (confirmed)

- **Audience**: self-use primarily, but structured so it *can* be published for
  others. Build for publish-readiness; do not actually `npm publish` yet.
- **Runtime**: rewrite from Python to Node/TypeScript. The existing 52 pytest
  cases are dropped; key paths are re-covered with Node's built-in test runner.
- **Package name**: `@swim2sun/agent-hass-hook` (scoped to the user's GitHub id).
- **Interactive library**: `@clack/prompts` — a lightweight stepped wizard, not
  Ink. We don't need ccstatusline's real-time render preview; we need a linear
  wizard (discover → select entity → pick preset → enter token).
- **Hook invocation**: register an **absolute bin path** in `settings.json`
  (`node /abs/path/to/bin hook on_stop`), NOT `npx -y ...@latest` per-fire.
  Hooks fire on every Stop / prompt; `npx` cold-start on each fire is wasteful.
  `npx @swim2sun/agent-hass-hook` is used only for the one-time interactive
  configuration. The configurator installs the package (`npm i -g`) or resolves
  the local bin, then writes the resolved absolute path.
- **Config format**: TOML → JSON at `~/.config/agent-hass-hook/config.json`.
  Node has no native TOML; JSON is native and matches the ecosystem convention.
- **Python core**: kept in place during the rewrite as a reference, then
  **deleted on completion**. It is already committed, so it is recoverable from
  git history (`git checkout <rev> -- core/`) if ever needed — no `legacy/` dir.
- **Node engine**: `engines.node >= 18` (native `fetch` / `AbortController`).

## Architecture

Single npm package, single `bin`, dispatched by subcommand — mirroring
ccstatusline's single-entry-point design.

```
@swim2sun/agent-hass-hook
  bin: agent-hass-hook
    ├─ (no args)        → launch @clack interactive configurator (install/edit/uninstall)
    └─ hook <event>     → runtime: load config → dispatch actions → call HA
```

### Modules (TypeScript)

| Module             | Responsibility                                                        | Ported from               |
|--------------------|-----------------------------------------------------------------------|---------------------------|
| `config.ts`        | Load/validate `config.json`; build the event→actions map              | `core/config.py`          |
| `haClient.ts`      | HA REST calls via `fetch` + `AbortController` (300ms connect / 2s read)| `core/ha_client.py`       |
| `circuitBreaker.ts`| Circuit breaker; state persisted in the XDG state dir                 | `core/circuit_breaker.py` |
| `presets.ts`       | Render presets A/C into action lists                                  | `core/presets.py`         |
| `dispatch.ts`      | event → actions execution; empty event returns immediately (no breaker)| `core/agent_hass_hook.py` |
| `logger.ts`        | JSONL logging to the XDG state dir                                    | `core/logger.py`          |
| `configurator.ts`  | clack wizard: device discovery, preset selection, token capture, settings.json merge | `install.sh` |
| `paths.ts`         | XDG config/state path resolution                                      | (was inline in Python)    |
| `settings.ts`      | Idempotent `settings.json` read/merge/write + `.bak` backup; uninstall removal | `install.sh` / `uninstall.sh` |
| `bin.ts`           | Entry point; subcommand routing (`hook <event>` vs. configurator)     | `adapters/claude-code/hook.sh` |

### Data flow (runtime, `agent-hass-hook hook on_stop`)

1. Honor `AGENT_HASS_HOOK_DISABLE=1` → exit 0 immediately.
2. Load `config.json`; resolve `actions = events[event] ?? []`.
3. If no actions → exit 0 **before** constructing the circuit breaker (no
   breaker state file written for no-op events). Preserves the Python behavior.
4. Check circuit breaker; if open, log `skipped` and exit 0.
5. For each action, call HA (`POST /api/services/{domain}/{service}` with the
   entity + service data). Apply timeouts. On failure, record toward the breaker.
6. Append a JSONL log line (`ts`, `event`, `result`, `service`, ...).
7. Exit 0 regardless (hooks must not block Claude Code).

### Config schema (`config.json`)

```jsonc
{
  "ha": { "url": "http://192.168.15.114:8123", "token": "..." },
  "events": {
    "on_stop":               [ { "service": "light.turn_on",  "entity_id": "light.display_light", "data": { "color_temp_kelvin": 6500, "brightness_pct": 100 } } ],
    "on_user_prompt_submit": [ { "service": "light.turn_off", "entity_id": "light.display_light" } ]
  }
}
```

- `events` is a generic map; the runtime never knows about "presets/modes".
- Presets A/C are templates the configurator renders into this `events` map.
- File written with `0600` perms. Token captured via the wizard (masked input),
  never echoed, never passed as a CLI arg.

### Presets (rendered by the configurator into `events`)

- **A — work-off / done-on**: `on_user_prompt_submit` → `turn_off`;
  `on_stop` → `turn_on`. Default preset.
- **C — color-temp state**: `on_user_prompt_submit` → `turn_on` warm + dim 50%;
  `on_stop` → `turn_on` cool + bright 100%. Falls back to A if the selected
  entity does not support `color_temp`.
- **DIY**: wizard lets the user hand-edit the rendered `events` (or opens the
  config for manual editing) — leaves the architectural hook for custom actions.

### Configurator wizard (clack)

1. Prompt for HA URL.
2. Capture long-lived token (masked).
3. `GET /api/states` → discover `light.*` (and other actionable domains)
   entities; present a searchable picker. Show friendly_name.
4. Inspect the chosen entity's `supported_color_modes` to decide whether C is
   offered.
5. Preset picker: A (recommended) / C / DIY.
6. Render preset → `events`; write `config.json` (`0600`).
7. Verify the entity reachable (`GET /api/states/{entity}`).
8. Resolve absolute bin path; merge into `settings.json` for `Stop` +
   `UserPromptSubmit` events idempotently; back up to `.bak`.
9. Print summary + how to disable (`AGENT_HASS_HOOK_DISABLE=1`) + log location.

`settings.json` event mapping: `on_stop → Stop`,
`on_user_prompt_submit → UserPromptSubmit`.

## Preserved behaviors (ported one-for-one)

- Generic event→actions map; future events need no code change.
- Empty-event fast path (no breaker file for no-op events).
- Circuit breaker; XDG state/config paths; 300ms connect / 2s read timeouts.
- JSONL logging; `AGENT_HASS_HOOK_DISABLE=1` kill switch.
- `config.json` `0600`; token only via interactive input; entity URL-encoded
  in HA URLs.
- Idempotent `settings.json` merge across all event arrays; `.bak` backup.
- Uninstall scans all `.hooks.*` arrays and removes only this tool's commands.

## YAGNI / dropped

- Bash adapter layer (`hook.sh` / `stop.sh`) — the npm bin IS the adapter.
- jq dependency (was already removed from the bash installer; N/A in Node).
- Ink/React TUI and real-time preview — unnecessary for a linear wizard.
- Flashing/transition effects — the target lamp doesn't support them.

## Testing

Node built-in `node:test` (zero extra deps), covering the key paths:

- `config.ts`: parse/validate, event→actions mapping, backward-compat, errors.
- `presets.ts`: A and C rendering; C→A fallback when no `color_temp`.
- `circuitBreaker.ts`: open/close transitions, state persistence.
- `dispatch.ts`: empty-event fast path, action execution, disable switch.
- `haClient.ts`: request shaping, timeout behavior (mocked fetch).
- `settings.ts`: idempotent merge, `.bak`, uninstall removal.
- An e2e smoke test analogous to the existing `tests/test_e2e.sh`
  (config → `hook on_stop` → mocked HA endpoint).

## Publish readiness (not published yet)

- `package.json`: `name: "@swim2sun/agent-hass-hook"`, `bin`, `files`,
  `engines.node >= 18`, `type: "module"`, `prepublishOnly` runs the test suite.
- Ship **compiled JS** (tsc → `dist/`); `bin` points at the compiled entry, not
  a TS loader. Rationale: the hook runs per-event, so a runtime TS loader would
  add startup latency on every fire; compiled JS keeps cold start minimal and
  avoids a loader dependency. `files` ships `dist/` only.
- Target: `npx @swim2sun/agent-hass-hook` works on a fresh machine with only
  Node installed.

## Repo layout (after rewrite)

```
package.json
tsconfig.json
src/
  bin.ts  config.ts  haClient.ts  circuitBreaker.ts
  presets.ts  dispatch.ts  logger.ts  configurator.ts
  settings.ts  paths.ts
test/            (node:test files)
docs/superpowers/...
README.md        (updated for npx workflow)
```

# Design: Configurable behavior modes + guided install

**Date:** 2026-05-29
**Status:** Approved
**Supersedes parts of:** `2026-05-26-agent-hass-hook-design.md` (single-event MVP)

## Problem

The MVP only reacts to the `Stop` event with one hardcoded action (`light.turn_on`).
The light turns on when a task completes and stays on until manually turned off —
there is no "working" state, and no way to choose a different behavior without
hand-editing config. Users want:

1. A **default** behavior that distinguishes "working" from "done"
   (light off while working, on when done).
2. A small set of **recommended presets** to pick from.
3. **DIY** flexibility for arbitrary Home Assistant service calls.
4. A **friendly installer** that discovers devices and guides preset selection.

Positioning stays "self-use first, but leave clean hooks for product-grade later"
(benchmarking peon-ping, multi-tool support) — so the runtime must generalize
without gold-plating the installer.

## Approach (chosen)

**Presets are config templates, not a runtime concept.** The core understands
exactly one thing: `event → list of actions`. Preset "A"/"C" are templates the
installer expands into generic `[[on_<event>]]` config. This unifies presets and
DIY (both are the same event→actions config), keeps the runtime dumb and testable,
and makes adding a preset a template change rather than a core change.

Rejected alternatives:
- **First-class `mode` field** with per-mode logic in core — awkward DIY (two code
  paths), every new mode touches core, violates "leave clean hooks."
- **Hybrid (`mode` + overridable `[[on_*]]`)** — two sources of truth, over-designed.

## Architecture

### 1. Core: generic event dispatch

Today `core/agent_hass_hook.py` hardcodes `cfg.on_stop` (line ~123); the `event`
argument is only logged, not used to select actions. Change to:

- `Config` holds `events: dict[str, list[Action]]` keyed by config-event name
  (e.g. `"on_stop"`, `"on_user_prompt_submit"`).
- `main(event, ...)` runs `cfg.events.get(event, [])`. **An event with no
  configured actions is a no-op that exits 0** (not an error).
- The **circuit breaker is shared** across events (one `breaker.json`): if HA is
  down, failures from any event accumulate, and once open, all events skip. This
  is correct — one HA outage should suppress all calls.
- Disable-marker logic, connect/read timeouts, logging are unchanged and apply
  uniformly to every event.

### 2. Config schema (per-event array-of-tables, backward compatible)

```toml
[ha]
url = "http://192.168.15.114:8123/"
token = "..."
verify_ssl = true

[timeouts]
connect_ms = 300
read_ms = 2000

[circuit_breaker]
failure_threshold = 3
open_duration_sec = 300

# preset: A   (installer writes this provenance comment)
[[on_user_prompt_submit]]      # started working
service = "light.turn_off"
data = { entity_id = "light.display_light" }

[[on_stop]]                    # finished
service = "light.turn_on"
data = { entity_id = "light.display_light" }
```

- Existing `[[on_stop]]`-only configs keep working unchanged (zero breakage).
- DIY = hand-edit these tables, add/remove events, repeat `[[on_stop]]` for
  multiple actions.
- An unknown event table (e.g. a future `[[on_notification]]`) is parsed and
  dispatched automatically with no code change.
- Config-event key naming: lowercase snake_case `on_<event>`. The mapping from
  Claude Code's CamelCase event names to these keys lives entirely in how
  `settings.json` registers the hook (see §3) — the core just receives the
  config-key string as argv.

### 3. Adapter + settings registration

- Replace `adapters/claude-code/stop.sh` with a generic
  `adapters/claude-code/hook.sh` that takes the config-event name as `$1` and
  execs `python3 -m core.agent_hass_hook "$1"`. The `AGENT_HASS_HOOK_DISABLE=1`
  fast-exit and stdin pass-through are preserved.
- Keep a one-line `stop.sh` shim that calls `hook.sh on_stop` so any existing
  install (which registered `stop.sh`) keeps working.
- `settings.json` registers each event the chosen preset needs:
  - Preset A → `.hooks.Stop` → `hook.sh on_stop` **and**
    `.hooks.UserPromptSubmit` → `hook.sh on_user_prompt_submit`.
  - Preset C → same two events, different actions.

### 4. Presets (testable pure functions in `core/presets.py`)

`render(preset: str, entity: str, **opts) -> dict` returns the event→actions
structure the installer serializes to TOML.

| Preset | `on_user_prompt_submit` | `on_stop` |
|---|---|---|
| **A — work-off / done-on** (default) | `light.turn_off` `{entity_id}` | `light.turn_on` `{entity_id}` |
| **C — color-temp state** | `light.turn_on` `{entity_id, color_temp_kelvin=<warm>, brightness_pct=50}` | `light.turn_on` `{entity_id, color_temp_kelvin=<cool>, brightness_pct=100}` |

`<warm>`/`<cool>` default to the device's `min_color_temp_kelvin` /
`max_color_temp_kelvin` (read from HA during install; e.g. 2700 / 6500), so the
preset adapts to whatever light is chosen.

### 5. Installer — guided UX (`install.sh` rewrite, drop jq)

1. Dependency check: only `python3 >= 3.11` (no more `jq`/`curl`).
2. Prompt URL + token → connectivity test (`GET /api/`).
3. `GET /api/states` → list all `light.*` entities (friendly_name + current
   state), numbered; user picks a number or types an entity_id manually.
4. Pick preset: `A (default) / C / DIY (skip — edit config by hand)`.
   - For C, verify the chosen device's `supported_color_modes` includes
     `color_temp`; if not, warn and fall back to A.
5. Render config via `core/presets.py` → write `config.toml` (chmod 600; token
   still only via stdin/file, never in argv or env).
6. **Python** idempotent merge into `settings.json`, registering the event(s) the
   preset needs (the logic prototyped manually during install on 2026-05-29,
   now codified).
7. Flags `--dev` / `--no-config` / `--skip-test` retained.

### 6. Uninstall + compatibility

- `uninstall.sh` scans **all** `.hooks.*` event arrays (not just `Stop`) and
  removes entries whose command points at our adapter; also rewritten in Python
  (drop jq).
- A pre-existing Stop-only install is correctly cleaned by the new uninstaller.

## Error handling

Unchanged from MVP: always exit 0; config errors logged + printed to stderr;
HA call failures categorized (timeout / connection_error / http_4xx / http_5xx),
feeding the shared circuit breaker. The new `UserPromptSubmit` hook runs on the
"start" path, but the same 300 ms connect timeout bounds its latency so a dead HA
cannot delay Claude starting to respond.

## Testing

- `test_config`: multi-event table parsing; `on_stop`-only backward compatibility;
  unknown event tables parsed and ignored when not dispatched.
- `test_main`: `on_stop` triggers stop actions; `on_user_prompt_submit` triggers
  its actions; an event with no configured actions is a no-op exit 0; shared
  circuit breaker accumulates failures across events.
- `test_presets`: `render("A", entity)` and `render("C", entity, warm, cool)`
  produce the expected dicts (pure function, easy to test).
- `test_e2e.sh`: add a "UserPromptSubmit turns light off" scenario (mock HA).
- Stdlib + `unittest` only; no new dependencies.

## Out of scope (YAGNI)

Flashing (device lacks FLASH support; `supported_features=4`), multiple devices,
non-`light` domains, first-class mode field, auto-creating HA scripts. The
architecture leaves room for all of these; none are built now.

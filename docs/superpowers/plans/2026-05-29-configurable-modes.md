# Configurable Behavior Modes + Guided Install — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the hook from a single hardcoded `on_stop` action to a configurable `event → actions` map, ship presets A (work-off/done-on, default) and C (color-temp state), and rewrite the installer/uninstaller into a guided, jq-free flow.

**Architecture:** The core understands exactly one thing — `event → list of actions`. Presets are config templates the installer expands into generic `[[on_<event>]]` TOML; the runtime never knows about "modes". Adapters pass the config-event key (e.g. `on_stop`) as argv; `settings.json` maps Claude Code's CamelCase event names to those keys.

**Tech Stack:** Python 3.11+ stdlib only (`tomllib`, `urllib`, `http.client`, `json`, `dataclasses`, `unittest`); Bash adapters/installer.

---

## File Structure

- `core/config.py` — MODIFY: `Config.on_stop` → `Config.events: dict[str, list[Action]]`; parse every `on_*` table generically.
- `core/agent_hass_hook.py` — MODIFY: dispatch `cfg.events.get(event, [])`; empty → no-op exit 0.
- `core/presets.py` — CREATE: pure `render(preset, entity, ...) -> dict[str, list[dict]]`.
- `adapters/claude-code/hook.sh` — CREATE: generic dispatcher taking the event key as `$1`.
- `adapters/claude-code/stop.sh` — MODIFY: one-line shim → `hook.sh on_stop` (backward compat).
- `install.sh` — REWRITE: drop jq; device discovery; preset picker; Python settings merge for N events.
- `uninstall.sh` — REWRITE: Python; scan all `.hooks.*` arrays.
- `config.example.toml` — MODIFY: multi-event schema + DIY hints.
- `tests/test_config.py` — MODIFY: events-dict assertions + new cases.
- `tests/test_main.py` — MODIFY: per-event dispatch + no-op + shared-breaker cases.
- `tests/test_presets.py` — CREATE.
- `tests/test_e2e.sh` — MODIFY: add UserPromptSubmit-off scenario.
- `README.md` — MODIFY: document modes + new install flow.

---

## Task 1: Generalize core to event→actions dispatch

**Files:**
- Modify: `core/config.py`
- Modify: `core/agent_hass_hook.py:122-149` (the action loop)
- Test: `tests/test_config.py`, `tests/test_main.py`

- [ ] **Step 1: Write failing config tests for the events dict**

Add to `tests/test_config.py` (and at the top ensure `from core.config import load_config, ConfigError, Action` is present):

```python
def test_parses_multiple_event_tables(self):
    cfg = self._write_and_load("""
[ha]
url = "http://h:8123"
token = "t"

[[on_user_prompt_submit]]
service = "light.turn_off"
data = { entity_id = "light.x" }

[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.x" }
""")
    self.assertEqual(set(cfg.events), {"on_user_prompt_submit", "on_stop"})
    self.assertEqual(cfg.events["on_stop"], [Action("light.turn_on", {"entity_id": "light.x"})])
    self.assertEqual(cfg.events["on_user_prompt_submit"][0].service, "light.turn_off")

def test_on_stop_only_still_works(self):
    cfg = self._write_and_load("""
[ha]
url = "http://h:8123"
token = "t"

[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.x" }
""")
    self.assertEqual(set(cfg.events), {"on_stop"})

def test_unknown_event_table_is_parsed(self):
    cfg = self._write_and_load("""
[ha]
url = "http://h:8123"
token = "t"

[[on_notification]]
service = "light.toggle"
data = {}
""")
    self.assertIn("on_notification", cfg.events)

def test_no_event_tables_raises(self):
    with self.assertRaises(ConfigError):
        self._write_and_load("""
[ha]
url = "http://h:8123"
token = "t"
""")
```

If `tests/test_config.py` does not already have a `_write_and_load` helper, add this method to the test class:

```python
def _write_and_load(self, text):
    import tempfile
    from pathlib import Path
    d = tempfile.mkdtemp()
    p = Path(d) / "config.toml"
    p.write_text(text)
    return load_config(p)
```

- [ ] **Step 2: Update existing `cfg.on_stop` references in `tests/test_config.py`**

Find every existing assertion using `cfg.on_stop` and replace `cfg.on_stop` with `cfg.events["on_stop"]`. (The old single-field tests otherwise stay valid.) Run `grep -n "on_stop" tests/test_config.py` to locate them.

- [ ] **Step 3: Run config tests to verify they fail**

Run: `python3 -m unittest tests.test_config -v`
Expected: FAIL — `Config` has no attribute `events` / `AttributeError`.

- [ ] **Step 4: Implement generic event parsing in `core/config.py`**

Replace the `Config` dataclass (lines ~44-49) with:

```python
@dataclass(frozen=True)
class Config:
    ha: HAConfig
    timeouts: Timeouts
    breaker: BreakerConfig
    events: dict[str, list[Action]]
```

Add a module-level constant near the top (after imports):

```python
EVENT_PREFIX = "on_"
```

Add this helper above `load_config`:

```python
def _parse_actions(key: str, raw_list: list) -> list[Action]:
    actions: list[Action] = []
    for idx, entry in enumerate(raw_list):
        if not isinstance(entry, dict):
            raise ConfigError(f"[[{key}]] entry {idx} must be a table")
        service = entry.get("service")
        if not service or not isinstance(service, str) or "." not in service:
            raise ConfigError(
                f"[[{key}]] entry {idx}: 'service' must be 'domain.service' (e.g. 'light.turn_on')"
            )
        data = entry.get("data", {})
        if not isinstance(data, dict):
            raise ConfigError(f"[[{key}]] entry {idx}: 'data' must be a table")
        actions.append(Action(service=service, data=dict(data)))
    return actions
```

Replace the `on_stop` parsing block (current lines ~102-120, from `on_stop_raw = raw.get("on_stop")` through the `return`) with:

```python
    events: dict[str, list[Action]] = {}
    for key, val in raw.items():
        if not key.startswith(EVENT_PREFIX):
            continue
        if not isinstance(val, list):
            raise ConfigError(f"[[{key}]] must be an array of tables")
        actions = _parse_actions(key, val)
        if actions:
            events[key] = actions

    if not events:
        raise ConfigError(
            "at least one [[on_<event>]] table with an action is required "
            "(e.g. [[on_stop]] with service = \"light.turn_on\")"
        )

    return Config(ha=ha, timeouts=timeouts, breaker=breaker, events=events)
```

- [ ] **Step 5: Run config tests to verify they pass**

Run: `python3 -m unittest tests.test_config -v`
Expected: PASS (all, including the new multi-event/backward-compat/unknown-event/no-event cases).

- [ ] **Step 6: Write failing main dispatch tests**

In `tests/test_main.py`, add a multi-event config writer next to `write_cfg`:

```python
def write_cfg_multi(d: Path, ha_url: str, entity="light.test"):
    cfg = d / "config.toml"
    cfg.write_text(f"""
[ha]
url = "{ha_url}"
token = "tok"

[[on_user_prompt_submit]]
service = "light.turn_off"
data = {{ entity_id = "{entity}" }}

[[on_stop]]
service = "light.turn_on"
data = {{ entity_id = "{entity}" }}
""")
    return cfg
```

Add these test methods to `TestMain`:

```python
def test_user_prompt_submit_calls_turn_off(self):
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        with mock_ha() as (url, srv):
            write_cfg_multi(tmp, url)
            paths = Paths(config_path=tmp / "config.toml", state_dir=tmp / "state")
            stdin = json.dumps({"cwd": str(tmp)})
            rc = main(["on_user_prompt_submit"], stdin, {}, paths)
        self.assertEqual(rc, 0)
        self.assertEqual(srv.last_path, "/api/services/light/turn_off")

def test_event_with_no_actions_is_noop(self):
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        with mock_ha() as (url, srv):
            paths = make_paths(tmp, url)  # writes only [[on_stop]]
            stdin = json.dumps({"cwd": str(tmp)})
            rc = main(["on_user_prompt_submit"], stdin, {}, paths)
        self.assertEqual(rc, 0)
        self.assertIsNone(srv.last_path)  # HA never called

def test_breaker_shared_across_events(self):
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        with mock_ha(status=500) as (url, _):
            write_cfg_multi(tmp, url)
            paths = Paths(config_path=tmp / "config.toml", state_dir=tmp / "state")
            stdin = json.dumps({"cwd": str(tmp)})
            main(["on_user_prompt_submit"], stdin, {}, paths)  # failure 1
            main(["on_stop"], stdin, {}, paths)                # failure 2
            main(["on_user_prompt_submit"], stdin, {}, paths)  # failure 3 -> trips
        state = json.loads((tmp / "state" / "breaker.json").read_text())
        self.assertEqual(state["consecutive_failures"], 3)
        self.assertIsNotNone(state["tripped_at"])
```

- [ ] **Step 7: Run main tests to verify they fail**

Run: `python3 -m unittest tests.test_main -v`
Expected: FAIL — `main` still references `cfg.on_stop` (AttributeError).

- [ ] **Step 8: Implement dispatch in `core/agent_hass_hook.py`**

Replace the action-loop region (current lines ~122-149, from `any_failure = False` up to `return 0`) with:

```python
    actions = cfg.events.get(event, [])
    if not actions:
        return 0  # no actions configured for this event — silent no-op

    breaker = CircuitBreaker(
        state_path=paths.breaker_path,
        failure_threshold=cfg.breaker.failure_threshold,
        open_duration_sec=cfg.breaker.open_duration_sec,
    )
    if breaker.should_skip():
        logger.log(event=event, cwd=str(cwd_path), result="skipped", reason="breaker_open")
        return 0

    any_failure = False
    for action in actions:
        t_start = time.monotonic()
        result = call_service(
            cfg.ha.url, cfg.ha.token, action.service, action.data,
            connect_ms=cfg.timeouts.connect_ms,
            read_ms=cfg.timeouts.read_ms,
            verify_ssl=cfg.ha.verify_ssl,
        )
        duration_ms = result.duration_ms if result.duration_ms is not None else int((time.monotonic() - t_start) * 1000)
        if result.ok:
            logger.log(
                event=event, cwd=str(cwd_path), result="ok",
                service=action.service, status=result.status, duration_ms=duration_ms,
            )
        else:
            any_failure = True
            logger.log(
                event=event, cwd=str(cwd_path), result="failed",
                service=action.service, error=result.error, status=result.status,
                duration_ms=duration_ms,
            )

    if any_failure:
        breaker.record_failure()
    else:
        breaker.record_success()
    return 0
```

Note: the existing breaker-creation block that sat *before* the loop must be removed (it now lives inside the snippet above, after the empty-actions check) so the breaker file is not created for no-op events.

- [ ] **Step 9: Run the full suite to verify it passes**

Run: `python3 -m unittest discover -s tests -v`
Expected: PASS (all Python tests).

- [ ] **Step 10: Commit**

```bash
git add core/config.py core/agent_hass_hook.py tests/test_config.py tests/test_main.py
git commit -m "feat(core): generic event->actions dispatch"
```

---

## Task 2: Preset templates

**Files:**
- Create: `core/presets.py`
- Test: `tests/test_presets.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_presets.py`:

```python
import unittest
from core.presets import render, PRESETS


class TestPresets(unittest.TestCase):
    def test_preset_a(self):
        ev = render("A", "light.x")
        self.assertEqual(set(ev), {"on_user_prompt_submit", "on_stop"})
        self.assertEqual(ev["on_user_prompt_submit"],
                         [{"service": "light.turn_off", "data": {"entity_id": "light.x"}}])
        self.assertEqual(ev["on_stop"],
                         [{"service": "light.turn_on", "data": {"entity_id": "light.x"}}])

    def test_preset_c_uses_kelvin_range(self):
        ev = render("C", "light.x", warm_kelvin=2700, cool_kelvin=6500)
        start = ev["on_user_prompt_submit"][0]["data"]
        done = ev["on_stop"][0]["data"]
        self.assertEqual(start["color_temp_kelvin"], 2700)
        self.assertEqual(start["brightness_pct"], 50)
        self.assertEqual(done["color_temp_kelvin"], 6500)
        self.assertEqual(done["brightness_pct"], 100)
        self.assertEqual(ev["on_stop"][0]["service"], "light.turn_on")

    def test_unknown_preset_raises(self):
        with self.assertRaises(ValueError):
            render("Z", "light.x")

    def test_presets_registry(self):
        self.assertEqual(PRESETS, {"A", "C"})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python3 -m unittest tests.test_presets -v`
Expected: FAIL — `No module named 'core.presets'`.

- [ ] **Step 3: Implement `core/presets.py`**

```python
"""Behavior presets — pure templates expanded into generic event->actions config.

The runtime never imports this; only the installer does, to render a
config.toml from a chosen preset. Keeping it pure (returns plain dicts)
makes it trivially testable and keeps the runtime free of "mode" logic.
"""
from __future__ import annotations

PRESETS = {"A", "C"}


def render(
    preset: str,
    entity: str,
    *,
    warm_kelvin: int = 2700,
    cool_kelvin: int = 6500,
) -> dict[str, list[dict]]:
    """Return {event_key: [{"service": str, "data": dict}, ...]} for a preset."""
    if preset == "A":
        return {
            "on_user_prompt_submit": [
                {"service": "light.turn_off", "data": {"entity_id": entity}}
            ],
            "on_stop": [
                {"service": "light.turn_on", "data": {"entity_id": entity}}
            ],
        }
    if preset == "C":
        return {
            "on_user_prompt_submit": [
                {"service": "light.turn_on", "data": {
                    "entity_id": entity,
                    "color_temp_kelvin": warm_kelvin,
                    "brightness_pct": 50,
                }}
            ],
            "on_stop": [
                {"service": "light.turn_on", "data": {
                    "entity_id": entity,
                    "color_temp_kelvin": cool_kelvin,
                    "brightness_pct": 100,
                }}
            ],
        }
    raise ValueError(f"unknown preset {preset!r} (expected one of {sorted(PRESETS)})")
```

- [ ] **Step 4: Run it to verify it passes**

Run: `python3 -m unittest tests.test_presets -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/presets.py tests/test_presets.py
git commit -m "feat(presets): A (work-off/done-on) and C (color-temp state) templates"
```

---

## Task 3: Generic adapter + stop.sh shim

**Files:**
- Create: `adapters/claude-code/hook.sh`
- Modify: `adapters/claude-code/stop.sh`

- [ ] **Step 1: Create `adapters/claude-code/hook.sh`**

```bash
#!/usr/bin/env bash
# Generic Claude Code hook adapter for agent-hass-hook.
#
# Usage: hook.sh <event_key>   e.g. hook.sh on_stop / hook.sh on_user_prompt_submit
#
# Passes stdin through to the Python core unchanged. Honors
# AGENT_HASS_HOOK_DISABLE=1 by exiting 0 immediately (the fastest disable
# path — Python is never invoked).
set -u

if [[ "${AGENT_HASS_HOOK_DISABLE:-}" == "1" ]]; then
    exit 0
fi

event="${1:-on_stop}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

python_bin="${AGENT_HASS_HOOK_PYTHON:-python3}"

cd "$repo_root" || exit 0
exec "$python_bin" -m core.agent_hass_hook "$event"
```

- [ ] **Step 2: Replace `adapters/claude-code/stop.sh` with a shim**

```bash
#!/usr/bin/env bash
# Backward-compatibility shim. Older installs registered stop.sh directly;
# forward to the generic dispatcher so they keep working.
set -u
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$script_dir/hook.sh" on_stop
```

- [ ] **Step 3: Make both executable and smoke-test the shim path**

```bash
chmod +x adapters/claude-code/hook.sh adapters/claude-code/stop.sh
echo '{"cwd":"/tmp"}' | AGENT_HASS_HOOK_DISABLE=1 ./adapters/claude-code/hook.sh on_stop; echo "exit=$?"
```
Expected: `exit=0` (disabled fast-path, no Python).

- [ ] **Step 4: Commit**

```bash
git add adapters/claude-code/hook.sh adapters/claude-code/stop.sh
git commit -m "feat(adapter): generic hook.sh dispatcher; stop.sh becomes shim"
```

---

## Task 4: Rewrite installer — drop jq, device discovery, preset picker

**Files:**
- Rewrite: `install.sh`

- [ ] **Step 1: Replace `install.sh` entirely**

```bash
#!/usr/bin/env bash
# Install agent-hass-hook: copy files, guide config (device + preset),
# test connectivity, register the needed hook events in ~/.claude/settings.json.
#
# Flags:
#   --dev          Point the hook at this repo (no copy). Useful for development.
#   --no-config    Skip config prompt (assume config.toml already exists).
#   --skip-test    (Reserved) connectivity is part of discovery; kept for compat.
#   --help         Show this help.
set -euo pipefail

DEV=0
NO_CONFIG=0
for arg in "$@"; do
    case "$arg" in
        --dev) DEV=1 ;;
        --no-config) NO_CONFIG=1 ;;
        --skip-test) ;;  # accepted, no-op (discovery already verifies connectivity)
        --help|-h) sed -n '2,9p' "$0"; exit 0 ;;
        *) echo "Unknown flag: $arg" >&2; exit 2 ;;
    esac
done

err() { echo "install.sh: error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# --- 1. Dependencies (python only; jq no longer required)
info "Checking dependencies..."
command -v python3 >/dev/null || err "python3 not found. Install Python 3.11+."
pyok=$(python3 -c 'import sys; print(1 if sys.version_info >= (3,11) else 0)')
[[ "$pyok" == "1" ]] || err "python3 must be 3.11+ (for tomllib)."

# --- 2. Install path & hook command
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$DEV" == "1" ]]; then
    INSTALL_DIR="$SCRIPT_DIR"
    info "Dev mode: hook points at $INSTALL_DIR (no copy)"
else
    INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/agent-hass-hook"
    info "Installing to $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    cp -r "$SCRIPT_DIR/core" "$INSTALL_DIR/"
    cp -r "$SCRIPT_DIR/adapters" "$INSTALL_DIR/"
    cp "$SCRIPT_DIR/config.example.toml" "$INSTALL_DIR/"
    chmod +x "$INSTALL_DIR/adapters/claude-code/hook.sh" "$INSTALL_DIR/adapters/claude-code/stop.sh"
fi
HOOK_CMD="$INSTALL_DIR/adapters/claude-code/hook.sh"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-hass-hook"
CONFIG_PATH="$CONFIG_DIR/config.toml"
SETTINGS="$HOME/.claude/settings.json"

if [[ "$NO_CONFIG" == "1" ]]; then
    [[ -f "$CONFIG_PATH" ]] || err "No config at $CONFIG_PATH. Run without --no-config."
    info "Using existing config (--no-config)."
    # Register events present in the existing config.
    PYTHONPATH="$INSTALL_DIR" python3 - "$CONFIG_PATH" "$HOOK_CMD" "$SETTINGS" <<'PYEOF'
import json, sys, tomllib
from pathlib import Path
cfg_path, hook_cmd, settings_path = sys.argv[1:4]
with open(cfg_path, "rb") as f:
    cfg = tomllib.load(f)
EVENT_MAP = {"on_stop": "Stop", "on_user_prompt_submit": "UserPromptSubmit"}
events = [k for k in cfg if k.startswith("on_")]
sp = Path(settings_path); sp.parent.mkdir(parents=True, exist_ok=True)
data = json.loads(sp.read_text()) if sp.exists() else {}
hooks = data.setdefault("hooks", {})
for ev in events:
    claude = EVENT_MAP.get(ev)
    if not claude:
        continue
    cmd = f"{hook_cmd} {ev}"
    arr = hooks.setdefault(claude, [])
    existing = [h.get("command") for entry in arr for h in entry.get("hooks", [])]
    if cmd not in existing:
        arr.append({"matcher": "", "hooks": [{"type": "command", "command": cmd}]})
        print(f"  registered {claude} -> {cmd}")
sp.write_text(json.dumps(data, indent=2) + "\n")
PYEOF
    echo "Installation complete."
    exit 0
fi

# --- 3. Prompt URL + token
if [[ -f "$CONFIG_PATH" ]]; then
    read -r -p "Config exists at $CONFIG_PATH. (k)eep / (o)verwrite / (a)bort? [k] " choice
    case "${choice:-k}" in
        k|K) info "Keeping existing config; (re)registering events."; NO_CONFIG=1 ;;
        o|O) rm "$CONFIG_PATH" ;;
        *) err "Aborted." ;;
    esac
fi

if [[ "$NO_CONFIG" != "1" ]]; then
    mkdir -p "$CONFIG_DIR"; chmod 700 "$CONFIG_DIR"
    read -r -p "HA URL (e.g. http://192.168.1.100:8123): " HA_URL
    [[ -n "$HA_URL" ]] || err "URL is required."
    read -r -s -p "HA long-lived access token: " HA_TOKEN; echo
    [[ -n "$HA_TOKEN" ]] || err "Token is required."

    # --- 4. Discover lights (Python; token via stdin only) ---
    TMPMAP=$(mktemp); trap 'rm -f "$TMPMAP"' EXIT
    printf '%s' "$HA_TOKEN" | PYTHONPATH="$INSTALL_DIR" python3 - "$HA_URL" "$TMPMAP" <<'PYEOF'
import sys, json, urllib.request, urllib.error
url = sys.argv[1].rstrip("/"); mapfile = sys.argv[2]
token = sys.stdin.read().strip()
def get(path):
    req = urllib.request.Request(url + path, headers={"Authorization": f"Bearer {token}"})
    return urllib.request.urlopen(req, timeout=5)
try:
    get("/api/")
except urllib.error.HTTPError as e:
    sys.exit(f"  connectivity FAILED: HTTP {e.code} (check URL/token)")
except Exception as e:
    sys.exit(f"  connectivity FAILED: {e}")
print("  API reachable; token valid")
states = json.loads(get("/api/states").read())
lights = [s for s in states if s["entity_id"].startswith("light.")]
lines = []
print("\nAvailable lights:")
for i, s in enumerate(lights, 1):
    a = s.get("attributes", {})
    ct = "color_temp" in (a.get("supported_color_modes") or [])
    mn = a.get("min_color_temp_kelvin", 2700); mx = a.get("max_color_temp_kelvin", 6500)
    fn = a.get("friendly_name", "")
    print(f"  {i:2}. {s['entity_id']:42} [{s['state']}] {fn}")
    lines.append(f"{i}\t{s['entity_id']}\t{1 if ct else 0}\t{mn}\t{mx}")
open(mapfile, "w").write("\n".join(lines))
PYEOF

    read -r -p "Pick a light by number (or type an entity_id): " PICK
    if [[ "$PICK" =~ ^[0-9]+$ ]]; then
        LINE=$(awk -F'\t' -v n="$PICK" '$1==n {print; exit}' "$TMPMAP")
        [[ -n "$LINE" ]] || err "No light with number $PICK."
        ENTITY=$(echo "$LINE" | cut -f2); SUPPORTS_CT=$(echo "$LINE" | cut -f3)
        WARM=$(echo "$LINE" | cut -f4); COOL=$(echo "$LINE" | cut -f5)
    else
        ENTITY="$PICK"; SUPPORTS_CT=0; WARM=2700; COOL=6500
    fi
    info "Selected: $ENTITY"

    # --- 5. Pick preset ---
    echo "Presets:"
    echo "  A) work-off / done-on   (light off while working, on when done) [default]"
    echo "  C) color-temp state     (warm/dim while working, cool/bright when done)"
    echo "  D) DIY                  (write a commented example to edit yourself)"
    read -r -p "Choose preset [A]: " PRESET; PRESET="${PRESET:-A}"
    PRESET=$(echo "$PRESET" | tr '[:lower:]' '[:upper:]')
    if [[ "$PRESET" == "C" && "$SUPPORTS_CT" != "1" ]]; then
        info "Device does not support color_temp; falling back to preset A."
        PRESET="A"
    fi

    # --- 6. Render config + verify entity + register events (Python; token via stdin) ---
    printf '%s' "$HA_TOKEN" | PYTHONPATH="$INSTALL_DIR" python3 - \
        "$CONFIG_PATH" "$HOOK_CMD" "$SETTINGS" "$HA_URL" "$ENTITY" "$PRESET" "$WARM" "$COOL" "$INSTALL_DIR" <<'PYEOF'
import json, os, sys, urllib.request, urllib.error
from pathlib import Path
from core.presets import render

cfg_path, hook_cmd, settings_path, url, entity, preset, warm, cool, install_dir = sys.argv[1:10]
url = url.rstrip("/"); token = sys.stdin.read().strip()
EVENT_MAP = {"on_stop": "Stop", "on_user_prompt_submit": "UserPromptSubmit"}

def jstr(v): return json.dumps(v)  # TOML basic-string escaping == JSON's here

# Verify entity exists (connectivity already checked in discovery).
req = urllib.request.Request(url + f"/api/states/{entity}", headers={"Authorization": f"Bearer {token}"})
try:
    urllib.request.urlopen(req, timeout=5)
    print(f"  entity {entity} exists")
except urllib.error.HTTPError as e:
    sys.exit(f"  entity check FAILED: HTTP {e.code} (bad entity_id?)")
except Exception as e:
    sys.exit(f"  entity check FAILED: {e}")

# Build event->actions structure.
if preset == "D":
    example = Path(install_dir) / "config.example.toml"
    events = render("A", entity)  # sensible default to register both events
    body = example.read_text()
    body = body.replace("REPLACE_URL", url).replace("REPLACE_TOKEN", token)
    header = "# DIY: starter config. Edit the [[on_*]] tables below freely.\n"
    content = header + body
else:
    events = render(preset, entity, warm_kelvin=int(warm), cool_kelvin=int(cool))
    lines = [f"# preset: {preset}", "[ha]",
             f"url = {jstr(url + '/')}", f"token = {jstr(token)}", "verify_ssl = true", "",
             "[timeouts]", "connect_ms = 300", "read_ms = 2000", "",
             "[circuit_breaker]", "failure_threshold = 3", "open_duration_sec = 300", ""]
    for ev, actions in events.items():
        for a in actions:
            lines.append(f"[[{ev}]]")
            lines.append(f"service = {jstr(a['service'])}")
            data_items = ", ".join(
                f"{k} = {jstr(v) if isinstance(v, str) else json.dumps(v)}"
                for k, v in a["data"].items()
            )
            lines.append("data = { " + data_items + " }")
            lines.append("")
    content = "\n".join(lines)

# Write config 0600.
um = os.umask(0o077)
try:
    fd = os.open(cfg_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(content)
finally:
    os.umask(um)
print(f"  wrote {cfg_path} (chmod 600)")

# Register the events this config uses.
sp = Path(settings_path); sp.parent.mkdir(parents=True, exist_ok=True)
data = json.loads(sp.read_text()) if sp.exists() else {}
hooks = data.setdefault("hooks", {})
for ev in events:
    claude = EVENT_MAP.get(ev)
    if not claude:
        continue
    cmd = f"{hook_cmd} {ev}"
    arr = hooks.setdefault(claude, [])
    existing = [h.get("command") for entry in arr for h in entry.get("hooks", [])]
    if cmd not in existing:
        arr.append({"matcher": "", "hooks": [{"type": "command", "command": cmd}]})
        print(f"  registered {claude} -> {cmd}")
sp.write_text(json.dumps(data, indent=2) + "\n")
PYEOF
    unset HA_TOKEN
fi

echo
echo "Installation complete."
echo "Logs: ${XDG_STATE_HOME:-$HOME/.local/state}/agent-hass-hook/hook.log"
echo "Disable per-project: 'touch .no-hass-hook' at project root"
echo "Disable per-session: 'export AGENT_HASS_HOOK_DISABLE=1'"
```

- [ ] **Step 2: Lint the script**

Run: `bash -n install.sh`
Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat(install): guided device+preset flow, jq-free, multi-event registration"
```

---

## Task 5: Rewrite uninstaller — Python, all events

**Files:**
- Rewrite: `uninstall.sh`

- [ ] **Step 1: Replace `uninstall.sh` entirely**

```bash
#!/usr/bin/env bash
# Uninstall agent-hass-hook: remove our hook entries from every event array
# in ~/.claude/settings.json. Config and state preserved unless --purge.
#
# Flags:
#   --purge       Also delete ~/.config/agent-hass-hook and ~/.local/state/agent-hass-hook.
#   --help        Show this help.
set -euo pipefail

PURGE=0
for arg in "$@"; do
    case "$arg" in
        --purge) PURGE=1 ;;
        --help|-h) sed -n '2,7p' "$0"; exit 0 ;;
        *) echo "Unknown flag: $arg" >&2; exit 2 ;;
    esac
done

info() { echo "==> $*"; }

SETTINGS="$HOME/.claude/settings.json"
if [[ -f "$SETTINGS" ]]; then
    info "Removing agent-hass-hook entries from $SETTINGS"
    python3 - "$SETTINGS" <<'PYEOF'
import json, sys
from pathlib import Path
sp = Path(sys.argv[1])
data = json.loads(sp.read_text())
hooks = data.get("hooks", {})

def ours(cmd):
    cmd = cmd or ""
    return "agent-hass-hook" in cmd and ("hook.sh" in cmd or "stop.sh" in cmd)

for event, arr in list(hooks.items()):
    if not isinstance(arr, list):
        continue
    new_arr = []
    for entry in arr:
        kept = [h for h in entry.get("hooks", []) if not ours(h.get("command"))]
        if kept:
            entry = {**entry, "hooks": kept}
            new_arr.append(entry)
    if new_arr:
        hooks[event] = new_arr
    else:
        del hooks[event]
sp.write_text(json.dumps(data, indent=2) + "\n")
print("  settings cleaned")
PYEOF
fi

INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/agent-hass-hook"
[[ -d "$INSTALL_DIR" ]] && { info "Removing $INSTALL_DIR"; rm -rf "$INSTALL_DIR"; }

if [[ "$PURGE" == "1" ]]; then
    CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-hass-hook"
    STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/agent-hass-hook"
    [[ -d "$CONFIG_DIR" ]] && rm -rf "$CONFIG_DIR" && info "Removed $CONFIG_DIR"
    [[ -d "$STATE_DIR" ]] && rm -rf "$STATE_DIR" && info "Removed $STATE_DIR"
else
    info "Config and state preserved. Pass --purge to remove them."
fi
echo "Done."
```

- [ ] **Step 2: Lint the script**

Run: `bash -n uninstall.sh`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add uninstall.sh
git commit -m "feat(uninstall): jq-free, removes hooks from every event array"
```

---

## Task 6: E2E scenario, example config, README

**Files:**
- Modify: `tests/test_e2e.sh`
- Modify: `config.example.toml`
- Modify: `README.md`

- [ ] **Step 1: Update `config.example.toml`**

Replace its body with the multi-event schema (the installer's DIY mode substitutes `REPLACE_URL` / `REPLACE_TOKEN`):

```toml
# agent-hass-hook configuration.
# Each [[on_<event>]] table is a list of HA service calls for that event.
# Supported events (Claude Code): on_stop, on_user_prompt_submit.

[ha]
url = "REPLACE_URL"
token = "REPLACE_TOKEN"
verify_ssl = true

[timeouts]
connect_ms = 300
read_ms = 2000

[circuit_breaker]
failure_threshold = 3
open_duration_sec = 300

# --- Preset A (default): off while working, on when done ---
[[on_user_prompt_submit]]
service = "light.turn_off"
data = { entity_id = "light.example" }

[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.example" }

# --- DIY examples (uncomment / adapt) ---
# Multiple actions per event — just repeat the table:
# [[on_stop]]
# service = "light.turn_on"
# data = { entity_id = "light.desk", color_temp_kelvin = 6500, brightness_pct = 100 }
#
# Call any HA service, e.g. a script that blinks:
# [[on_stop]]
# service = "script.turn_on"
# data = { entity_id = "script.cc_blink" }
```

- [ ] **Step 2: Add an e2e scenario to `tests/test_e2e.sh`**

Add a new scenario (follow the existing scenarios' structure — a mock HA via Python `http.server`, a temp config, then invoke the adapter). Insert this scenario, adapting variable names to the file's existing conventions:

```bash
# scenario 5: UserPromptSubmit turns the light OFF
cat > "$CFG" <<EOF
[ha]
url = "$MOCK_URL"
token = "tok"

[[on_user_prompt_submit]]
service = "light.turn_off"
data = { entity_id = "light.test" }

[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.test" }
EOF
echo '{"cwd":"'"$WORK"'"}' | \
  AGENT_HASS_HOOK_CONFIG="$CFG" AGENT_HASS_HOOK_STATE_DIR="$STATE" \
  "$REPO/adapters/claude-code/hook.sh" on_user_prompt_submit
if grep -q '"service":"light.turn_off"' "$STATE/hook.log"; then
  echo "ok: scenario 5: UserPromptSubmit calls turn_off"
else
  echo "FAIL: scenario 5"; exit 1
fi
```

(If the e2e harness records the requested path on the mock server instead of the log, assert on that artifact the same way the existing scenarios do. Match the file's existing mock + assertion style rather than copying verbatim.)

- [ ] **Step 3: Run the e2e suite**

Run: `bash tests/test_e2e.sh`
Expected: all scenarios (including the new one) print `ok:` and the script exits 0.

- [ ] **Step 4: Update `README.md`**

Add a "Behavior modes" section documenting presets A and C, the `event → actions` config model with the `[[on_user_prompt_submit]]` / `[[on_stop]]` tables, and that the installer is now jq-free and guides device + preset selection. Update any `stop.sh` references to mention `hook.sh <event>`. Keep the existing disable/uninstall docs.

- [ ] **Step 5: Run the full suite once more**

Run: `python3 -m unittest discover -s tests -v && bash tests/test_e2e.sh`
Expected: all Python tests PASS and all e2e scenarios `ok`.

- [ ] **Step 6: Commit**

```bash
git add tests/test_e2e.sh config.example.toml README.md
git commit -m "docs+test: multi-event example, UserPromptSubmit e2e, README modes section"
```

---

## Self-Review

**Spec coverage:**
- §1 generic dispatch → Task 1 ✓
- §2 config schema (per-event, backward compat) → Task 1 (parse) + Task 6 (example) ✓
- §3 adapter + settings registration → Task 3 (adapter) + Task 4 (multi-event registration) ✓
- §4 presets A/C → Task 2 ✓
- §5 guided installer, drop jq → Task 4 ✓
- §6 uninstall all events, drop jq → Task 5 ✓
- Error handling (no-op empty event, shared breaker) → Task 1 tests ✓
- Testing (config/main/presets/e2e) → Tasks 1, 2, 6 ✓

**Placeholder scan:** No TBD/TODO. The one "match the file's existing style" note in Task 6 Step 2 is bounded with a concrete code block and a fallback instruction — acceptable because the e2e harness's exact mock-assertion idiom must be read from the file.

**Type consistency:** `Config.events: dict[str, list[Action]]` used consistently in Task 1 (config + main + tests). `render(preset, entity, *, warm_kelvin, cool_kelvin) -> dict[str, list[dict]]` consistent across Task 2 and Task 4's installer call. `EVENT_MAP = {"on_stop": "Stop", "on_user_prompt_submit": "UserPromptSubmit"}` identical in both installer Python blocks (Task 4) and matches the config keys produced by `presets.render`.

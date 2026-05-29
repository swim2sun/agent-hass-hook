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
if not lights:
    print("  (no light.* entities found — you can still type an entity_id manually)")
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
import json, os, sys, urllib.request, urllib.error, urllib.parse
from pathlib import Path
from core.presets import render

cfg_path, hook_cmd, settings_path, url, entity, preset, warm, cool, install_dir = sys.argv[1:10]
url = url.rstrip("/"); token = sys.stdin.read().strip()
EVENT_MAP = {"on_stop": "Stop", "on_user_prompt_submit": "UserPromptSubmit"}

def jstr(v): return json.dumps(v)  # TOML basic-string escaping == JSON's here

# Verify entity exists (connectivity already checked in discovery).
req = urllib.request.Request(url + "/api/states/" + urllib.parse.quote(entity), headers={"Authorization": f"Bearer {token}"})
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
    if "REPLACE_URL" in body or "REPLACE_TOKEN" in body:
        sys.exit("  DIY config error: config.example.toml is missing REPLACE_URL/REPLACE_TOKEN markers")
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
    os.fchmod(fd, 0o600)  # force perms even if config.toml pre-existed with looser mode
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

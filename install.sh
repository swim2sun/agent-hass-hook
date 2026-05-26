#!/usr/bin/env bash
# Install agent-hass-hook: copy files, prompt for config, test connectivity,
# register Stop hook in ~/.claude/settings.json.
#
# Flags:
#   --dev          Point the hook at this repo (no copy). Useful for development.
#   --no-config    Skip config prompt (assume ~/.config/agent-hass-hook/config.toml exists).
#   --skip-test    Skip the HA connectivity test.
#   --help         Show this help.
set -euo pipefail

DEV=0
NO_CONFIG=0
SKIP_TEST=0
for arg in "$@"; do
    case "$arg" in
        --dev) DEV=1 ;;
        --no-config) NO_CONFIG=1 ;;
        --skip-test) SKIP_TEST=1 ;;
        --help|-h)
            sed -n '2,8p' "$0"
            exit 0
            ;;
        *) echo "Unknown flag: $arg" >&2; exit 2 ;;
    esac
done

err() { echo "install.sh: error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# --- 1. Dependency checks
info "Checking dependencies..."
command -v python3 >/dev/null || err "python3 not found. Install Python 3.11+."
pyver=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
pyok=$(python3 -c 'import sys; print(1 if sys.version_info >= (3, 11) else 0)')
[[ "$pyok" == "1" ]] || err "python3 is $pyver, need 3.11+ (for tomllib)."

command -v jq >/dev/null || err "jq not found. Install: apt install jq / brew install jq"
command -v curl >/dev/null || err "curl not found. Install curl."

# --- 2. Determine install path & hook command
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$DEV" == "1" ]]; then
    INSTALL_DIR="$SCRIPT_DIR"
    info "Dev mode: hook will point at $INSTALL_DIR (no copy)"
else
    INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/agent-hass-hook"
    info "Installing to $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    cp -r "$SCRIPT_DIR/core" "$INSTALL_DIR/"
    cp -r "$SCRIPT_DIR/adapters" "$INSTALL_DIR/"
    cp "$SCRIPT_DIR/config.example.toml" "$INSTALL_DIR/"
    chmod +x "$INSTALL_DIR/adapters/claude-code/stop.sh"
fi
HOOK_CMD="$INSTALL_DIR/adapters/claude-code/stop.sh"

# --- 3. Configuration
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-hass-hook"
CONFIG_PATH="$CONFIG_DIR/config.toml"

if [[ "$NO_CONFIG" == "1" ]]; then
    info "Skipping config prompt (--no-config)"
    [[ -f "$CONFIG_PATH" ]] || err "No config at $CONFIG_PATH. Run without --no-config to set it up."
else
    if [[ -f "$CONFIG_PATH" ]]; then
        read -r -p "Config exists at $CONFIG_PATH. (k)eep / (o)verwrite / (a)bort? [k] " choice
        choice=${choice:-k}
        case "$choice" in
            k|K) info "Keeping existing config." ;;
            o|O) rm "$CONFIG_PATH" ;;
            *) err "Aborted." ;;
        esac
    fi

    if [[ ! -f "$CONFIG_PATH" ]]; then
        info "Setting up config..."
        mkdir -p "$CONFIG_DIR"
        chmod 700 "$CONFIG_DIR"

        read -r -p "HA URL (e.g. http://192.168.1.100:8123): " HA_URL
        [[ -n "$HA_URL" ]] || err "URL is required."

        read -r -s -p "HA long-lived access token: " HA_TOKEN
        echo
        [[ -n "$HA_TOKEN" ]] || err "Token is required."

        read -r -p "Entity ID of the light (e.g. light.xiaomi_monitor_lamp): " ENTITY_ID
        [[ -n "$ENTITY_ID" ]] || err "Entity ID is required."

        umask 077
        cat > "$CONFIG_PATH" <<EOF
[ha]
url = "$HA_URL"
token = "$HA_TOKEN"
verify_ssl = true

[timeouts]
connect_ms = 300
read_ms = 2000

[circuit_breaker]
failure_threshold = 3
open_duration_sec = 300

[[on_stop]]
service = "light.turn_on"
data = { entity_id = "$ENTITY_ID" }
EOF
        chmod 600 "$CONFIG_PATH"
        info "Wrote $CONFIG_PATH (chmod 600)"
    fi
fi

# --- 4. Connectivity test
if [[ "$SKIP_TEST" == "1" ]]; then
    info "Skipping connectivity test (--skip-test)"
else
    info "Testing HA connectivity..."
    eval "$(python3 -c "
import tomllib, shlex
with open('$CONFIG_PATH', 'rb') as f:
    c = tomllib.load(f)
print(f'CFG_URL={shlex.quote(c[\"ha\"][\"url\"])}')
print(f'CFG_TOKEN={shlex.quote(c[\"ha\"][\"token\"])}')
print(f'CFG_ENTITY={shlex.quote(c[\"on_stop\"][0][\"data\"][\"entity_id\"])}')
")"

    if ! curl -fsS -m 5 -H "Authorization: Bearer $CFG_TOKEN" "$CFG_URL/api/" >/dev/null; then
        err "Failed to reach $CFG_URL/api/ — check URL and token."
    fi
    info "✓ API reachable; token valid"

    if ! curl -fsS -m 5 -H "Authorization: Bearer $CFG_TOKEN" "$CFG_URL/api/states/$CFG_ENTITY" >/dev/null; then
        err "Entity '$CFG_ENTITY' not found in HA — check the entity_id."
    fi
    info "✓ Entity $CFG_ENTITY exists"
fi

# --- 5. Register hook in ~/.claude/settings.json
SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$(dirname "$SETTINGS")"
[[ -f "$SETTINGS" ]] || echo "{}" > "$SETTINGS"

info "Registering Stop hook in $SETTINGS"
tmp=$(mktemp)
jq --arg cmd "$HOOK_CMD" '
  .hooks //= {} |
  .hooks.Stop //= [] |
  if (.hooks.Stop | map(.hooks // []) | flatten | map(.command) | index($cmd)) then
    .
  else
    .hooks.Stop += [{
      "matcher": "",
      "hooks": [{"type": "command", "command": $cmd}]
    }]
  end
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
info "✓ Hook registered: $HOOK_CMD"

echo
echo "Installation complete."
echo "Test it: trigger Claude Code Stop in any session — your light should turn on."
echo "Logs: ${XDG_STATE_HOME:-$HOME/.local/state}/agent-hass-hook/hook.log"
echo "Disable per-project: 'touch .no-hass-hook' at project root"
echo "Disable per-session: 'export AGENT_HASS_HOOK_DISABLE=1'"

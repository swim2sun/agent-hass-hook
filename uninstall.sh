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

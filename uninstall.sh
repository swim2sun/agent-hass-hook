#!/usr/bin/env bash
# Uninstall agent-hass-hook: remove Stop hook entries pointing at this
# project's stop.sh from ~/.claude/settings.json. Config and state are
# preserved unless --purge is passed.
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

err() { echo "uninstall.sh: error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

command -v jq >/dev/null || err "jq required."

SETTINGS="$HOME/.claude/settings.json"
if [[ -f "$SETTINGS" ]]; then
    info "Removing Stop hooks pointing at agent-hass-hook from $SETTINGS"
    tmp=$(mktemp)
    jq '
      if (.hooks.Stop // []) | length > 0 then
        .hooks.Stop |= (map(
          .hooks |= map(select(
            (.command // "") | (contains("agent-hass-hook") and contains("stop.sh")) | not
          ))
        ) | map(select(.hooks | length > 0)))
      else . end
    ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
    info "✓ Settings cleaned"
fi

INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/agent-hass-hook"
if [[ -d "$INSTALL_DIR" ]]; then
    info "Removing $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
fi

if [[ "$PURGE" == "1" ]]; then
    CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-hass-hook"
    STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/agent-hass-hook"
    [[ -d "$CONFIG_DIR" ]] && rm -rf "$CONFIG_DIR" && info "✓ Removed $CONFIG_DIR"
    [[ -d "$STATE_DIR" ]] && rm -rf "$STATE_DIR" && info "✓ Removed $STATE_DIR"
else
    info "Config and state preserved. Pass --purge to remove them."
fi
echo "Done."

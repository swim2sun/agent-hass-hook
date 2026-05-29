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

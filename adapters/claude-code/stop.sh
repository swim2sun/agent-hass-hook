#!/usr/bin/env bash
# Claude Code Stop hook adapter for agent-hass-hook.
#
# Reads no stdin itself — passes it through to the Python core. Honors
# AGENT_HASS_HOOK_DISABLE=1 by exiting 0 immediately (without invoking
# Python at all, which is the fastest possible disable path).
set -u

if [[ "${AGENT_HASS_HOOK_DISABLE:-}" == "1" ]]; then
    exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

python_bin="${AGENT_HASS_HOOK_PYTHON:-python3}"

cd "$repo_root" || exit 0
exec "$python_bin" -m core.agent_hass_hook on_stop

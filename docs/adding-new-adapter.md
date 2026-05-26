# Adding support for a new AI coding tool

The `core/` Python pipeline is AI-tool-agnostic. To support a new tool, create a new adapter that translates the tool's hook invocation into a call to the core.

## Steps

1. **Create the adapter directory**: `adapters/<tool-slug>/`
2. **Implement the entry script** (typically Bash) that the tool's hook system will invoke. The script must:
   - Respect `AGENT_HASS_HOOK_DISABLE=1` (exit 0 fast)
   - Pass stdin through unchanged (the core reads JSON from stdin)
   - Exec `python3 -m core.agent_hass_hook <event_name>` with `<event_name>` being one of: `on_stop`, `on_subagent_stop`, `on_notification`, etc. (Only `on_stop` is wired up in the MVP.)
3. **Document how to register the hook** in the tool's settings (e.g., a settings.json snippet for Cursor).

## Stdin contract

The core reads JSON from stdin and looks for these fields (all optional):

| Field | Type | Used for |
|---|---|---|
| `cwd` | string | Per-project disable check (walks up looking for `.no-hass-hook`) |
| `session_id` | string | Future: per-session deduplication |
| `last_assistant_message` | string | Future: semantic detection (error keywords, etc.) |

If the tool's native payload uses different names, the adapter is the right place to normalize them (e.g., `jq` to re-shape JSON before exec).

## Example: Claude Code (reference implementation)

See `adapters/claude-code/stop.sh`. Claude Code's native Stop payload already includes `cwd`, so we pass it through unchanged.

## Example: hypothetical Cursor adapter

```bash
#!/usr/bin/env bash
set -u
[[ "${AGENT_HASS_HOOK_DISABLE:-}" == "1" ]] && exit 0

# Cursor uses a different field name; rename it for the core.
input=$(cat)
normalized=$(echo "$input" | jq '{cwd: .working_directory, session_id: .conv_id}')

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
python_bin="${AGENT_HASS_HOOK_PYTHON:-python3}"
cd "$repo_root" || exit 0
echo "$normalized" | exec "$python_bin" -m core.agent_hass_hook on_stop
```

## Things you do NOT need to change

- `core/agent_hass_hook.py` and its modules
- `config.toml` schema (unless adding a new event type, in which case add `[[on_<event>]]`)
- The install/uninstall scripts (you'll add per-tool registration logic, not modify the core)

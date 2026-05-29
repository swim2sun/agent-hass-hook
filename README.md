# agent-hass-hook

Make Home Assistant your physical-world notification channel for AI coding agents. When Claude Code finishes a task, your light turns on (or any HA service runs).

Claude Code events (`Stop`, `UserPromptSubmit`) → call any configured HA service. The core is a generic `event → actions` dispatcher; "behavior modes" are just config presets the installer expands (see [Behavior modes](#behavior-modes)). Adding more AI tools (Cursor, Codex, etc.) or more events is a matter of adding adapters / config entries — the core stays the same.

## Why use this instead of...

- **claude-lamp** (BLE Moonside): locks you to one lamp brand. We go through HA, so anything HA controls works.
- **claude-notifications-go** (webhooks): great for Slack/Discord, but no HA awareness. We're HA-first.
- **peon-ping** (audio/desktop): notifies on the same machine; we trigger external devices.

## Requirements

- Linux or macOS
- Python 3.11+ (uses stdlib `tomllib`)
- Home Assistant with at least one entity you want to control
- A long-lived access token (HA UI: Profile → Security → Long-Lived Access Tokens)

## Install

```bash
git clone https://github.com/<you>/agent-hass-hook.git
cd agent-hass-hook
./install.sh
```

The installer is **jq-free** (Python-only) and guides you through setup. It will:

1. Copy files to `~/.local/share/agent-hass-hook/`
2. Prompt for HA URL + token, verify connectivity, and **list your lights** so you can pick a device by number (or type an entity ID)
3. Let you pick a **behavior preset** (A, C, or DIY — see [Behavior modes](#behavior-modes))
4. Write `~/.config/agent-hass-hook/config.toml` (mode 600) and verify the chosen entity exists
5. Register the hook entries for every event the preset uses in `~/.claude/settings.json` (e.g. `Stop` and `UserPromptSubmit`)

**Development install** (no copy; hook points at the repo): `./install.sh --dev`

**Skip prompts**: `./install.sh --no-config --skip-test` (assumes config is already in place)

## Behavior modes

A "mode" is just a config template the installer expands into the generic
`event → actions` model below. The runtime knows nothing about modes — it only
dispatches the actions configured for the event it's invoked with. The installer
offers these presets:

- **Preset A — work-off / done-on (default).** Light turns **off** while you're
  working (`on_user_prompt_submit` → `light.turn_off`) and back **on** when
  Claude finishes (`on_stop` → `light.turn_on`).
- **Preset C — color-temp state.** Light goes **warm/dim** while working
  (`on_user_prompt_submit` → `light.turn_on` with `color_temp_kelvin` = warm,
  `brightness_pct = 50`) and **cool/bright** when done (`on_stop` →
  `light.turn_on` with `color_temp_kelvin` = cool, `brightness_pct = 100`).
  Requires a device that supports `color_temp`; the installer falls back to
  preset A if yours doesn't.
- **DIY.** Writes a commented `config.toml` you edit by hand.

## Configuration

Stored at `~/.config/agent-hass-hook/config.toml`. See `config.example.toml` for
the full schema. Most fields have sensible defaults; the required ones are
`[ha].url`, `[ha].token`, and at least one `[[on_<event>]]` entry.

The config is an **event → actions map**. Each `[[on_<event>]]` table is one HA
service call; repeat a table to fire multiple actions for the same event. The
supported Claude Code events are:

- `[[on_user_prompt_submit]]` — fires when you submit a prompt (Claude starts working).
- `[[on_stop]]` — fires when Claude finishes responding.

```toml
# Off while working...
[[on_user_prompt_submit]]
service = "light.turn_off"
data = { entity_id = "light.xiaomi_monitor_lamp" }

# ...on when done.
[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.xiaomi_monitor_lamp" }

# Multiple actions per event — just repeat the table:
[[on_stop]]
service = "notify.mobile_app_my_phone"
data = { title = "Claude done", message = "Task complete" }

[[on_stop]]
service = "script.celebrate_done"
data = {}
```

An event with no configured actions is a silent no-op. The circuit breaker is
shared across all events.

## Environment variables

Scalar HA fields can be overridden without editing config:

| Variable | Effect |
|---|---|
| `AGENT_HASS_HOOK_DISABLE=1` | Skip the hook entirely (fastest disable; handled in the bash adapter before Python loads) |
| `AGENT_HASS_HOOK_HA_URL` | Override `[ha].url` |
| `AGENT_HASS_HOOK_HA_TOKEN` | Override `[ha].token` |
| `AGENT_HASS_HOOK_HA_VERIFY_SSL` | Override `[ha].verify_ssl` (accepts `false`/`0`/`no`/`off` as false) |
| `AGENT_HASS_HOOK_CONFIG` | Override config file path |
| `AGENT_HASS_HOOK_STATE_DIR` | Override state directory |
| `AGENT_HASS_HOOK_PYTHON` | Override Python interpreter used by the adapter |

## Disabling per project

Drop a `.no-hass-hook` file at the project root:

```bash
touch .no-hass-hook
```

The hook walks up from `cwd` looking for this marker. Add it to `.gitignore` if you don't want it tracked.

## What happens when HA is down?

The hook uses a 300ms connect timeout and 2s read timeout. If HA is unreachable, you'll wait ~300ms on the first three Stop events; after that the circuit breaker trips and subsequent invocations skip the HA call entirely (<10ms) for 5 minutes. The breaker auto-recovers when HA comes back.

## Logs

`~/.local/state/agent-hass-hook/hook.log` (JSONL, rotates at 1MB, keeps one backup `hook.log.1`).

```bash
tail -F ~/.local/state/agent-hass-hook/hook.log | jq .
```

## Uninstall

```bash
./uninstall.sh             # removes the hook entry; keeps config + state
./uninstall.sh --purge     # also removes config and logs
```

## Running tests

```bash
python3 -m unittest discover -s tests -v
bash tests/test_e2e.sh
```

## Adding support for a new AI tool

See `docs/adding-new-adapter.md`.

## Architecture

- **`adapters/<tool>/`** — bash entry points specific to each AI tool's hook system. For Claude Code, `hook.sh <event>` is the generic dispatcher (e.g. `hook.sh on_stop`, `hook.sh on_user_prompt_submit`); `stop.sh` is a backward-compat shim that forwards to `hook.sh on_stop`.
- **`core/agent_hass_hook.py`** — main pipeline (read stdin, disable check, breaker, HA call, log)
- **`core/{config,ha_client,circuit_breaker,logger}.py`** — single-responsibility modules

Synchronous execution: hooks block Claude Code briefly. The 300ms+2s+breaker combo bounds worst-case impact even when HA is dead.

## License

MIT

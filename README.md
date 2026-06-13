<p align="center">
  <img src="https://raw.githubusercontent.com/swim2sun/agent-hass-hook/main/assets/logo.png" alt="agent-hass-hook logo" width="180" height="180">
</p>

# agent-hass-hook

Make Home Assistant your physical-world notification channel for AI coding agents. When Claude Code finishes a task, your light turns on (or any HA service runs).

Claude Code events (`Stop`, `UserPromptSubmit`) → call any configured Home Assistant service. The runtime is a generic `event → actions` dispatcher; "behavior presets" are just config templates the installer expands. Custom setups are first-class — the runtime has no notion of modes, so you can hand-edit `config.json` to wire any event to any service call.

## Why use this instead of...

- **claude-lamp** (BLE Moonside): locks you to one lamp brand. We go through HA, so anything HA controls works.
- **claude-notifications-go** (webhooks): great for Slack/Discord, but no HA awareness. We're HA-first.
- **peon-ping** (audio/desktop): notifies on the same machine; we trigger external devices.

## Requirements

- Node.js >= 18
- Home Assistant with at least one entity you want to control
- A long-lived access token (HA UI: Profile → Security → Long-Lived Access Tokens)

## Install

```bash
npx @swim2sun/agent-hass-hook
```

The interactive setup connects to Home Assistant, discovers your lights, lets you
pick a behavior preset (A: off-while-working / on-when-done, or C: warm-dim →
cool-bright), writes `~/.config/agent-hass-hook/config.json` (chmod 600), and
registers the `Stop` + `UserPromptSubmit` hooks in `~/.claude/settings.json`.

The registered hook points at the absolute path of the installed `dist/bin.js`
(not `npx`) so each event fires with minimal cold-start overhead.

## Uninstall

```bash
npx @swim2sun/agent-hass-hook uninstall
```

Removes the hook entries from every event array in `~/.claude/settings.json`
(idempotent — safe to run even if nothing is registered). Your `config.json` and
logs are left in place.

## Disable

- **Per session:** `export AGENT_HASS_HOOK_DISABLE=1`
- **Per project:** `touch .no-hass-hook` at the project root. The hook walks up
  from `cwd` looking for this marker; add it to `.gitignore` if you don't want it
  tracked.

## How it works

The registered hook command is `node <abs path>/dist/bin.js hook on_stop`
(and `... on_user_prompt_submit`). On each event it loads the config, looks up
that event's action list, and calls the Home Assistant REST API. Presets are
just templates that fill in the generic `events` map — the runtime has no notion
of "modes", so custom setups are first-class (hand-edit `config.json`).

## Configuration

Stored at `~/.config/agent-hass-hook/config.json` (chmod 600). The config is an
**event → actions map**. Each event maps to a list of HA service calls; list more
than one to fire multiple actions for the same event. Supported events:

- `on_user_prompt_submit` — fires when you submit a prompt (Claude starts working).
- `on_stop` — fires when Claude finishes responding.

```json
{
  "ha": { "url": "http://homeassistant.local:8123", "token": "..." },
  "events": {
    "on_user_prompt_submit": [
      { "service": "light.turn_off", "data": { "entity_id": "light.desk" } }
    ],
    "on_stop": [
      { "service": "light.turn_on", "data": { "entity_id": "light.desk" } },
      { "service": "notify.mobile_app_my_phone", "data": { "title": "Claude done", "message": "Task complete" } }
    ]
  }
}
```

An event with no configured actions is a silent no-op. The circuit breaker is
shared across all events.

## Environment variables

Scalar HA fields can be overridden without editing config:

| Variable | Effect |
|---|---|
| `AGENT_HASS_HOOK_DISABLE=1` | Skip the hook entirely (fastest disable) |
| `AGENT_HASS_HOOK_HA_URL` | Override `ha.url` |
| `AGENT_HASS_HOOK_HA_TOKEN` | Override `ha.token` |
| `AGENT_HASS_HOOK_HA_VERIFY_SSL` | Override `ha.verify_ssl` (accepts `false`/`0`/`no`/`off` as false) |
| `AGENT_HASS_HOOK_CONFIG` | Override config file path |
| `AGENT_HASS_HOOK_STATE_DIR` | Override state directory |

## What happens when HA is down?

The hook uses a short connect timeout and a 2s read timeout. If HA is unreachable
you'll wait briefly on the first few events; after that the circuit breaker trips
and subsequent invocations skip the HA call entirely for a cooldown window. The
breaker auto-recovers when HA comes back.

## Logs

`~/.local/state/agent-hass-hook/hook.log` (JSONL, rotates by size, keeps one
backup `hook.log.1`).

```bash
tail -F ~/.local/state/agent-hass-hook/hook.log | jq .
```

## License

MIT

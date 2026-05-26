# agent-hass-hook — Design Spec

**Date**: 2026-05-26
**Status**: Approved (brainstorming) → implementing
**Owner**: pig (xyyou@inspiregroup.com)

## Problem

When Claude Code finishes a task and returns control to the user, there is no physical-world cue. Long-running tasks force the user to monitor the terminal. The user wants to use Home Assistant (already deployed and integrated with a Xiaomi monitor lamp) as a feedback channel: when Claude Code's `Stop` event fires, turn on the lamp.

## Positioning

Existing prior art:

- **`bobek-balinek/claude-lamp`** — Claude Code state → Moonside lamp via direct BLE. Locked to one brand.
- **`777genius/claude-notifications-go`** — Claude Code → webhooks (Slack/Discord/Telegram/etc.). No Home Assistant.
- **`peon-ping`** — Multi-AI-tool → local audio/visual feedback. Doesn't integrate external devices.

**This project's niche: Home Assistant-first feedback layer for AI coding agents.** By going through HA, a single project supports any HA-controllable device (lights, plugs, notifications, scripts, scenes) without per-device code. The architecture also makes adding new AI tools (Cursor, Codex, etc.) trivial via the adapter pattern.

**MVP scope: Claude Code `Stop` event → HA `light.turn_on` on a configured entity.** Error handling for hook events (`PostToolUse` failure, etc.) is intentionally deferred.

## Goals

- Hook fires reliably on Claude Code `Stop` event
- HA outage MUST NOT degrade Claude Code's responsiveness (handled via short connect timeout + circuit breaker)
- Configuration errors visible to user; runtime errors silent (logged)
- Installation flow gets a working setup with one interactive run
- Per-project disable via filesystem marker; session-level disable via env var
- Architecture allows adding new AI tools as new adapters without core changes

## Non-Goals (MVP)

- Reacting to errors / failed tool calls (only `Stop`)
- Semantic analysis of Claude's response (no keyword matching on `last_assistant_message`)
- Flashing / animated light states (just `light.turn_on` with default state)
- Auto-off after N seconds (user turns off manually)
- Multi-device dispatch (config schema supports it; MVP uses one entry)
- Adapters for AI tools other than Claude Code
- Windows support (Linux/macOS only)
- MCP server / IDE plugin variants

## Architecture

```
Claude Code Stop event fires
    ↓ (stdin: JSON payload {cwd, session_id, last_assistant_message, ...})
adapters/claude-code/stop.sh
    ├─ Check $AGENT_HASS_HOOK_DISABLE → if "1", exit 0
    └─ exec python3 core/agent_hass_hook.py on_stop  (stdin piped through)
        ↓
core/agent_hass_hook.py (main)
    ├─ Read stdin JSON → extract cwd, session_id
    ├─ Walk up cwd looking for .no-hass-hook marker → exit 0 if found
    ├─ Load config (TOML + env override)
    ├─ Check circuit breaker state → exit 0 if breaker open
    ├─ For each action in config[on_stop]: call HA service
    │     └─ Update breaker on success/failure
    └─ Write log line, exit 0
```

**Components**:

| Component | Language | Purpose |
|---|---|---|
| `adapters/claude-code/stop.sh` | Bash | Thin AI-tool-specific entry; env disable check only |
| `core/agent_hass_hook.py` | Python 3.11+ | Main dispatcher: reads stdin, runs the pipeline |
| `core/config.py` | Python | Load TOML + env override + validation |
| `core/ha_client.py` | Python (urllib) | HA REST client with timeout config |
| `core/circuit_breaker.py` | Python | Read/update breaker state JSON |
| `core/logger.py` | Python | Append-only JSONL log with size-based rotation |
| `install.sh` | Bash + jq | Dependency check, config prompt, connectivity test, settings.json patch |
| `uninstall.sh` | Bash + jq | Remove hook entry; optional `--purge` for state |

**Why Python (not TS/JS):**
- Stdlib has everything we need (tomllib in 3.11+, urllib, http.server for tests, json)
- Lower cold-start latency than Node (~30-50ms vs ~50-150ms — relevant per hook invocation)
- `python3` is near-universal on Linux/macOS dev machines; Node is not guaranteed
- peon-ping's hook adapters are Shell-based, not TS — our architecture is analogous

**Why Bash for adapters and install:**
- Adapter must be invoked by Claude Code's hook system; shell is the universal target
- Adapter logic is minimal (env check + exec); no need for richer language
- Install operates on shell-y things (jq pipes, file permissions, prompts)

## Configuration

**Location**: `~/.config/agent-hass-hook/config.toml`, mode `0600`.

**Schema**:

```toml
[ha]
url = "http://192.168.1.100:8123"
token = "eyJ0eXAiOi..."
verify_ssl = true

[timeouts]
connect_ms = 300
read_ms = 2000

[circuit_breaker]
failure_threshold = 3
open_duration_sec = 300

[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.xiaomi_monitor_lamp_xxx" }
```

**Environment variable overrides** (scalar fields only):

| Env var | Overrides |
|---|---|
| `AGENT_HASS_HOOK_HA_URL` | `[ha].url` |
| `AGENT_HASS_HOOK_HA_TOKEN` | `[ha].token` |
| `AGENT_HASS_HOOK_HA_VERIFY_SSL` | `[ha].verify_ssl` |
| `AGENT_HASS_HOOK_DISABLE=1` | Skip everything (handled in adapter, before Python) |

The `[[on_stop]]` action array cannot be overridden by env vars — business logic stays in the config file.

**Required fields**: `ha.url`, `ha.token`, at least one `[[on_stop]]` entry with `service` and `data`. Missing required fields cause a config error.

## Data Flow Details

**Stdin handling**: adapter passes stdin to Python unchanged. Python parses JSON, extracts `cwd` (used for project-disable check) and stores the rest for future event-type expansion (e.g., `last_assistant_message` keyword scanning is not done in MVP but the data is available).

**Per-project disable**: starting from `cwd` (from stdin JSON if present, else `os.getcwd()`), walk up directory tree (stopping at `/`) looking for `.no-hass-hook` file. File content is ignored — presence alone is the disable signal. First hit → exit 0 with log `{"result": "skipped", "reason": "project_disabled"}`.

**HA call**: For each action in `[[on_stop]]`:
- `POST {ha.url}/api/services/{domain}/{service}` (domain split from `service` on first `.`)
- Headers: `Authorization: Bearer {token}`, `Content-Type: application/json`
- Body: JSON-encoded `data` dict
- Connect timeout `connect_ms`, read timeout `read_ms`
- 2xx response → success; 4xx/5xx/timeout/connection-error → failure

## Error Handling

**Exit codes** (adapter and core both):

| Scenario | Exit | stderr | Log |
|---|---|---|---|
| Successful HA call | 0 | — | `result: ok` |
| Disabled (env or marker) | 0 | — | `result: skipped, reason: ...` |
| Circuit breaker open | 0 | — | `result: skipped, reason: breaker_open` |
| HA call failed (any reason) | 0 | — | `result: failed, error: ...` |
| Config file missing | 0 | One-line hint pointing at install.sh | `result: failed, error: config_missing` |
| Config file present but invalid | 0 | One-line hint identifying the bad field | `result: failed, error: config_invalid` |

**Principle**: runtime errors (HA down, network, timeout) are silent to the user — they're transient. Config errors are user-actionable and surfaced via stderr (which Claude Code displays).

**Exit always 0**: Claude Code should never see a hook failure. Even fatal errors are caught and logged.

## Circuit Breaker

**State file**: `~/.local/state/agent-hass-hook/breaker.json`

```json
{"consecutive_failures": 0, "tripped_at": null}
```

**State machine**:

| Current state | Event | Next state |
|---|---|---|
| Closed (`tripped_at = null`) | HA success | `consecutive_failures = 0` |
| Closed | HA failure | `consecutive_failures += 1`; if `>= 3`, set `tripped_at = now` |
| Open (`tripped_at != null`, < 300s ago) | Hook invocation | Skip HA call entirely, log `breaker_open` |
| Open (>= 300s ago) | Hook invocation | Treat as half-open: try once; success → clear state; failure → reset `tripped_at = now` |

**Parameters** (configurable via `[circuit_breaker]` block): `failure_threshold = 3`, `open_duration_sec = 300`.

**Deliberately not implemented (YAGNI)**:
- Exponential backoff (fixed 5min window is fine)
- Multi-stage half-open (one success reopens fully)
- Failure type discrimination (timeout = 5xx = same)

## Logging

**Location**: `~/.local/state/agent-hass-hook/hook.log`

**Format**: JSONL, one line per hook invocation:

```jsonl
{"ts": "2026-05-26T18:23:14Z", "event": "on_stop", "cwd": "/home/pig/Repos/foo", "result": "ok", "duration_ms": 87}
{"ts": "2026-05-26T18:24:01Z", "event": "on_stop", "cwd": "/home/pig/Repos/bar", "result": "skipped", "reason": "project_disabled"}
{"ts": "2026-05-26T18:24:55Z", "event": "on_stop", "cwd": "/home/pig/Repos/foo", "result": "failed", "error": "connection_timeout"}
```

**Rotation**: on startup, if `hook.log` size > 1 MB → `mv hook.log hook.log.1` (overwriting existing `.1`), open new `hook.log`. Maximum two files, ~2 MB total.

## Installation Flow

**`install.sh`**:

1. Detect host platform (must be Linux or macOS; error on others)
2. Check deps: `python3 --version` (>=3.11), `jq --version`, `curl --version`. Any missing → error with install hints (`apt install jq`, etc.).
3. Determine install path:
   - Default: `~/.local/share/agent-hass-hook/` — copy `core/`, `adapters/` here
   - With `--dev`: skip copy, point hook command at current repo path (for development)
4. Configuration (skip with `--no-config`):
   - If `~/.config/agent-hass-hook/config.toml` exists → ask: keep / overwrite / abort
   - Prompt for: HA URL, token (hidden input), entity_id
   - Write to `~/.config/agent-hass-hook/config.toml` with `chmod 600`
5. Connectivity test (skip with `--skip-test`):
   - `curl -fsS -H "Authorization: Bearer <token>" <url>/api/` → check 200 with `{"message": "API running."}`
   - `curl -fsS -H "Authorization: Bearer <token>" <url>/api/states/<entity_id>` → check 200 with valid state
   - Failure → print specific reason, offer to re-prompt or abort
6. Register hook in `~/.claude/settings.json`:
   - Read existing JSON (create empty `{}` if absent)
   - Merge in:
     ```json
     {"hooks": {"Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "<install-path>/adapters/claude-code/stop.sh"}]}]}}
     ```
   - Use `jq` for safe merge; preserve existing entries; idempotent (don't add duplicate command)
   - Write back with same permissions

**`uninstall.sh`**:

1. Remove hook entry from `~/.claude/settings.json` (match by command path; use jq)
2. Default: keep `~/.config/agent-hass-hook/` and `~/.local/state/agent-hass-hook/`
3. With `--purge`: delete config + state

## Testing Strategy

**Unit tests** (`tests/test_*.py`, run via `python -m unittest`):

- `test_config.py` — TOML parsing, env override precedence, missing-field detection, invalid-type detection
- `test_circuit_breaker.py` — every state-machine branch (closed→success, closed→failure, threshold crossing, open→skipped, half-open→success/failure)
- `test_ha_client.py` — uses `http.server` to spin up a mock HA on 127.0.0.1; tests connect timeout, read timeout, 2xx success, 4xx/5xx error, malformed response, connection refused
- `test_logger.py` — JSONL format, rotation at 1MB threshold
- `test_disable.py` — `.no-hass-hook` marker walk-up logic

**Integration test** (`tests/test_e2e.sh`):

- Start mock HA via `http.server` (Python subprocess)
- Pipe a realistic Stop hook JSON payload to `adapters/claude-code/stop.sh` with env vars overriding config
- Assert: mock HA received correct `POST /api/services/light/turn_on` with correct body; log line written with `result: ok`
- Run scenarios: success, disabled-by-env, disabled-by-marker, HA-returns-500 (breaker not yet tripped), HA-down (3x → breaker trips → 4th call skipped)

**No external dependencies for tests**: stdlib only, no pytest, no requests-mock.

## Repo Layout

```
agent-hass-hook/
├── adapters/
│   └── claude-code/
│       └── stop.sh
├── core/
│   ├── __init__.py
│   ├── agent_hass_hook.py
│   ├── config.py
│   ├── ha_client.py
│   ├── circuit_breaker.py
│   └── logger.py
├── tests/
│   ├── __init__.py
│   ├── test_config.py
│   ├── test_circuit_breaker.py
│   ├── test_ha_client.py
│   ├── test_logger.py
│   ├── test_disable.py
│   └── test_e2e.sh
├── install.sh
├── uninstall.sh
├── config.example.toml
├── .gitignore
├── README.md
└── docs/
    ├── superpowers/
    │   └── specs/
    │       └── 2026-05-26-agent-hass-hook-design.md   (this file)
    └── adding-new-adapter.md
```

## Open Questions Resolved

| Question | Decision |
|---|---|
| Which Claude Code hook? | `Stop` only (no `PostToolUse` for errors) |
| Action on Stop? | Simple turn-on (no flashing, no auto-off) |
| Hook scope? | Global, with per-project marker file + env disable |
| Language? | Bash adapter + Python core |
| Config storage? | TOML at XDG path + env vars override |
| Action abstraction? | HA service array (`[[on_stop]]`) |
| Execution model? | Sync with 300ms connect + 2s read timeout + circuit breaker |
| Install UX? | Interactive prompts + `--no-config`/`--skip-test` flags + connectivity test |
| Stdin propagation? | Pass through to Python (for future event-type expansion) |

## Future Extensions (Post-MVP, Not Designed Here)

- **More AI tools**: Cursor / Codex / Copilot adapters under `adapters/{tool-name}/`. Each translates the tool's hook payload to our internal format, then invokes the same Python core.
- **More event types**: `on_subagent_stop`, `on_notification`, `on_post_tool_use_error`, `on_session_end`. Each becomes a new `[[event-name]]` block in TOML.
- **Semantic detection**: scan `last_assistant_message` for error keywords, route to different actions.
- **Multi-device per event**: already supported by schema (array); just add more entries.
- **MCP server**: completely separate component, not part of this design.
- **Windows support**: would need PowerShell adapter; not blocking other future work.

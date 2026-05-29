"""agent-hass-hook main entry point.

Reads stdin JSON, applies disable rules, loads config, checks circuit
breaker, calls HA service(s), logs the outcome. Always exits 0 — Claude
Code should never see a hook failure. Configuration errors are surfaced
on stderr because they're user-actionable.
"""
from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from core.config import ConfigError, load_config
from core.circuit_breaker import CircuitBreaker
from core.ha_client import call_service
from core.logger import HookLogger


@dataclass(frozen=True)
class Paths:
    config_path: Path
    state_dir: Path

    @property
    def log_path(self) -> Path:
        return self.state_dir / "hook.log"

    @property
    def breaker_path(self) -> Path:
        return self.state_dir / "breaker.json"


def find_disable_marker(start: Path) -> Path | None:
    """Walk up from `start` looking for a .no-hass-hook file. Returns its
    path if found, else None. Stops at filesystem root."""
    current = start.resolve() if start.exists() else start
    seen: set[Path] = set()
    while True:
        if current in seen:
            return None
        seen.add(current)
        candidate = current / ".no-hass-hook"
        if candidate.exists():
            return candidate
        if current == current.parent:
            return None
        current = current.parent


def default_paths() -> Paths:
    cfg = os.environ.get("AGENT_HASS_HOOK_CONFIG")
    cfg_path = Path(cfg) if cfg else Path.home() / ".config" / "agent-hass-hook" / "config.toml"
    state = os.environ.get("AGENT_HASS_HOOK_STATE_DIR")
    state_dir = Path(state) if state else Path.home() / ".local" / "state" / "agent-hass-hook"
    return Paths(config_path=cfg_path, state_dir=state_dir)


def main(
    argv: list[str],
    stdin_text: str,
    env: dict,
    paths: Paths,
    *,
    stderr: TextIO | None = None,
) -> int:
    stderr = stderr if stderr is not None else sys.stderr

    event = argv[0] if argv else "unknown"
    logger = HookLogger(paths.log_path)

    payload: dict = {}
    if stdin_text.strip():
        try:
            payload = json.loads(stdin_text)
            if not isinstance(payload, dict):
                payload = {}
        except json.JSONDecodeError:
            payload = {}

    cwd = payload.get("cwd") or os.getcwd()
    cwd_path = Path(cwd)

    marker = find_disable_marker(cwd_path)
    if marker is not None:
        logger.log(
            event=event, cwd=str(cwd_path), result="skipped",
            reason="project_disabled", marker=str(marker),
        )
        return 0

    saved_env: dict[str, str | None] = {}
    for k, v in env.items():
        saved_env[k] = os.environ.get(k)
        os.environ[k] = v
    try:
        cfg = load_config(paths.config_path)
    except ConfigError as e:
        logger.log(event=event, cwd=str(cwd_path), result="failed", error="config_error", detail=str(e))
        print(f"agent-hass-hook: config error: {e}", file=stderr)
        return 0
    finally:
        for k, old in saved_env.items():
            if old is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = old

    actions = cfg.events.get(event, [])
    if not actions:
        return 0  # no actions configured for this event — silent no-op

    breaker = CircuitBreaker(
        state_path=paths.breaker_path,
        failure_threshold=cfg.breaker.failure_threshold,
        open_duration_sec=cfg.breaker.open_duration_sec,
    )
    if breaker.should_skip():
        logger.log(event=event, cwd=str(cwd_path), result="skipped", reason="breaker_open")
        return 0

    any_failure = False
    for action in actions:
        t_start = time.monotonic()
        result = call_service(
            cfg.ha.url, cfg.ha.token, action.service, action.data,
            connect_ms=cfg.timeouts.connect_ms,
            read_ms=cfg.timeouts.read_ms,
            verify_ssl=cfg.ha.verify_ssl,
        )
        duration_ms = result.duration_ms if result.duration_ms is not None else int((time.monotonic() - t_start) * 1000)
        if result.ok:
            logger.log(
                event=event, cwd=str(cwd_path), result="ok",
                service=action.service, status=result.status, duration_ms=duration_ms,
            )
        else:
            any_failure = True
            logger.log(
                event=event, cwd=str(cwd_path), result="failed",
                service=action.service, error=result.error, status=result.status,
                duration_ms=duration_ms,
            )

    if any_failure:
        breaker.record_failure()
    else:
        breaker.record_success()
    return 0


if __name__ == "__main__":
    paths = default_paths()
    stdin_text = sys.stdin.read() if not sys.stdin.isatty() else ""
    sys.exit(main(sys.argv[1:], stdin_text, dict(os.environ), paths))

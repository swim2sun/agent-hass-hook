"""Configuration loading for agent-hass-hook.

Reads TOML from a path, applies environment variable overrides for the
scalar HA fields, and validates required fields. Raises ConfigError on
any user-fixable problem.
"""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path


class ConfigError(Exception):
    """Raised when configuration is missing, malformed, or invalid."""


@dataclass(frozen=True)
class HAConfig:
    url: str
    token: str
    verify_ssl: bool = True


@dataclass(frozen=True)
class Timeouts:
    connect_ms: int = 300
    read_ms: int = 2000


@dataclass(frozen=True)
class BreakerConfig:
    failure_threshold: int = 3
    open_duration_sec: int = 300


@dataclass(frozen=True)
class Action:
    service: str
    data: dict


@dataclass(frozen=True)
class Config:
    ha: HAConfig
    timeouts: Timeouts
    breaker: BreakerConfig
    on_stop: list[Action]


def _env_bool(value: str) -> bool:
    return value.strip().lower() not in ("false", "0", "no", "off", "")


def load_config(path: Path) -> Config:
    if not path.exists():
        raise ConfigError(f"Config file not found: {path}")

    try:
        with open(path, "rb") as f:
            raw = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"Failed to parse TOML in {path}: {e}") from e

    ha_raw = raw.get("ha", {})
    if not isinstance(ha_raw, dict):
        raise ConfigError("[ha] must be a table")

    url = os.environ.get("AGENT_HASS_HOOK_HA_URL") or ha_raw.get("url")
    if not url:
        raise ConfigError("[ha].url is required (or set AGENT_HASS_HOOK_HA_URL)")

    token = os.environ.get("AGENT_HASS_HOOK_HA_TOKEN") or ha_raw.get("token")
    if not token:
        raise ConfigError("[ha].token is required (or set AGENT_HASS_HOOK_HA_TOKEN)")

    verify_ssl_env = os.environ.get("AGENT_HASS_HOOK_HA_VERIFY_SSL")
    if verify_ssl_env is not None:
        verify_ssl = _env_bool(verify_ssl_env)
    else:
        verify_ssl = bool(ha_raw.get("verify_ssl", True))

    ha = HAConfig(url=url, token=token, verify_ssl=verify_ssl)

    t_raw = raw.get("timeouts", {})
    if not isinstance(t_raw, dict):
        raise ConfigError("[timeouts] must be a table")
    timeouts = Timeouts(
        connect_ms=int(t_raw.get("connect_ms", 300)),
        read_ms=int(t_raw.get("read_ms", 2000)),
    )

    b_raw = raw.get("circuit_breaker", {})
    if not isinstance(b_raw, dict):
        raise ConfigError("[circuit_breaker] must be a table")
    breaker = BreakerConfig(
        failure_threshold=int(b_raw.get("failure_threshold", 3)),
        open_duration_sec=int(b_raw.get("open_duration_sec", 300)),
    )

    on_stop_raw = raw.get("on_stop")
    if not on_stop_raw or not isinstance(on_stop_raw, list):
        raise ConfigError("[[on_stop]] requires at least one entry")

    actions: list[Action] = []
    for idx, entry in enumerate(on_stop_raw):
        if not isinstance(entry, dict):
            raise ConfigError(f"[[on_stop]] entry {idx} must be a table")
        service = entry.get("service")
        if not service or not isinstance(service, str) or "." not in service:
            raise ConfigError(
                f"[[on_stop]] entry {idx}: 'service' must be 'domain.service' (e.g. 'light.turn_on')"
            )
        data = entry.get("data", {})
        if not isinstance(data, dict):
            raise ConfigError(f"[[on_stop]] entry {idx}: 'data' must be a table")
        actions.append(Action(service=service, data=dict(data)))

    return Config(ha=ha, timeouts=timeouts, breaker=breaker, on_stop=actions)

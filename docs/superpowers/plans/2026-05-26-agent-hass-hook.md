# agent-hass-hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP of agent-hass-hook: when Claude Code's Stop event fires, call a configured Home Assistant service (default: turn on a light).

**Architecture:** Bash adapter receives Claude Code's Stop event, performs env-disable check, then execs a Python core that loads TOML config, walks up cwd for a `.no-hass-hook` marker, checks a circuit breaker, and POSTs to HA's `/api/services/{domain}/{service}` endpoint. Synchronous execution with 300ms connect / 2s read timeouts; circuit breaker trips after 3 consecutive failures for a 5-minute cool-down. Single HA outage cannot block Claude Code beyond the first ~900ms total.

**Tech Stack:** Python 3.11+ (stdlib only: `tomllib`, `urllib`, `http.client`, `http.server`, `json`, `ssl`, `unittest`), Bash, jq, curl.

**Reference spec:** `docs/superpowers/specs/2026-05-26-agent-hass-hook-design.md`

---

## File Structure

```
agent-hass-hook/
├── adapters/
│   └── claude-code/
│       └── stop.sh                       # Bash: env disable check + exec python core
├── core/
│   ├── __init__.py
│   ├── agent_hass_hook.py                # Main: read stdin, run pipeline, exit 0
│   ├── config.py                         # TOML load + env override + validate
│   ├── ha_client.py                      # HA REST POST with split connect/read timeouts
│   ├── circuit_breaker.py                # State JSON + state-machine logic
│   └── logger.py                         # JSONL append + 1MB rotation
├── tests/
│   ├── __init__.py
│   ├── test_config.py
│   ├── test_logger.py
│   ├── test_circuit_breaker.py
│   ├── test_ha_client.py
│   ├── test_disable.py
│   ├── test_main.py
│   └── test_e2e.sh
├── install.sh
├── uninstall.sh
├── config.example.toml
├── .gitignore
├── README.md
└── docs/
    ├── superpowers/
    │   ├── specs/2026-05-26-agent-hass-hook-design.md
    │   └── plans/2026-05-26-agent-hass-hook.md          (this file)
    └── adding-new-adapter.md
```

**Module responsibilities (one purpose each):**

- `config.py` — knows TOML, env-var override rules, required-field validation. No I/O beyond reading the config file.
- `logger.py` — knows JSONL log format and size-based rotation. Stateless beyond the file.
- `circuit_breaker.py` — knows the breaker state machine. Reads/writes a state JSON.
- `ha_client.py` — knows HA REST API. Takes URL, token, service, data, timeouts. Returns success/failure.
- `agent_hass_hook.py` — wires them together. Reads stdin, parses event, applies disable rules, runs actions, logs.

---

## Task 1: Project scaffolding

**Files:**
- Create: `.gitignore`
- Create: `core/__init__.py` (empty)
- Create: `tests/__init__.py` (empty)
- Create: `config.example.toml`

- [ ] **Step 1: Create `.gitignore`**

```
__pycache__/
*.pyc
*.pyo
.pytest_cache/
.venv/
venv/
.DS_Store
*.swp
*.swo
*~

# Local config we'd never want to commit
config.toml
*.token
.env
```

- [ ] **Step 2: Create empty `core/__init__.py` and `tests/__init__.py`**

Use the Write tool to create both as empty files (zero bytes).

- [ ] **Step 3: Create `config.example.toml`**

```toml
# Copy this to ~/.config/agent-hass-hook/config.toml and edit.
# Run install.sh for interactive setup instead of editing by hand.

[ha]
url = "http://192.168.1.100:8123"
# Long-lived access token from HA: Profile -> Security -> Long-Lived Access Tokens
token = "REPLACE_WITH_YOUR_HA_TOKEN"
# Set to false for self-signed certs.
verify_ssl = true

# Timeouts in milliseconds. Defaults shown.
[timeouts]
connect_ms = 300
read_ms = 2000

# Circuit breaker: skip HA calls for `open_duration_sec` after `failure_threshold`
# consecutive failures. Prevents HA outages from slowing Claude Code's responsiveness.
[circuit_breaker]
failure_threshold = 3
open_duration_sec = 300

# Actions to run when Claude Code's Stop event fires. Array of HA service calls.
# Add more entries (each starting with [[on_stop]]) to fire multiple actions.
[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.xiaomi_monitor_lamp_REPLACE" }

# Examples for inspiration (uncomment and edit):
# [[on_stop]]
# service = "notify.mobile_app_my_phone"
# data = { title = "Claude finished", message = "Task complete" }
#
# [[on_stop]]
# service = "script.celebrate"
# data = {}
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore core/__init__.py tests/__init__.py config.example.toml
git commit -m "scaffold: gitignore, package init files, config example

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Implement `config.py` (TDD)

**Files:**
- Create: `core/config.py`
- Create: `tests/test_config.py`

**Module contract:**

```python
class ConfigError(Exception): pass

@dataclass(frozen=True)
class HAConfig:
    url: str
    token: str
    verify_ssl: bool

@dataclass(frozen=True)
class Timeouts:
    connect_ms: int
    read_ms: int

@dataclass(frozen=True)
class BreakerConfig:
    failure_threshold: int
    open_duration_sec: int

@dataclass(frozen=True)
class Action:
    service: str      # e.g. "light.turn_on"
    data: dict        # arbitrary JSON-serializable

@dataclass(frozen=True)
class Config:
    ha: HAConfig
    timeouts: Timeouts
    breaker: BreakerConfig
    on_stop: list[Action]

def load_config(path: pathlib.Path) -> Config:
    """Load TOML from path, apply env overrides, validate. Raises ConfigError."""
```

- [ ] **Step 1: Write failing tests in `tests/test_config.py`**

```python
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core.config import load_config, ConfigError


def write_config(content: str) -> Path:
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".toml", delete=False)
    f.write(content)
    f.close()
    return Path(f.name)


VALID = """
[ha]
url = "http://localhost:8123"
token = "abc"
verify_ssl = true

[timeouts]
connect_ms = 300
read_ms = 2000

[circuit_breaker]
failure_threshold = 3
open_duration_sec = 300

[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.test" }
"""


class TestConfigLoad(unittest.TestCase):

    def test_valid_config_loads(self):
        p = write_config(VALID)
        cfg = load_config(p)
        self.assertEqual(cfg.ha.url, "http://localhost:8123")
        self.assertEqual(cfg.ha.token, "abc")
        self.assertTrue(cfg.ha.verify_ssl)
        self.assertEqual(cfg.timeouts.connect_ms, 300)
        self.assertEqual(cfg.timeouts.read_ms, 2000)
        self.assertEqual(cfg.breaker.failure_threshold, 3)
        self.assertEqual(cfg.breaker.open_duration_sec, 300)
        self.assertEqual(len(cfg.on_stop), 1)
        self.assertEqual(cfg.on_stop[0].service, "light.turn_on")
        self.assertEqual(cfg.on_stop[0].data, {"entity_id": "light.test"})

    def test_missing_file_raises(self):
        with self.assertRaises(ConfigError) as ctx:
            load_config(Path("/nonexistent/config.toml"))
        self.assertIn("not found", str(ctx.exception).lower())

    def test_missing_ha_url_raises(self):
        p = write_config(VALID.replace('url = "http://localhost:8123"', ""))
        with self.assertRaises(ConfigError) as ctx:
            load_config(p)
        self.assertIn("url", str(ctx.exception).lower())

    def test_missing_ha_token_raises(self):
        p = write_config(VALID.replace('token = "abc"', ""))
        with self.assertRaises(ConfigError) as ctx:
            load_config(p)
        self.assertIn("token", str(ctx.exception).lower())

    def test_missing_on_stop_raises(self):
        # Remove the on_stop block.
        content = VALID.split("[[on_stop]]")[0]
        p = write_config(content)
        with self.assertRaises(ConfigError) as ctx:
            load_config(p)
        self.assertIn("on_stop", str(ctx.exception).lower())

    def test_on_stop_missing_service_raises(self):
        bad = VALID.replace('service = "light.turn_on"', "")
        p = write_config(bad)
        with self.assertRaises(ConfigError) as ctx:
            load_config(p)
        self.assertIn("service", str(ctx.exception).lower())

    def test_env_overrides_url(self):
        p = write_config(VALID)
        with patch.dict(os.environ, {"AGENT_HASS_HOOK_HA_URL": "http://override:8123"}):
            cfg = load_config(p)
        self.assertEqual(cfg.ha.url, "http://override:8123")

    def test_env_overrides_token(self):
        p = write_config(VALID)
        with patch.dict(os.environ, {"AGENT_HASS_HOOK_HA_TOKEN": "newtoken"}):
            cfg = load_config(p)
        self.assertEqual(cfg.ha.token, "newtoken")

    def test_env_overrides_verify_ssl_false(self):
        p = write_config(VALID)
        for val in ("false", "0", "False", "FALSE"):
            with patch.dict(os.environ, {"AGENT_HASS_HOOK_HA_VERIFY_SSL": val}):
                cfg = load_config(p)
            self.assertFalse(cfg.ha.verify_ssl, f"value {val!r} should be False")

    def test_defaults_for_optional_blocks(self):
        # If [timeouts] and [circuit_breaker] are missing, defaults apply.
        minimal = """
[ha]
url = "http://localhost:8123"
token = "abc"

[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.test" }
"""
        p = write_config(minimal)
        cfg = load_config(p)
        self.assertEqual(cfg.timeouts.connect_ms, 300)
        self.assertEqual(cfg.timeouts.read_ms, 2000)
        self.assertEqual(cfg.breaker.failure_threshold, 3)
        self.assertEqual(cfg.breaker.open_duration_sec, 300)
        self.assertTrue(cfg.ha.verify_ssl)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/pig/Repos/agent-hass-hook
python -m unittest tests.test_config -v
```

Expected: `ModuleNotFoundError: No module named 'core.config'` (or similar).

- [ ] **Step 3: Implement `core/config.py`**

```python
"""Configuration loading for agent-hass-hook.

Reads TOML from a path, applies environment variable overrides for the
scalar HA fields, and validates required fields. Raises ConfigError on
any user-fixable problem.
"""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


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

    # --- [ha] section
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

    # --- [timeouts] section (optional, has defaults)
    t_raw = raw.get("timeouts", {})
    if not isinstance(t_raw, dict):
        raise ConfigError("[timeouts] must be a table")
    timeouts = Timeouts(
        connect_ms=int(t_raw.get("connect_ms", 300)),
        read_ms=int(t_raw.get("read_ms", 2000)),
    )

    # --- [circuit_breaker] section (optional, has defaults)
    b_raw = raw.get("circuit_breaker", {})
    if not isinstance(b_raw, dict):
        raise ConfigError("[circuit_breaker] must be a table")
    breaker = BreakerConfig(
        failure_threshold=int(b_raw.get("failure_threshold", 3)),
        open_duration_sec=int(b_raw.get("open_duration_sec", 300)),
    )

    # --- [[on_stop]] array
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m unittest tests.test_config -v
```

Expected: all tests pass (10 tests).

- [ ] **Step 5: Commit**

```bash
git add core/config.py tests/test_config.py
git commit -m "feat(config): TOML loader with env override and validation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Implement `logger.py` (TDD)

**Files:**
- Create: `core/logger.py`
- Create: `tests/test_logger.py`

**Module contract:**

```python
class HookLogger:
    def __init__(self, log_path: pathlib.Path, max_bytes: int = 1_000_000):
        ...
    def log(self, **fields) -> None:
        """Append one JSON line with a 'ts' field auto-added. Rotates if file > max_bytes."""
```

- [ ] **Step 1: Write failing tests in `tests/test_logger.py`**

```python
import json
import tempfile
import unittest
from pathlib import Path

from core.logger import HookLogger


class TestHookLogger(unittest.TestCase):

    def test_writes_jsonl(self):
        with tempfile.TemporaryDirectory() as d:
            log_path = Path(d) / "hook.log"
            logger = HookLogger(log_path)
            logger.log(event="on_stop", result="ok")
            logger.log(event="on_stop", result="failed", error="timeout")

            lines = log_path.read_text().strip().split("\n")
            self.assertEqual(len(lines), 2)

            line1 = json.loads(lines[0])
            self.assertIn("ts", line1)
            self.assertEqual(line1["event"], "on_stop")
            self.assertEqual(line1["result"], "ok")

            line2 = json.loads(lines[1])
            self.assertEqual(line2["error"], "timeout")

    def test_creates_parent_dirs(self):
        with tempfile.TemporaryDirectory() as d:
            log_path = Path(d) / "nested" / "deep" / "hook.log"
            logger = HookLogger(log_path)
            logger.log(event="test")
            self.assertTrue(log_path.exists())

    def test_rotates_when_exceeding_max_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            log_path = Path(d) / "hook.log"
            # Pre-fill the log past the threshold.
            log_path.write_text("x" * 2000)
            logger = HookLogger(log_path, max_bytes=1000)
            logger.log(event="rotate_trigger")

            self.assertTrue((log_path.parent / "hook.log.1").exists())
            self.assertGreater(log_path.stat().st_size, 0)
            self.assertLess(log_path.stat().st_size, 1000)  # fresh file with just one line
            content = log_path.read_text()
            self.assertIn("rotate_trigger", content)

    def test_rotation_overwrites_old_backup(self):
        with tempfile.TemporaryDirectory() as d:
            log_path = Path(d) / "hook.log"
            backup = log_path.parent / "hook.log.1"
            backup.write_text("old backup")
            log_path.write_text("x" * 2000)

            logger = HookLogger(log_path, max_bytes=1000)
            logger.log(event="trigger")

            # Old backup should have been replaced by the rotated current log.
            self.assertNotIn("old backup", backup.read_text())

    def test_ts_is_iso8601_utc(self):
        with tempfile.TemporaryDirectory() as d:
            log_path = Path(d) / "hook.log"
            logger = HookLogger(log_path)
            logger.log(event="test")
            line = json.loads(log_path.read_text().strip())
            # e.g. "2026-05-26T18:23:14Z"
            self.assertRegex(line["ts"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m unittest tests.test_logger -v
```

Expected: ModuleNotFoundError for `core.logger`.

- [ ] **Step 3: Implement `core/logger.py`**

```python
"""Append-only JSONL logger with size-based rotation.

One line per hook invocation. On startup, if the log file is larger than
max_bytes, rename it to `<name>.1` (overwriting any existing .1) and open
a fresh file. Max two files total; older history is discarded.
"""
from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path


class HookLogger:
    def __init__(self, log_path: Path, max_bytes: int = 1_000_000):
        self.log_path = Path(log_path)
        self.max_bytes = max_bytes
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._maybe_rotate()

    def _maybe_rotate(self) -> None:
        if not self.log_path.exists():
            return
        try:
            size = self.log_path.stat().st_size
        except OSError:
            return
        if size <= self.max_bytes:
            return
        backup = self.log_path.with_suffix(self.log_path.suffix + ".1")
        # Replace is atomic on POSIX and overwrites any existing backup.
        try:
            self.log_path.replace(backup)
        except OSError:
            # Best-effort rotation; never crash logging.
            pass

    def log(self, **fields) -> None:
        record = {"ts": _utc_now_iso(), **fields}
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        try:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            # Logging must never raise.
            pass


def _utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m unittest tests.test_logger -v
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/logger.py tests/test_logger.py
git commit -m "feat(logger): JSONL logger with 1MB size rotation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Implement `circuit_breaker.py` (TDD)

**Files:**
- Create: `core/circuit_breaker.py`
- Create: `tests/test_circuit_breaker.py`

**Module contract:**

```python
@dataclass
class BreakerState:
    consecutive_failures: int
    tripped_at: float | None    # unix timestamp or None

class CircuitBreaker:
    def __init__(self, state_path: Path, failure_threshold: int, open_duration_sec: int, now_fn=time.time):
        ...

    def should_skip(self) -> bool:
        """True iff breaker is open AND still within open_duration."""

    def record_success(self) -> None: ...
    def record_failure(self) -> None: ...
```

- [ ] **Step 1: Write failing tests in `tests/test_circuit_breaker.py`**

```python
import json
import tempfile
import unittest
from pathlib import Path

from core.circuit_breaker import CircuitBreaker


class FakeClock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


class TestCircuitBreaker(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state_path = Path(self.tmp.name) / "breaker.json"
        self.clock = FakeClock()

    def tearDown(self):
        self.tmp.cleanup()

    def _make(self):
        return CircuitBreaker(
            state_path=self.state_path,
            failure_threshold=3,
            open_duration_sec=300,
            now_fn=self.clock,
        )

    def test_fresh_state_does_not_skip(self):
        b = self._make()
        self.assertFalse(b.should_skip())

    def test_single_failure_does_not_trip(self):
        b = self._make()
        b.record_failure()
        b2 = self._make()  # reload state
        self.assertFalse(b2.should_skip())

    def test_threshold_failures_trips_breaker(self):
        b = self._make()
        b.record_failure()
        b.record_failure()
        b.record_failure()
        b2 = self._make()
        self.assertTrue(b2.should_skip())

    def test_success_resets_failures(self):
        b = self._make()
        b.record_failure()
        b.record_failure()
        b.record_success()
        b.record_failure()  # back to 1
        b2 = self._make()
        self.assertFalse(b2.should_skip())

    def test_breaker_reopens_after_cooldown(self):
        b = self._make()
        b.record_failure()
        b.record_failure()
        b.record_failure()
        b2 = self._make()
        self.assertTrue(b2.should_skip())

        self.clock.advance(301)  # past cooldown
        b3 = self._make()
        # Half-open: should NOT skip — gives one chance.
        self.assertFalse(b3.should_skip())

    def test_half_open_failure_reopens(self):
        b = self._make()
        b.record_failure()
        b.record_failure()
        b.record_failure()
        self.clock.advance(301)

        # Half-open attempt fails.
        b2 = self._make()
        self.assertFalse(b2.should_skip())
        b2.record_failure()

        b3 = self._make()
        self.assertTrue(b3.should_skip())

    def test_half_open_success_clears(self):
        b = self._make()
        b.record_failure()
        b.record_failure()
        b.record_failure()
        self.clock.advance(301)

        b2 = self._make()
        b2.record_success()

        # Should be fully closed now.
        b3 = self._make()
        self.assertFalse(b3.should_skip())
        # And we need 3 more failures to trip again.
        b3.record_failure()
        b3.record_failure()
        b4 = self._make()
        self.assertFalse(b4.should_skip())

    def test_corrupt_state_file_is_treated_as_fresh(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text("not valid json")
        b = self._make()
        self.assertFalse(b.should_skip())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m unittest tests.test_circuit_breaker -v
```

Expected: ModuleNotFoundError.

- [ ] **Step 3: Implement `core/circuit_breaker.py`**

```python
"""Circuit breaker for HA calls.

State machine:
  - Closed: consecutive_failures < threshold, tripped_at = None. Normal operation.
  - Open: tripped_at set, within open_duration_sec. Hooks skip HA calls.
  - Half-open: tripped_at set, past open_duration_sec. One trial allowed:
    success -> Closed; failure -> Open with fresh tripped_at.

State is persisted to a JSON file so it survives between hook invocations
(each hook runs as a fresh process).
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Callable


class CircuitBreaker:
    def __init__(
        self,
        state_path: Path,
        failure_threshold: int = 3,
        open_duration_sec: int = 300,
        now_fn: Callable[[], float] = time.time,
    ):
        self.state_path = Path(state_path)
        self.failure_threshold = failure_threshold
        self.open_duration_sec = open_duration_sec
        self._now = now_fn
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self._load()

    def _load(self) -> None:
        self.consecutive_failures = 0
        self.tripped_at: float | None = None
        if not self.state_path.exists():
            return
        try:
            raw = json.loads(self.state_path.read_text())
            self.consecutive_failures = int(raw.get("consecutive_failures", 0))
            t = raw.get("tripped_at")
            self.tripped_at = float(t) if t is not None else None
        except (OSError, ValueError, json.JSONDecodeError):
            # Corrupt state -> start fresh.
            pass

    def _save(self) -> None:
        payload = {
            "consecutive_failures": self.consecutive_failures,
            "tripped_at": self.tripped_at,
        }
        try:
            tmp = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload))
            tmp.replace(self.state_path)
        except OSError:
            pass

    def should_skip(self) -> bool:
        if self.tripped_at is None:
            return False
        if self._now() - self.tripped_at >= self.open_duration_sec:
            # Half-open: allow this attempt through.
            return False
        return True

    def record_success(self) -> None:
        self.consecutive_failures = 0
        self.tripped_at = None
        self._save()

    def record_failure(self) -> None:
        self.consecutive_failures += 1
        if self.consecutive_failures >= self.failure_threshold:
            self.tripped_at = self._now()
        self._save()
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m unittest tests.test_circuit_breaker -v
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/circuit_breaker.py tests/test_circuit_breaker.py
git commit -m "feat(breaker): persistent circuit breaker with half-open recovery

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Implement `ha_client.py` (TDD)

**Files:**
- Create: `core/ha_client.py`
- Create: `tests/test_ha_client.py`

**Module contract:**

```python
@dataclass(frozen=True)
class HAResult:
    ok: bool
    error: str | None = None        # categorical: "timeout", "connection_error", "http_4xx", "http_5xx"
    status: int | None = None       # HTTP status if response received
    duration_ms: int | None = None

def call_service(
    url: str, token: str, service: str, data: dict,
    *, connect_ms: int, read_ms: int, verify_ssl: bool = True,
) -> HAResult:
    """POST to {url}/api/services/{domain}/{service} with split timeouts."""
```

- [ ] **Step 1: Write failing tests in `tests/test_ha_client.py`**

```python
import http.server
import json
import socket
import threading
import time
import unittest
from contextlib import contextmanager

from core.ha_client import call_service


class _Handler(http.server.BaseHTTPRequestHandler):
    # Server attributes are set by the test (`server.script`).
    def log_message(self, *args, **kwargs):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode()
        # Save the most recent request on the server for assertions.
        self.server.last_path = self.path
        self.server.last_body = json.loads(body) if body else None
        self.server.last_auth = self.headers.get("Authorization", "")

        script = self.server.script
        status = script.get("status", 200)
        delay = script.get("delay", 0)
        if delay:
            time.sleep(delay)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"[]")


@contextmanager
def mock_ha(status=200, delay=0):
    server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    server.script = {"status": status, "delay": delay}
    server.last_path = None
    server.last_body = None
    server.last_auth = None
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}", server
    finally:
        server.shutdown()
        thread.join(timeout=1)


class TestHAClient(unittest.TestCase):

    def test_success(self):
        with mock_ha(status=200) as (url, srv):
            r = call_service(
                url, "tok", "light.turn_on", {"entity_id": "light.x"},
                connect_ms=500, read_ms=2000,
            )
        self.assertTrue(r.ok)
        self.assertEqual(r.status, 200)
        self.assertEqual(srv.last_path, "/api/services/light/turn_on")
        self.assertEqual(srv.last_body, {"entity_id": "light.x"})
        self.assertEqual(srv.last_auth, "Bearer tok")
        self.assertIsNotNone(r.duration_ms)

    def test_4xx_is_failure(self):
        with mock_ha(status=401) as (url, _):
            r = call_service(
                url, "tok", "light.turn_on", {"entity_id": "x"},
                connect_ms=500, read_ms=2000,
            )
        self.assertFalse(r.ok)
        self.assertEqual(r.error, "http_4xx")
        self.assertEqual(r.status, 401)

    def test_5xx_is_failure(self):
        with mock_ha(status=503) as (url, _):
            r = call_service(
                url, "tok", "light.turn_on", {},
                connect_ms=500, read_ms=2000,
            )
        self.assertFalse(r.ok)
        self.assertEqual(r.error, "http_5xx")
        self.assertEqual(r.status, 503)

    def test_read_timeout(self):
        with mock_ha(status=200, delay=2.0) as (url, _):
            r = call_service(
                url, "tok", "light.turn_on", {},
                connect_ms=500, read_ms=200,   # short read timeout
            )
        self.assertFalse(r.ok)
        self.assertEqual(r.error, "timeout")

    def test_connection_refused(self):
        # Pick a port that nothing is listening on by binding+releasing.
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        url = f"http://127.0.0.1:{port}"
        r = call_service(
            url, "tok", "light.turn_on", {},
            connect_ms=300, read_ms=2000,
        )
        self.assertFalse(r.ok)
        self.assertEqual(r.error, "connection_error")

    def test_invalid_service_format_raises(self):
        with self.assertRaises(ValueError):
            call_service(
                "http://x", "tok", "no_dot_here", {},
                connect_ms=300, read_ms=2000,
            )


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m unittest tests.test_ha_client -v
```

Expected: ModuleNotFoundError.

- [ ] **Step 3: Implement `core/ha_client.py`**

```python
"""Home Assistant REST client with split connect/read timeouts.

Stdlib only. Uses http.client directly so we can apply the connect
timeout during connect() and switch to the read timeout before sending
the request — this lets a dead HA fail fast (connect_ms) without
penalizing a live but slow HA (read_ms).
"""
from __future__ import annotations

import http.client
import json
import socket
import ssl
import time
import urllib.parse
from dataclasses import dataclass


@dataclass(frozen=True)
class HAResult:
    ok: bool
    error: str | None = None
    status: int | None = None
    duration_ms: int | None = None


def call_service(
    url: str,
    token: str,
    service: str,
    data: dict,
    *,
    connect_ms: int,
    read_ms: int,
    verify_ssl: bool = True,
) -> HAResult:
    if "." not in service:
        raise ValueError(f"service must be 'domain.service', got {service!r}")
    domain, svc = service.split(".", 1)

    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"unsupported URL scheme: {url!r}")
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = f"/api/services/{domain}/{svc}"

    body = json.dumps(data).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Content-Length": str(len(body)),
    }

    start = time.monotonic()
    conn: http.client.HTTPConnection | None = None
    try:
        if parsed.scheme == "https":
            ctx = ssl.create_default_context()
            if not verify_ssl:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            conn = http.client.HTTPSConnection(
                host, port, timeout=connect_ms / 1000, context=ctx
            )
        else:
            conn = http.client.HTTPConnection(host, port, timeout=connect_ms / 1000)

        conn.connect()
        # Now switch to read timeout for the request/response phase.
        conn.sock.settimeout(read_ms / 1000)

        conn.request("POST", path, body=body, headers=headers)
        resp = conn.getresponse()
        # Drain body so the connection closes cleanly.
        resp.read()

        duration_ms = int((time.monotonic() - start) * 1000)

        if 200 <= resp.status < 300:
            return HAResult(ok=True, status=resp.status, duration_ms=duration_ms)
        category = "http_4xx" if 400 <= resp.status < 500 else "http_5xx"
        return HAResult(ok=False, error=category, status=resp.status, duration_ms=duration_ms)

    except (socket.timeout, TimeoutError):
        duration_ms = int((time.monotonic() - start) * 1000)
        return HAResult(ok=False, error="timeout", duration_ms=duration_ms)
    except (ConnectionError, OSError):
        duration_ms = int((time.monotonic() - start) * 1000)
        return HAResult(ok=False, error="connection_error", duration_ms=duration_ms)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m unittest tests.test_ha_client -v
```

Expected: 6 tests pass. (Test 4 takes ~200ms; rest are near-instant.)

- [ ] **Step 5: Commit**

```bash
git add core/ha_client.py tests/test_ha_client.py
git commit -m "feat(ha-client): stdlib HA REST client with split timeouts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Implement `agent_hass_hook.py` main + disable logic (TDD)

**Files:**
- Create: `core/agent_hass_hook.py`
- Create: `tests/test_disable.py`
- Create: `tests/test_main.py`

**Module contract:**

`agent_hass_hook.py` exposes:
- `main(argv: list[str], stdin_text: str, env: dict, paths: Paths) -> int` — pure-ish entry, easily testable
- `find_disable_marker(start: Path) -> Path | None` — walks up to root looking for `.no-hass-hook`

Paths used:
- Config: `$AGENT_HASS_HOOK_CONFIG` or `~/.config/agent-hass-hook/config.toml`
- State dir: `$AGENT_HASS_HOOK_STATE_DIR` or `~/.local/state/agent-hass-hook/`
- Log: `<state_dir>/hook.log`
- Breaker: `<state_dir>/breaker.json`

The `__main__` block reads sys.stdin and os.environ and exits sys.exit(main(...)).

- [ ] **Step 1: Write failing tests for the disable-marker walk in `tests/test_disable.py`**

```python
import tempfile
import unittest
from pathlib import Path

from core.agent_hass_hook import find_disable_marker


class TestDisableMarker(unittest.TestCase):

    def test_no_marker_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(find_disable_marker(Path(d)))

    def test_marker_in_cwd(self):
        with tempfile.TemporaryDirectory() as d:
            marker = Path(d) / ".no-hass-hook"
            marker.touch()
            self.assertEqual(find_disable_marker(Path(d)), marker)

    def test_marker_in_parent(self):
        with tempfile.TemporaryDirectory() as d:
            marker = Path(d) / ".no-hass-hook"
            marker.touch()
            sub = Path(d) / "a" / "b" / "c"
            sub.mkdir(parents=True)
            self.assertEqual(find_disable_marker(sub), marker)

    def test_walks_all_the_way_up(self):
        with tempfile.TemporaryDirectory() as d:
            # No marker anywhere
            sub = Path(d) / "deeply" / "nested"
            sub.mkdir(parents=True)
            self.assertIsNone(find_disable_marker(sub))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Write failing integration tests in `tests/test_main.py`**

```python
import http.server
import json
import socket
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path

from core.agent_hass_hook import main, Paths


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a, **kw): pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n).decode()
        self.server.last_path = self.path
        self.server.last_body = json.loads(body) if body else None
        delay = getattr(self.server, "delay", 0)
        if delay: time.sleep(delay)
        self.send_response(getattr(self.server, "status", 200))
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"[]")


@contextmanager
def mock_ha(status=200, delay=0):
    srv = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    srv.status, srv.delay = status, delay
    srv.last_path = srv.last_body = None
    t = threading.Thread(target=srv.serve_forever, daemon=True); t.start()
    try:
        host, port = srv.server_address
        yield f"http://{host}:{port}", srv
    finally:
        srv.shutdown(); t.join(timeout=1)


def write_cfg(d: Path, ha_url: str, entity="light.test"):
    cfg = d / "config.toml"
    cfg.write_text(f"""
[ha]
url = "{ha_url}"
token = "tok"

[timeouts]
connect_ms = 500
read_ms = 2000

[circuit_breaker]
failure_threshold = 3
open_duration_sec = 300

[[on_stop]]
service = "light.turn_on"
data = {{ entity_id = "{entity}" }}
""")
    return cfg


def make_paths(tmp: Path, ha_url: str):
    cfg = write_cfg(tmp, ha_url)
    return Paths(
        config_path=cfg,
        state_dir=tmp / "state",
    )


class TestMain(unittest.TestCase):

    def test_stop_event_calls_ha(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            with mock_ha() as (url, srv):
                paths = make_paths(tmp, url)
                stdin = json.dumps({"cwd": str(tmp), "session_id": "s1"})
                exit_code = main(["on_stop"], stdin, {}, paths)
            self.assertEqual(exit_code, 0)
            self.assertEqual(srv.last_path, "/api/services/light/turn_on")
            self.assertEqual(srv.last_body, {"entity_id": "light.test"})

    def test_disabled_via_marker_skips_ha(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            (tmp / ".no-hass-hook").touch()
            with mock_ha() as (url, srv):
                paths = make_paths(tmp, url)
                stdin = json.dumps({"cwd": str(tmp), "session_id": "s1"})
                exit_code = main(["on_stop"], stdin, {}, paths)
            self.assertEqual(exit_code, 0)
            self.assertIsNone(srv.last_path)
            log = (tmp / "state" / "hook.log").read_text()
            self.assertIn("project_disabled", log)

    def test_no_config_file_writes_error_log_and_stderr(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            paths = Paths(
                config_path=tmp / "nonexistent.toml",
                state_dir=tmp / "state",
            )
            import io
            err = io.StringIO()
            stdin = json.dumps({"cwd": str(tmp)})
            exit_code = main(["on_stop"], stdin, {}, paths, stderr=err)
            self.assertEqual(exit_code, 0)
            self.assertIn("config", err.getvalue().lower())

    def test_ha_5xx_records_failure(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            with mock_ha(status=500) as (url, _):
                paths = make_paths(tmp, url)
                stdin = json.dumps({"cwd": str(tmp)})
                main(["on_stop"], stdin, {}, paths)
            breaker_state = json.loads((tmp / "state" / "breaker.json").read_text())
            self.assertEqual(breaker_state["consecutive_failures"], 1)
            self.assertIsNone(breaker_state["tripped_at"])

    def test_three_failures_trip_breaker(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            with mock_ha(status=500) as (url, srv):
                paths = make_paths(tmp, url)
                stdin = json.dumps({"cwd": str(tmp)})
                main(["on_stop"], stdin, {}, paths)
                main(["on_stop"], stdin, {}, paths)
                main(["on_stop"], stdin, {}, paths)
                # 4th call: breaker open, should NOT hit HA.
                srv.last_path = None
                main(["on_stop"], stdin, {}, paths)
            self.assertIsNone(srv.last_path)
            log = (tmp / "state" / "hook.log").read_text()
            self.assertIn("breaker_open", log)

    def test_env_disable_skips_main(self):
        # main() doesn't read AGENT_HASS_HOOK_DISABLE — adapter handles that.
        # This test confirms main() ignores it (env disable is the adapter's job).
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            with mock_ha() as (url, srv):
                paths = make_paths(tmp, url)
                stdin = json.dumps({"cwd": str(tmp)})
                main(["on_stop"], stdin, {"AGENT_HASS_HOOK_DISABLE": "1"}, paths)
            # main still ran — env disable is adapter-layer concern.
            self.assertEqual(srv.last_path, "/api/services/light/turn_on")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run both test files to verify failure**

```bash
python -m unittest tests.test_disable tests.test_main -v
```

Expected: ModuleNotFoundError / ImportError for missing names.

- [ ] **Step 4: Implement `core/agent_hass_hook.py`**

```python
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

    # Parse stdin; tolerate missing/empty.
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

    # Per-project disable marker.
    marker = find_disable_marker(cwd_path)
    if marker is not None:
        logger.log(
            event=event, cwd=str(cwd_path), result="skipped",
            reason="project_disabled", marker=str(marker),
        )
        return 0

    # Load config (with env overrides applied inside load_config).
    # Note: load_config reads os.environ directly; we apply the env arg by
    # temporarily setting os.environ. The adapter handles AGENT_HASS_HOOK_DISABLE
    # before we get here, so env is for HA_URL/TOKEN/VERIFY_SSL overrides only.
    saved_env = {}
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

    # Circuit breaker.
    breaker = CircuitBreaker(
        state_path=paths.breaker_path,
        failure_threshold=cfg.breaker.failure_threshold,
        open_duration_sec=cfg.breaker.open_duration_sec,
    )
    if breaker.should_skip():
        logger.log(event=event, cwd=str(cwd_path), result="skipped", reason="breaker_open")
        return 0

    # Run actions.
    any_failure = False
    for action in cfg.on_stop:
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
python -m unittest tests.test_disable tests.test_main -v
```

Expected: 10 tests pass (4 disable + 6 main). Test for "three failures trip breaker" may take a moment due to multiple mock HA calls.

- [ ] **Step 6: Commit**

```bash
git add core/agent_hass_hook.py tests/test_disable.py tests/test_main.py
git commit -m "feat(main): wire pipeline — stdin parse, disable check, breaker, HA call

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Implement the Claude Code adapter

**Files:**
- Create: `adapters/claude-code/stop.sh`

This script is what Claude Code's Stop hook actually invokes. It does the absolute minimum: respect env disable, then exec Python core with stdin piped through.

- [ ] **Step 1: Create `adapters/claude-code/stop.sh`**

```bash
#!/usr/bin/env bash
# Claude Code Stop hook adapter for agent-hass-hook.
#
# Reads no stdin itself — passes it through to the Python core. Honors
# AGENT_HASS_HOOK_DISABLE=1 by exiting 0 immediately (without invoking
# Python at all, which is the fastest possible disable path).
set -u

# Env-level kill switch. Cheap exit before paying Python startup cost.
if [[ "${AGENT_HASS_HOOK_DISABLE:-}" == "1" ]]; then
    exit 0
fi

# Resolve the repo root from this script's location:
#   adapters/claude-code/stop.sh -> ../../
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# Use AGENT_HASS_HOOK_PYTHON if set, else python3.
python_bin="${AGENT_HASS_HOOK_PYTHON:-python3}"

# Exec so the Python process replaces us — same PID, no extra layer in
# the process tree, stdin/stdout/stderr inherited.
cd "$repo_root" || exit 0
exec "$python_bin" -m core.agent_hass_hook on_stop
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x adapters/claude-code/stop.sh
```

- [ ] **Step 3: Smoke test — invoke directly with a mock HA**

We'll fully validate via the e2e test later (Task 11). For now, just confirm the script doesn't have syntax errors:

```bash
bash -n adapters/claude-code/stop.sh && echo "syntax ok"
```

Expected: `syntax ok`.

- [ ] **Step 4: Commit**

```bash
git add adapters/claude-code/stop.sh
git commit -m "feat(adapter): minimal Claude Code Stop hook adapter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Implement `install.sh`

**Files:**
- Create: `install.sh`

- [ ] **Step 1: Create `install.sh`**

```bash
#!/usr/bin/env bash
# Install agent-hass-hook: copy files, prompt for config, test connectivity,
# register Stop hook in ~/.claude/settings.json.
#
# Flags:
#   --dev          Point the hook at this repo (no copy). Useful for development.
#   --no-config    Skip config prompt (assume ~/.config/agent-hass-hook/config.toml exists).
#   --skip-test    Skip the HA connectivity test.
#   --help         Show this help.
set -euo pipefail

DEV=0
NO_CONFIG=0
SKIP_TEST=0
for arg in "$@"; do
    case "$arg" in
        --dev) DEV=1 ;;
        --no-config) NO_CONFIG=1 ;;
        --skip-test) SKIP_TEST=1 ;;
        --help|-h)
            sed -n '2,7p' "$0"
            exit 0
            ;;
        *) echo "Unknown flag: $arg" >&2; exit 2 ;;
    esac
done

err() { echo "install.sh: error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# --- 1. Dependency checks
info "Checking dependencies..."
command -v python3 >/dev/null || err "python3 not found. Install Python 3.11+."
pyver=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
pyok=$(python3 -c 'import sys; print(1 if sys.version_info >= (3, 11) else 0)')
[[ "$pyok" == "1" ]] || err "python3 is $pyver, need 3.11+ (for tomllib)."

command -v jq >/dev/null || err "jq not found. Install: apt install jq / brew install jq"
command -v curl >/dev/null || err "curl not found. Install curl."

# --- 2. Determine install path & hook command
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$DEV" == "1" ]]; then
    INSTALL_DIR="$SCRIPT_DIR"
    info "Dev mode: hook will point at $INSTALL_DIR (no copy)"
else
    INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/agent-hass-hook"
    info "Installing to $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    # Copy core, adapters, config.example.
    cp -r "$SCRIPT_DIR/core" "$INSTALL_DIR/"
    cp -r "$SCRIPT_DIR/adapters" "$INSTALL_DIR/"
    cp "$SCRIPT_DIR/config.example.toml" "$INSTALL_DIR/"
    chmod +x "$INSTALL_DIR/adapters/claude-code/stop.sh"
fi
HOOK_CMD="$INSTALL_DIR/adapters/claude-code/stop.sh"

# --- 3. Configuration
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-hass-hook"
CONFIG_PATH="$CONFIG_DIR/config.toml"

if [[ "$NO_CONFIG" == "1" ]]; then
    info "Skipping config prompt (--no-config)"
    [[ -f "$CONFIG_PATH" ]] || err "No config at $CONFIG_PATH. Run without --no-config to set it up."
else
    if [[ -f "$CONFIG_PATH" ]]; then
        read -r -p "Config exists at $CONFIG_PATH. (k)eep / (o)verwrite / (a)bort? [k] " choice
        choice=${choice:-k}
        case "$choice" in
            k|K) info "Keeping existing config." ;;
            o|O) rm "$CONFIG_PATH" ;;
            *) err "Aborted." ;;
        esac
    fi

    if [[ ! -f "$CONFIG_PATH" ]]; then
        info "Setting up config..."
        mkdir -p "$CONFIG_DIR"
        chmod 700 "$CONFIG_DIR"

        read -r -p "HA URL (e.g. http://192.168.1.100:8123): " HA_URL
        [[ -n "$HA_URL" ]] || err "URL is required."

        # Hidden token prompt.
        read -r -s -p "HA long-lived access token: " HA_TOKEN
        echo
        [[ -n "$HA_TOKEN" ]] || err "Token is required."

        read -r -p "Entity ID of the light (e.g. light.xiaomi_monitor_lamp): " ENTITY_ID
        [[ -n "$ENTITY_ID" ]] || err "Entity ID is required."

        umask 077
        cat > "$CONFIG_PATH" <<EOF
[ha]
url = "$HA_URL"
token = "$HA_TOKEN"
verify_ssl = true

[timeouts]
connect_ms = 300
read_ms = 2000

[circuit_breaker]
failure_threshold = 3
open_duration_sec = 300

[[on_stop]]
service = "light.turn_on"
data = { entity_id = "$ENTITY_ID" }
EOF
        chmod 600 "$CONFIG_PATH"
        info "Wrote $CONFIG_PATH (chmod 600)"
    fi
fi

# --- 4. Connectivity test
if [[ "$SKIP_TEST" == "1" ]]; then
    info "Skipping connectivity test (--skip-test)"
else
    info "Testing HA connectivity..."
    # Read URL/token/entity from config via python.
    eval "$(python3 -c "
import tomllib, sys, shlex
with open('$CONFIG_PATH', 'rb') as f:
    c = tomllib.load(f)
print(f'CFG_URL={shlex.quote(c[\"ha\"][\"url\"])}')
print(f'CFG_TOKEN={shlex.quote(c[\"ha\"][\"token\"])}')
print(f'CFG_ENTITY={shlex.quote(c[\"on_stop\"][0][\"data\"][\"entity_id\"])}')
")"

    # Test 1: API root
    if ! curl -fsS -m 5 -H "Authorization: Bearer $CFG_TOKEN" "$CFG_URL/api/" >/dev/null; then
        err "Failed to reach $CFG_URL/api/ — check URL and token."
    fi
    info "✓ API reachable; token valid"

    # Test 2: Entity exists
    if ! curl -fsS -m 5 -H "Authorization: Bearer $CFG_TOKEN" "$CFG_URL/api/states/$CFG_ENTITY" >/dev/null; then
        err "Entity '$CFG_ENTITY' not found in HA — check the entity_id."
    fi
    info "✓ Entity $CFG_ENTITY exists"
fi

# --- 5. Register hook in ~/.claude/settings.json
SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$(dirname "$SETTINGS")"
[[ -f "$SETTINGS" ]] || echo "{}" > "$SETTINGS"

info "Registering Stop hook in $SETTINGS"
tmp=$(mktemp)
jq --arg cmd "$HOOK_CMD" '
  .hooks //= {} |
  .hooks.Stop //= [] |
  if (.hooks.Stop | map(.hooks // []) | flatten | map(.command) | index($cmd)) then
    .
  else
    .hooks.Stop += [{
      "matcher": "",
      "hooks": [{"type": "command", "command": $cmd}]
    }]
  end
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
info "✓ Hook registered: $HOOK_CMD"

echo
echo "Installation complete."
echo "Test it: trigger Claude Code Stop in any session — your light should turn on."
echo "Logs: ${XDG_STATE_HOME:-$HOME/.local/state}/agent-hass-hook/hook.log"
echo "Disable per-project: 'touch .no-hass-hook' at project root"
echo "Disable per-session: 'export AGENT_HASS_HOOK_DISABLE=1'"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x install.sh
```

- [ ] **Step 3: Syntax check**

```bash
bash -n install.sh && echo "syntax ok"
```

Expected: `syntax ok`.

- [ ] **Step 4: Commit**

```bash
git add install.sh
git commit -m "feat(install): interactive installer with conn test and jq merge

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Implement `uninstall.sh`

**Files:**
- Create: `uninstall.sh`

- [ ] **Step 1: Create `uninstall.sh`**

```bash
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
    # Match any command containing 'agent-hass-hook' and 'stop.sh' (covers both
    # ~/.local/share/agent-hass-hook/... and dev-mode repo paths).
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
```

- [ ] **Step 2: Make executable and syntax-check**

```bash
chmod +x uninstall.sh
bash -n uninstall.sh && echo "syntax ok"
```

Expected: `syntax ok`.

- [ ] **Step 3: Commit**

```bash
git add uninstall.sh
git commit -m "feat(uninstall): remove hook entries; --purge for config/state

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: README, adapter-extension doc

**Files:**
- Create: `README.md`
- Create: `docs/adding-new-adapter.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# agent-hass-hook

Make Home Assistant your physical-world notification channel for AI coding agents. When Claude Code finishes a task, your light turns on (or any HA service runs).

**MVP**: Claude Code `Stop` event → call any configured HA service. Default config turns on a light. Adding more AI tools (Cursor, Codex, etc.) or more events (`on_subagent_stop`, etc.) is a matter of adding adapters / config entries — the core stays the same.

## Why use this instead of...

- **claude-lamp** (BLE Moonside): locks you to one lamp brand. We go through HA, so anything HA controls works.
- **claude-notifications-go** (webhooks): great for Slack/Discord, but no HA awareness. We're HA-first.
- **peon-ping** (audio/desktop): notifies on the same machine; we trigger external devices.

## Requirements

- Linux or macOS
- Python 3.11+ (uses stdlib `tomllib`)
- `jq` and `curl` (for the install script)
- Home Assistant with at least one entity you want to control
- A long-lived access token (HA UI: Profile → Security → Long-Lived Access Tokens)

## Install

```bash
git clone https://github.com/<you>/agent-hass-hook.git
cd agent-hass-hook
./install.sh
```

You'll be prompted for HA URL, token, and the entity ID of your target device. The installer will:

1. Copy files to `~/.local/share/agent-hass-hook/`
2. Write `~/.config/agent-hass-hook/config.toml` (mode 600)
3. Verify the token and entity exist
4. Add a `Stop` hook entry to `~/.claude/settings.json`

**Development install** (no copy; hook points at the repo): `./install.sh --dev`

**Skip prompts**: `./install.sh --no-config --skip-test` (assumes config is already in place)

## Configuration

Stored at `~/.config/agent-hass-hook/config.toml`. See `config.example.toml` for the full schema. Most fields have sensible defaults; the required ones are `[ha].url`, `[ha].token`, and at least one `[[on_stop]]` entry.

The `[[on_stop]]` array fires every action when Claude Code's `Stop` event happens. Examples:

```toml
[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.xiaomi_monitor_lamp" }

[[on_stop]]
service = "notify.mobile_app_my_phone"
data = { title = "Claude done", message = "Task complete" }

[[on_stop]]
service = "script.celebrate_done"
data = {}
```

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
python -m unittest discover -s tests -v
bash tests/test_e2e.sh
```

## Adding support for a new AI tool

See `docs/adding-new-adapter.md`.

## Architecture

- **`adapters/<tool>/`** — bash entry points specific to each AI tool's hook system
- **`core/agent_hass_hook.py`** — main pipeline (read stdin, disable check, breaker, HA call, log)
- **`core/{config,ha_client,circuit_breaker,logger}.py`** — single-responsibility modules

Synchronous execution: hooks block Claude Code briefly. The 300ms+2s+breaker combo bounds worst-case impact even when HA is dead.

## License

MIT
```

- [ ] **Step 2: Write `docs/adding-new-adapter.md`**

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/adding-new-adapter.md
git commit -m "docs: README and adapter-extension guide

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: End-to-end shell test

**Files:**
- Create: `tests/test_e2e.sh`

This test stands up a mock HA via `python3 -m http.server` style approach (we'll use a small Python script), invokes the actual `adapters/claude-code/stop.sh` script with realistic stdin, and asserts behavior.

- [ ] **Step 1: Create `tests/test_e2e.sh`**

```bash
#!/usr/bin/env bash
# End-to-end test: stop.sh adapter -> Python core -> mock HA.
# Exits 0 on success, non-zero on failure.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"; kill $MOCK_PID 2>/dev/null || true' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# --- 1. Start mock HA on a free port.
MOCK_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
python3 - <<PYEOF >"$WORKDIR/mock.log" 2>&1 &
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a,**k): pass
    def do_POST(self):
        n=int(self.headers.get("Content-Length","0"))
        body=self.rfile.read(n)
        with open("$WORKDIR/last_request.json","w") as f:
            json.dump({"path": self.path, "body": json.loads(body), "auth": self.headers.get("Authorization","")}, f)
        self.send_response(200)
        self.send_header("Content-Type","application/json")
        self.end_headers()
        self.wfile.write(b"[]")
server = http.server.HTTPServer(("127.0.0.1", $MOCK_PORT), H)
server.serve_forever()
PYEOF
MOCK_PID=$!
# Wait for it to come up.
for _ in {1..30}; do
    if curl -fsS "http://127.0.0.1:$MOCK_PORT/" -o /dev/null 2>/dev/null \
       || nc -z 127.0.0.1 $MOCK_PORT 2>/dev/null; then
        break
    fi
    sleep 0.05
done

# --- 2. Build a temp config pointing at the mock.
mkdir -p "$WORKDIR/config" "$WORKDIR/state"
cat > "$WORKDIR/config/config.toml" <<EOF
[ha]
url = "http://127.0.0.1:$MOCK_PORT"
token = "test-token"
verify_ssl = true

[timeouts]
connect_ms = 500
read_ms = 2000

[circuit_breaker]
failure_threshold = 3
open_duration_sec = 300

[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.test_e2e" }
EOF

export AGENT_HASS_HOOK_CONFIG="$WORKDIR/config/config.toml"
export AGENT_HASS_HOOK_STATE_DIR="$WORKDIR/state"
export AGENT_HASS_HOOK_PYTHON="python3"

# --- 3. Scenario: normal Stop -> HA gets called
rm -f "$WORKDIR/last_request.json"
mkdir -p "$WORKDIR/proj"
echo "{\"cwd\":\"$WORKDIR/proj\",\"session_id\":\"s1\"}" | \
    "$REPO/adapters/claude-code/stop.sh"

[[ -f "$WORKDIR/last_request.json" ]] || fail "scenario 1: no request hit mock HA"
got=$(python3 -c "import json;print(json.load(open('$WORKDIR/last_request.json'))['path'])")
[[ "$got" == "/api/services/light/turn_on" ]] || fail "scenario 1: bad path: $got"
auth=$(python3 -c "import json;print(json.load(open('$WORKDIR/last_request.json'))['auth'])")
[[ "$auth" == "Bearer test-token" ]] || fail "scenario 1: bad auth: $auth"
pass "scenario 1: HA called with correct path and auth"

# --- 4. Scenario: AGENT_HASS_HOOK_DISABLE=1 -> no HA call
rm -f "$WORKDIR/last_request.json"
AGENT_HASS_HOOK_DISABLE=1 echo "{\"cwd\":\"$WORKDIR/proj\"}" | \
    AGENT_HASS_HOOK_DISABLE=1 "$REPO/adapters/claude-code/stop.sh"
[[ ! -f "$WORKDIR/last_request.json" ]] || fail "scenario 2: HA was called despite disable env var"
pass "scenario 2: env disable blocks HA call"

# --- 5. Scenario: .no-hass-hook marker -> no HA call, log says project_disabled
rm -f "$WORKDIR/last_request.json"
touch "$WORKDIR/proj/.no-hass-hook"
echo "{\"cwd\":\"$WORKDIR/proj\"}" | "$REPO/adapters/claude-code/stop.sh"
[[ ! -f "$WORKDIR/last_request.json" ]] || fail "scenario 3: HA called despite marker"
grep -q "project_disabled" "$WORKDIR/state/hook.log" || fail "scenario 3: log missing project_disabled"
rm "$WORKDIR/proj/.no-hass-hook"
pass "scenario 3: marker file blocks HA call and logs reason"

# --- 6. Scenario: log file exists and contains a success entry
grep -q '"result":"ok"' "$WORKDIR/state/hook.log" || fail "scenario 4: log missing success entry"
pass "scenario 4: success entries written to log"

echo
echo "All e2e scenarios passed."
```

- [ ] **Step 2: Make executable**

```bash
chmod +x tests/test_e2e.sh
```

- [ ] **Step 3: Run the e2e test**

```bash
bash tests/test_e2e.sh
```

Expected output:
```
ok: scenario 1: HA called with correct path and auth
ok: scenario 2: env disable blocks HA call
ok: scenario 3: marker file blocks HA call and logs reason
ok: scenario 4: success entries written to log

All e2e scenarios passed.
```

- [ ] **Step 4: Commit**

```bash
git add tests/test_e2e.sh
git commit -m "test: end-to-end shell test covering normal, disable, marker scenarios

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Full test suite verification

- [ ] **Step 1: Run the entire Python test suite**

```bash
cd /home/pig/Repos/agent-hass-hook
python -m unittest discover -s tests -v 2>&1 | tail -40
```

Expected: all tests pass. Count should be ~33 (10 config + 5 logger + 8 breaker + 6 ha_client + 4 disable + 6 main = 39 — actual will be in this neighborhood).

- [ ] **Step 2: Run the e2e test**

```bash
bash tests/test_e2e.sh
```

Expected: all 4 scenarios pass.

- [ ] **Step 3: Verify no untracked or modified files**

```bash
git status
```

Expected: `nothing to commit, working tree clean`.

---

## Self-Review Checklist (already done during plan writing, kept for reference)

- **Spec coverage**: every section of the design spec maps to a task above.
  - Architecture/components → Tasks 2–7
  - Configuration → Tasks 1–2
  - Data flow → Task 6
  - Error handling → Task 6 (exit codes, stderr) + Task 4 (breaker) + Task 3 (log)
  - Installation → Tasks 8, 9
  - Testing → Tasks 2–6 (unit) + Task 11 (e2e) + Task 12 (verification)
- **Placeholders**: none — every code block is concrete.
- **Type consistency**: `Config`, `Action`, `HAResult`, `Paths`, `BreakerState` (internal to `CircuitBreaker`) used consistently across tasks.

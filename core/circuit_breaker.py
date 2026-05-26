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

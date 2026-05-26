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
        try:
            self.log_path.replace(backup)
        except OSError:
            pass

    def log(self, **fields) -> None:
        record = {"ts": _utc_now_iso(), **fields}
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        try:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            pass


def _utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

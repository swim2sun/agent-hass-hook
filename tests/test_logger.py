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
            log_path.write_text("x" * 2000)
            logger = HookLogger(log_path, max_bytes=1000)
            logger.log(event="rotate_trigger")

            self.assertTrue((log_path.parent / "hook.log.1").exists())
            self.assertGreater(log_path.stat().st_size, 0)
            self.assertLess(log_path.stat().st_size, 1000)
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

            self.assertNotIn("old backup", backup.read_text())

    def test_ts_is_iso8601_utc(self):
        with tempfile.TemporaryDirectory() as d:
            log_path = Path(d) / "hook.log"
            logger = HookLogger(log_path)
            logger.log(event="test")
            line = json.loads(log_path.read_text().strip())
            self.assertRegex(line["ts"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


if __name__ == "__main__":
    unittest.main()

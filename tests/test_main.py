import http.server
import json
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
        if delay:
            time.sleep(delay)
        try:
            self.send_response(getattr(self.server, "status", 200))
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"[]")
        except (BrokenPipeError, ConnectionResetError):
            pass


@contextmanager
def mock_ha(status=200, delay=0):
    srv = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    srv.status, srv.delay = status, delay
    srv.last_path = srv.last_body = None
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        host, port = srv.server_address
        yield f"http://{host}:{port}", srv
    finally:
        srv.shutdown()
        t.join(timeout=1)


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
        import io
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            paths = Paths(
                config_path=tmp / "nonexistent.toml",
                state_dir=tmp / "state",
            )
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
                srv.last_path = None
                main(["on_stop"], stdin, {}, paths)
            self.assertIsNone(srv.last_path)
            log = (tmp / "state" / "hook.log").read_text()
            self.assertIn("breaker_open", log)

    def test_env_disable_skips_main(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            with mock_ha() as (url, srv):
                paths = make_paths(tmp, url)
                stdin = json.dumps({"cwd": str(tmp)})
                main(["on_stop"], stdin, {"AGENT_HASS_HOOK_DISABLE": "1"}, paths)
            self.assertEqual(srv.last_path, "/api/services/light/turn_on")


if __name__ == "__main__":
    unittest.main()

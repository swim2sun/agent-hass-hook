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


def write_cfg_multi(d: Path, ha_url: str, entity="light.test"):
    cfg = d / "config.toml"
    cfg.write_text(f"""
[ha]
url = "{ha_url}"
token = "tok"

[[on_user_prompt_submit]]
service = "light.turn_off"
data = {{ entity_id = "{entity}" }}

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

    def test_env_disable_does_not_short_circuit_main(self):
        # AGENT_HASS_HOOK_DISABLE is handled by the bash adapter before main()
        # is even invoked; main() itself doesn't read it. This documents the
        # contract — the e2e test (tests/test_e2e.sh scenario 2) covers the
        # adapter-level disable behavior end-to-end.
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            with mock_ha() as (url, srv):
                paths = make_paths(tmp, url)
                stdin = json.dumps({"cwd": str(tmp)})
                main(["on_stop"], stdin, {"AGENT_HASS_HOOK_DISABLE": "1"}, paths)
            self.assertEqual(srv.last_path, "/api/services/light/turn_on")

    def test_three_failures_set_tripped_at(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            with mock_ha(status=500) as (url, _):
                paths = make_paths(tmp, url)
                stdin = json.dumps({"cwd": str(tmp)})
                for _ in range(3):
                    main(["on_stop"], stdin, {}, paths)
            state = json.loads((tmp / "state" / "breaker.json").read_text())
            self.assertEqual(state["consecutive_failures"], 3)
            self.assertIsNotNone(state["tripped_at"])


    def test_user_prompt_submit_calls_turn_off(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            with mock_ha() as (url, srv):
                write_cfg_multi(tmp, url)
                paths = Paths(config_path=tmp / "config.toml", state_dir=tmp / "state")
                stdin = json.dumps({"cwd": str(tmp)})
                rc = main(["on_user_prompt_submit"], stdin, {}, paths)
            self.assertEqual(rc, 0)
            self.assertEqual(srv.last_path, "/api/services/light/turn_off")

    def test_event_with_no_actions_is_noop(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            with mock_ha() as (url, srv):
                paths = make_paths(tmp, url)  # writes only [[on_stop]]
                stdin = json.dumps({"cwd": str(tmp)})
                rc = main(["on_user_prompt_submit"], stdin, {}, paths)
            self.assertEqual(rc, 0)
            self.assertIsNone(srv.last_path)  # HA never called
            # No-op events must not even create breaker state (early return
            # happens before the CircuitBreaker is constructed).
            self.assertFalse((tmp / "state" / "breaker.json").exists())

    def test_breaker_shared_across_events(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            with mock_ha(status=500) as (url, _):
                write_cfg_multi(tmp, url)
                paths = Paths(config_path=tmp / "config.toml", state_dir=tmp / "state")
                stdin = json.dumps({"cwd": str(tmp)})
                main(["on_user_prompt_submit"], stdin, {}, paths)  # failure 1
                main(["on_stop"], stdin, {}, paths)                # failure 2
                main(["on_user_prompt_submit"], stdin, {}, paths)  # failure 3 -> trips
            state = json.loads((tmp / "state" / "breaker.json").read_text())
            self.assertEqual(state["consecutive_failures"], 3)
            self.assertIsNotNone(state["tripped_at"])


if __name__ == "__main__":
    unittest.main()

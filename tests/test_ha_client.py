import http.server
import json
import socket
import threading
import time
import unittest
from contextlib import contextmanager

from core.ha_client import call_service


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args, **kwargs):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode()
        self.server.last_path = self.path
        self.server.last_body = json.loads(body) if body else None
        self.server.last_auth = self.headers.get("Authorization", "")

        script = self.server.script
        status = script.get("status", 200)
        delay = script.get("delay", 0)
        if delay:
            time.sleep(delay)
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"[]")
        except (BrokenPipeError, ConnectionResetError):
            # Client gave up (timeout test). That's the scenario under test.
            pass


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
                connect_ms=500, read_ms=200,
            )
        self.assertFalse(r.ok)
        self.assertEqual(r.error, "timeout")

    def test_connection_refused(self):
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

    def test_url_path_prefix_is_preserved(self):
        # Reverse-proxied HA at /homeassistant must route to /homeassistant/api/...
        with mock_ha(status=200) as (url, srv):
            r = call_service(
                url + "/homeassistant", "tok", "light.turn_on", {"entity_id": "x"},
                connect_ms=500, read_ms=2000,
            )
        self.assertTrue(r.ok)
        self.assertEqual(srv.last_path, "/homeassistant/api/services/light/turn_on")


if __name__ == "__main__":
    unittest.main()

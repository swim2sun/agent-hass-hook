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
        conn.sock.settimeout(read_ms / 1000)

        conn.request("POST", path, body=body, headers=headers)
        resp = conn.getresponse()
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

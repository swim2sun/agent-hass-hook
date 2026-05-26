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

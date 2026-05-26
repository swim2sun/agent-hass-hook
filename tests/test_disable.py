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
            sub = Path(d) / "deeply" / "nested"
            sub.mkdir(parents=True)
            self.assertIsNone(find_disable_marker(sub))


if __name__ == "__main__":
    unittest.main()

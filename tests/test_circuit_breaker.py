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
        b2 = self._make()
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
        b.record_failure()
        b2 = self._make()
        self.assertFalse(b2.should_skip())

    def test_breaker_reopens_after_cooldown(self):
        b = self._make()
        b.record_failure()
        b.record_failure()
        b.record_failure()
        b2 = self._make()
        self.assertTrue(b2.should_skip())

        self.clock.advance(301)
        b3 = self._make()
        self.assertFalse(b3.should_skip())

    def test_half_open_failure_reopens(self):
        b = self._make()
        b.record_failure()
        b.record_failure()
        b.record_failure()
        self.clock.advance(301)

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

        b3 = self._make()
        self.assertFalse(b3.should_skip())
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

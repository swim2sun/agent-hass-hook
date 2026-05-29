import unittest
from core.presets import render, PRESETS


class TestPresets(unittest.TestCase):
    def test_preset_a(self):
        ev = render("A", "light.x")
        self.assertEqual(set(ev), {"on_user_prompt_submit", "on_stop"})
        self.assertEqual(ev["on_user_prompt_submit"],
                         [{"service": "light.turn_off", "data": {"entity_id": "light.x"}}])
        self.assertEqual(ev["on_stop"],
                         [{"service": "light.turn_on", "data": {"entity_id": "light.x"}}])

    def test_preset_c_uses_kelvin_range(self):
        ev = render("C", "light.x", warm_kelvin=2700, cool_kelvin=6500)
        start = ev["on_user_prompt_submit"][0]["data"]
        done = ev["on_stop"][0]["data"]
        self.assertEqual(start["color_temp_kelvin"], 2700)
        self.assertEqual(start["brightness_pct"], 50)
        self.assertEqual(done["color_temp_kelvin"], 6500)
        self.assertEqual(done["brightness_pct"], 100)
        self.assertEqual(ev["on_stop"][0]["service"], "light.turn_on")

    def test_unknown_preset_raises(self):
        with self.assertRaises(ValueError):
            render("Z", "light.x")

    def test_presets_registry(self):
        self.assertEqual(PRESETS, {"A", "C"})


if __name__ == "__main__":
    unittest.main()

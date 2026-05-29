"""Behavior presets — pure templates expanded into generic event->actions config.

The runtime never imports this; only the installer does, to render a
config.toml from a chosen preset. Keeping it pure (returns plain dicts)
makes it trivially testable and keeps the runtime free of "mode" logic.
"""
from __future__ import annotations

PRESETS = {"A", "C"}


def render(
    preset: str,
    entity: str,
    *,
    warm_kelvin: int = 2700,
    cool_kelvin: int = 6500,
) -> dict[str, list[dict]]:
    """Return {event_key: [{"service": str, "data": dict}, ...]} for a preset."""
    if preset == "A":
        return {
            "on_user_prompt_submit": [
                {"service": "light.turn_off", "data": {"entity_id": entity}}
            ],
            "on_stop": [
                {"service": "light.turn_on", "data": {"entity_id": entity}}
            ],
        }
    if preset == "C":
        return {
            "on_user_prompt_submit": [
                {"service": "light.turn_on", "data": {
                    "entity_id": entity,
                    "color_temp_kelvin": warm_kelvin,
                    "brightness_pct": 50,
                }}
            ],
            "on_stop": [
                {"service": "light.turn_on", "data": {
                    "entity_id": entity,
                    "color_temp_kelvin": cool_kelvin,
                    "brightness_pct": 100,
                }}
            ],
        }
    raise ValueError(f"unknown preset {preset!r} (expected one of {sorted(PRESETS)})")

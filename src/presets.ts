import type { Action } from "./config.ts";

export const PRESETS = ["A", "C"] as const;
export type Preset = (typeof PRESETS)[number];

export interface RenderOpts { warmKelvin?: number; coolKelvin?: number; }

export function render(preset: Preset, entity: string, opts: RenderOpts = {}): Record<string, Action[]> {
  const warm = opts.warmKelvin ?? 2700;
  const cool = opts.coolKelvin ?? 6500;
  if (preset === "A") {
    return {
      on_user_prompt_submit: [{ service: "light.turn_off", data: { entity_id: entity } }],
      on_stop: [{ service: "light.turn_on", data: { entity_id: entity } }],
    };
  }
  if (preset === "C") {
    return {
      on_user_prompt_submit: [
        { service: "light.turn_on", data: { entity_id: entity, color_temp_kelvin: warm, brightness_pct: 50 } },
      ],
      on_stop: [
        { service: "light.turn_on", data: { entity_id: entity, color_temp_kelvin: cool, brightness_pct: 100 } },
      ],
    };
  }
  throw new Error(`unknown preset ${String(preset)} (expected one of ${PRESETS.join(", ")})`);
}

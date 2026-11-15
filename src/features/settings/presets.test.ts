import { describe, expect, it } from "vitest";
import { PALETTE_PRESETS, withAccentPreset } from "./presets";
import { COLOR_ROLES, contrastWarnings, emptyTheme, resolvePalette, sanitizeTheme } from "./theme";
import { sanitize } from "../../stores/preferences";

const choices = sanitize({});
describe("full color presets", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`provides distinct, complete ${mode} palettes from the Octopolis themes`, () => {
      const count = mode === "dark" ? 10 : 7;
      expect(PALETTE_PRESETS[mode]).toHaveLength(count);
      expect(new Set(PALETTE_PRESETS[mode].map((p) => p.id)).size).toBe(count);
      for (const preset of PALETTE_PRESETS[mode]) expect(Object.keys(preset.colors).sort()).toEqual(COLOR_ROLES.map(([key]) => key).sort());
    });
    for (const preset of PALETTE_PRESETS[mode]) it(`${preset.name}: text, buttons, focus and code remain readable`, () => {
      const config = emptyTheme(); config.palettes[mode] = preset.colors;
      expect(sanitizeTheme(config, true)).toEqual(config);
      expect(contrastWarnings(resolvePalette(config, mode, choices))).toEqual([]);
    });
  }
  it("lets accent choices replace preset accent colors without changing surfaces or the other custom roles", () => {
    const config = emptyTheme(); config.palettes.dark = PALETTE_PRESETS.dark[1].colors;
    const changed = withAccentPreset(config, "rose");
    expect(changed.palettes.dark.sidebar).toBe(config.palettes.dark.sidebar);
    expect(config.palettes.dark.accent).toBe(PALETTE_PRESETS.dark[1].colors.accent);
    expect(resolvePalette(changed, "dark", choices).accent).toBe("#c0305a");
    expect(changed.palettes.light).toEqual({});
  });
});

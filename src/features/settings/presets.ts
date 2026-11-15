import { COLOR_ROLES, type ColorRole, type PaletteMode } from "./theme";
import { octoPalette } from "./octoPalette";
import { OCTO_THEMES, THEME_FAMILIES, type ThemeFamily } from "./octopolisThemes";
import type { ThemeConfig } from "./theme";

export { THEME_FAMILIES, type ThemeFamily };
export interface PalettePreset { id: string; name: string; description: string; family: ThemeFamily; colors: Record<ColorRole, string> }

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const familyHint = (family: ThemeFamily) => THEME_FAMILIES.find((f) => f.id === family)?.hint ?? "";

/** Octopolis's built-in themes, expanded into Suivelle's colour roles and split by the mode they set. */
export const PALETTE_PRESETS: Record<PaletteMode, PalettePreset[]> = { dark: [], light: [] };
for (const theme of OCTO_THEMES) {
  const base = Object.fromEntries(COLOR_ROLES.map(([role, , , light, dark]) => [role, theme.scheme === "light" ? light : dark]));
  const colors = { ...base, ...octoPalette(theme.tokens, theme.scheme) } as Record<ColorRole, string>;
  PALETTE_PRESETS[theme.scheme].push({ id: slug(theme.name), name: theme.name, description: familyHint(theme.family), family: theme.family, colors });
}

/** Accent controls must still work after a full palette supplied explicit accent colors. */
export function withAccentPreset(config: ThemeConfig, accent: string): ThemeConfig {
  const palettes = { light: { ...config.palettes.light }, dark: { ...config.palettes.dark } };
  for (const mode of ["light", "dark"] as const) {
    for (const key of ["accent", "accent-hover", "accent-ui", "accent-soft", "on-accent", "focus-ring", "hl-keyword"] as const) delete palettes[mode][key];
  }
  return { ...config, accent, palettes };
}

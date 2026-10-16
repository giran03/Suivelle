import { COLOR_ROLES, mix, type ColorRole, type Palette, type PaletteMode, type ThemeConfig } from "./theme";

export interface PalettePreset { id: string; name: string; description: string; colors: Record<ColorRole, string> }
function preset(mode: PaletteMode, id: string, name: string, description: string, overrides: Palette): PalettePreset {
  const colors = { ...Object.fromEntries(COLOR_ROLES.map(([role, , , light, dark]) => [role, mode === "light" ? light : dark])), ...overrides } as Record<ColorRole, string>;
  colors["sidebar-text"] = colors["text-primary"];
  colors["sidebar-secondary"] = colors["text-secondary"];
  colors["sidebar-muted"] = colors["text-muted"];
  colors["focus-ring"] = colors["accent-ui"];
  colors["code-bg"] = colors.field;
  colors["hl-keyword"] = colors["accent-ui"];
  colors["hl-string"] = colors.success;
  colors["hl-number"] = colors.warning;
  colors["hl-title"] = colors["accent-ui"];
  colors["hl-comment"] = colors["text-muted"];
  colors["tone-green"] = colors.success;
  colors["tone-orange"] = colors.warning;
  colors["tone-red"] = colors.danger;
  colors["tone-blue"] = colors["accent-ui"];
  colors["tone-gray"] = colors["text-muted"];
  colors["border-subtle"] = mix(colors.background, colors["text-primary"], 0.1);
  colors.border = mix(colors.background, colors["text-primary"], 0.18);
  colors["border-strong"] = mix(colors.background, colors["text-primary"], 0.3);
  return { id, name, description, colors };
}

export const PALETTE_PRESETS: Record<PaletteMode, PalettePreset[]> = {
  dark: [
    preset("dark", "midnight", "Midnight", "Deep navy with sapphire and starlight.", {}),
    preset("dark", "graphite", "Graphite", "Neutral charcoal with a soft blue accent.", {
      background: "#15171C", sidebar: "#101216", "editor-background": "#15171C", "toolbar-background": "#1A1D23",
      "surface-1": "#1E222A", "surface-2": "#242932", field: "#171A20", "surface-hover": "#292F3B", "surface-active": "#303A49",
      "text-primary": "#F0F1F3", "text-secondary": "#C3C7D0", "text-muted": "#A9AFBB",
      accent: "#91A9DC", "accent-hover": "#A5BCEB", "on-accent": "#121B2D", "accent-ui": "#BCD0FA", "accent-soft": "#303F59",
    }),
    preset("dark", "forest", "Forest", "Evergreen surfaces with a gentle mint accent.", {
      background: "#0D1916", sidebar: "#0A1411", "editor-background": "#0D1916", "toolbar-background": "#12211B",
      "surface-1": "#152820", "surface-2": "#1B3028", field: "#102019", "surface-hover": "#213B2F", "surface-active": "#284635",
      "text-primary": "#EAF3ED", "text-secondary": "#BCD2C4", "text-muted": "#9CBCAA",
      accent: "#91C7A3", "accent-hover": "#A5D5B5", "on-accent": "#0D1F14", "accent-ui": "#ACE0BC", "accent-soft": "#284635",
      success: "#8CD4A0", warning: "#EBC482", danger: "#FF9A90", "tone-violet": "#C5B5EC",
    }),
    preset("dark", "plum", "Plum", "Deep aubergine with a soft lilac accent.", {
      background: "#18121F", sidebar: "#130E19", "editor-background": "#18121F", "toolbar-background": "#211829",
      "surface-1": "#281E32", "surface-2": "#30243D", field: "#1D1526", "surface-hover": "#372A44", "surface-active": "#40324E",
      "text-primary": "#F4ECF8", "text-secondary": "#D4C3DF", "text-muted": "#B8A8C6",
      accent: "#D1ABE2", "accent-hover": "#DFBEEF", "on-accent": "#25172D", "accent-ui": "#E2C4F1", "accent-soft": "#40324E",
      success: "#A4D2B5", warning: "#EAC68C", danger: "#FF9A90", "tone-violet": "#D1ABE2",
    }),
    preset("dark", "ember", "Ember", "Warm charcoal with a mellow copper accent.", {
      background: "#211713", sidebar: "#1A120F", "editor-background": "#211713", "toolbar-background": "#2A1E18",
      "surface-1": "#30231C", "surface-2": "#3A2B22", field: "#261B16", "surface-hover": "#443125", "surface-active": "#513A2C",
      "text-primary": "#F8EEE5", "text-secondary": "#DECABB", "text-muted": "#C3AC9D",
      accent: "#E5B18A", "accent-hover": "#F0C3A1", "on-accent": "#2D1B10", "accent-ui": "#F0C8A6", "accent-soft": "#493426",
      success: "#A8CFAC", warning: "#EAC68C", danger: "#FF9A90", "tone-violet": "#D1BAEB",
    }),
  ],
  light: [
    preset("light", "paper", "Paper", "Warm paper with Suivelle’s sapphire accent.", {}),
    preset("light", "mist", "Mist", "Cool pale blue with crisp ink.", {
      background: "#F2F5FA", sidebar: "#E7EDF5", "editor-background": "#F9FBFE", "toolbar-background": "#EEF3F9",
      "surface-1": "#FFFFFF", "surface-2": "#FFFFFF", field: "#FFFFFF", "surface-hover": "#E4EBF5", "surface-active": "#D6E1F0",
      "text-primary": "#17243A", "text-secondary": "#40536F", "text-muted": "#506580",
      accent: "#315993", "accent-hover": "#264878", "on-accent": "#FFFFFF", "accent-ui": "#244A83", "accent-soft": "#DCE7F6",
    }),
    preset("light", "sand", "Sand", "Soft parchment with a warm terracotta accent.", {
      background: "#F7F0E5", sidebar: "#EEE4D4", "editor-background": "#FBF6EE", "toolbar-background": "#F2E9DC",
      "surface-1": "#FFFDF8", "surface-2": "#FFF9F0", field: "#FFFDF8", "surface-hover": "#F0E4D5", "surface-active": "#E9D8C1",
      "text-primary": "#30271F", "text-secondary": "#594A3C", "text-muted": "#6C5947",
      accent: "#7C492B", "accent-hover": "#663B22", "on-accent": "#FFFFFF", "accent-ui": "#754226", "accent-soft": "#EDDDC9",
      success: "#296B43", warning: "#865012", danger: "#AC3024", "tone-violet": "#694686",
    }),
    preset("light", "sage", "Sage", "Pale green surfaces with a woodland accent.", {
      background: "#F1F5EF", sidebar: "#E4ECE2", "editor-background": "#F7FAF5", "toolbar-background": "#EAF0E7",
      "surface-1": "#FCFEFA", "surface-2": "#FCFEFA", field: "#FCFEFA", "surface-hover": "#E3ECDE", "surface-active": "#CFDCC9",
      "text-primary": "#203428", "text-secondary": "#445B45", "text-muted": "#536B55",
      accent: "#376448", "accent-hover": "#2C513A", "on-accent": "#FFFFFF", "accent-ui": "#2C5638", "accent-soft": "#DCE9D9",
      success: "#296B43", warning: "#865012", danger: "#AC3024", "tone-violet": "#694686",
    }),
    preset("light", "lavender", "Lavender", "Soft lavender surfaces with a muted violet accent.", {
      background: "#F5F2FA", sidebar: "#ECE6F3", "editor-background": "#FBF9FD", "toolbar-background": "#F0EBF6",
      "surface-1": "#FEFCFF", "surface-2": "#FEFCFF", field: "#FEFCFF", "surface-hover": "#EEE6F5", "surface-active": "#E0D3EC",
      "text-primary": "#2C2338", "text-secondary": "#574B68", "text-muted": "#685A79",
      accent: "#69508B", "accent-hover": "#554071", "on-accent": "#FFFFFF", "accent-ui": "#583E7B", "accent-soft": "#E9DFF2",
      success: "#296B43", warning: "#865012", danger: "#AC3024", "tone-violet": "#694686",
    }),
  ],
};

/** Accent controls must still work after a full palette supplied explicit accent colors. */
export function withAccentPreset(config: ThemeConfig, accent: string): ThemeConfig {
  const palettes = { light: { ...config.palettes.light }, dark: { ...config.palettes.dark } };
  for (const mode of ["light", "dark"] as const) {
    for (const key of ["accent", "accent-hover", "accent-ui", "accent-soft", "on-accent", "focus-ring", "hl-keyword"] as const) delete palettes[mode][key];
  }
  return { ...config, accent, palettes };
}

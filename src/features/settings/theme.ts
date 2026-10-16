import { normalizeHex, normalizeHexAlpha, compositeColor, hexToRgb, rgbToHex } from "../../lib/color";
import { varsFor, type Choices } from "../../stores/preferences";

export const COLOR_ROLES = [
  ["background", "App background", "Backgrounds", "#F7F6F2", "#0C1329"],
  ["sidebar", "Sidebar background", "Backgrounds", "#EEEFF0", "#0A1022"],
  ["editor-background", "Editor background", "Backgrounds", "#F7F6F2", "#0C1329"],
  ["toolbar-background", "Toolbar background", "Backgrounds", "#F7F6F2", "#0C1329"],
  ["surface-1", "Panels", "Backgrounds", "#FFFFFF", "#131C3A"],
  ["surface-2", "Menus and dialogs", "Backgrounds", "#FFFFFF", "#172243"],
  ["field", "Input fields", "Backgrounds", "#FFFFFF", "#0B1127"],
  ["text-primary", "Primary text", "Text", "#151B2E", "#E8EDF8"],
  ["text-secondary", "Secondary text", "Text", "#4F5A72", "#A4AFC6"],
  ["text-muted", "Muted text", "Text", "#59647A", "#94A0BB"],
  ["sidebar-text", "Sidebar text", "Text", "#151B2E", "#E8EDF8"],
  ["sidebar-secondary", "Sidebar secondary text", "Text", "#4F5A72", "#A4AFC6"],
  ["sidebar-muted", "Sidebar muted text", "Text", "#59647A", "#94A0BB"],
  ["accent", "Button fill", "Accent", "#2A4694", "#3B5BA9"],
  ["on-accent", "Button text", "Accent", "#FFFFFF", "#FFFFFF"],
  ["accent-ui", "Links and accent text", "Accent", "#1C3270", "#A9C4FF"],
  ["accent-soft", "Selection background", "Accent", "#DDE8FA", "#15224A"],
  ["surface-hover", "Hover background", "Advanced", "#E9ECF1", "#172245"],
  ["surface-active", "Active background", "Advanced", "#D8DDE6", "#243257"],
  ["accent-hover", "Button hover", "Advanced", "#1F3677", "#4A6BBF"],
  ["focus-ring", "Focus ring", "Advanced", "#1C3270", "#A9C4FF"],
  ["border-subtle", "Subtle dividers", "Advanced", "#E7E7E4", "#172035"],
  ["border", "Borders", "Advanced", "#DCDCD9", "#172338"],
  ["border-strong", "Strong borders", "Advanced", "#CACAC5", "#222F48"],
  ["success", "Success", "Advanced", "#2A7348", "#62B886"],
  ["warning", "Warning", "Advanced", "#9B4F08", "#E0A050"],
  ["danger", "Error", "Advanced", "#B73426", "#EF6E62"],
  ["code-bg", "Code background", "Backgrounds", "#EEEFF0", "#0F1830"],
  ["hl-keyword", "Code keywords", "Advanced", "#2F4A91", "#A9C4FF"],
  ["hl-string", "Code strings", "Advanced", "#2A7348", "#7CCB9C"],
  ["hl-number", "Code numbers", "Advanced", "#A3540A", "#E6AB62"],
  ["hl-title", "Code titles", "Advanced", "#1F66A8", "#7AB8EC"],
  ["hl-comment", "Code comments", "Advanced", "#59647A", "#94A0BB"],
  ["tone-gray", "Gray data and text", "Advanced", "#6B6A67", "#9B9A97"],
  ["tone-violet", "Violet data and text", "Advanced", "#6346DC", "#A794F7"],
  ["tone-red", "Red data and text", "Advanced", "#C0392B", "#EC7B6F"],
  ["tone-orange", "Orange data and text", "Advanced", "#A3540A", "#E0A050"],
  ["tone-green", "Green data and text", "Advanced", "#2A7348", "#62B886"],
  ["tone-blue", "Blue data and text", "Advanced", "#1F66A8", "#6FB1E8"],
] as const;
export type ColorRole = typeof COLOR_ROLES[number][0];
export const supportsOpacity = (role: ColorRole) => COLOR_ROLES.some(([key, , group]) => key === role && group === "Backgrounds") || role === "accent-soft";
export const normalizeThemeColor = (role: ColorRole, value: unknown) => supportsOpacity(role) ? normalizeHexAlpha(value) : normalizeHex(value);
export type Palette = Partial<Record<ColorRole, string>>;
export type PaletteMode = "light" | "dark";
export interface ThemeConfig { accent: string | null; palettes: Record<PaletteMode, Palette> }
export interface ThemeProfile { id: string; name: string; config: ThemeConfig }
export const emptyTheme = (): ThemeConfig => ({ accent: null, palettes: { light: {}, dark: {} } });

export function sanitizeTheme(raw: unknown, strict = false): ThemeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (strict) throw new Error("This file does not contain a valid theme.");
    return emptyTheme();
  }
  const source = raw as Record<string, unknown>;
  const palettes = source.palettes as Record<string, unknown> | undefined;
  if (strict && (!palettes || typeof palettes !== "object")) throw new Error("The theme needs light and dark palettes.");
  const out = emptyTheme();
  if (typeof source.accent === "string" && ["sapphire", "cyan", "violet", "green", "rose"].includes(source.accent)) out.accent = source.accent;
  else if (strict && source.accent != null) throw new Error("Unknown accent preset.");
  for (const mode of ["light", "dark"] as const) {
    const palette = palettes?.[mode];
    if (!palette || typeof palette !== "object" || Array.isArray(palette)) {
      if (strict) throw new Error(`The ${mode} palette is missing or invalid.`);
      continue;
    }
    for (const [key, value] of Object.entries(palette)) {
      if (!COLOR_ROLES.some(([role]) => role === key)) {
        if (strict) throw new Error(`Unknown color role: ${key}.`);
        continue;
      }
      const hex = normalizeThemeColor(key as ColorRole, value);
      if (hex) out.palettes[mode][key as ColorRole] = hex;
      else if (strict) throw new Error(`Enter a valid hex color for ${key}.`);
    }
  }
  return out;
}

export const mix = (a: string, b: string, fraction: number) => rgbToHex(hexToRgb(a).map((v, i) => v * (1 - fraction) + hexToRgb(b)[i] * fraction));
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => hexToRgb(hex).map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export const readableText = (background: string) => contrast("#FFFFFF", background) >= contrast("#000000", background) ? "#FFFFFF" : "#000000";
function readableTint(background: string, fraction: number) {
  const ink = readableText(background);
  for (let amount = fraction; amount < 1; amount += 0.05) {
    const tint = mix(background, ink, amount);
    if (contrast(tint, background) >= 4.5) return tint;
  }
  return ink;
}

function basePalette(mode: PaletteMode, choices: Choices, accent: string | null): Record<ColorRole, string> {
  const out = Object.fromEntries(COLOR_ROLES.map(([key, , , light, dark]) => [key, mode === "light" ? light : dark])) as Record<ColorRole, string>;
  const variables = varsFor({ ...choices, accent: accent ?? choices.accent });
  for (const [name, value] of Object.entries(variables)) {
    const key = name.slice(2) as ColorRole;
    if (!(key in out)) continue;
    const pair = /^light-dark\((#[\da-f]{6}), (#[\da-f]{6})\)$/i.exec(value);
    if (pair) out[key] = pair[mode === "light" ? 1 : 2];
    const rgba = /^light-dark\(rgba\(([^)]+)\), rgba\(([^)]+)\)\)$/.exec(value);
    if (rgba) {
      const [r, g, b, opacity] = rgba[mode === "light" ? 1 : 2].split(",").map(Number);
      out[key] = mix(out.background, rgbToHex([r, g, b]), opacity);
    }
  }
  out["focus-ring"] = out["accent-ui"];
  return out;
}

function overrides(config: ThemeConfig, mode: PaletteMode, base: Record<ColorRole, string>): Palette {
  const custom = config.palettes[mode];
  const derived: Palette = {};
  const background = compositeColor(custom.background ?? base.background, "#FFFFFF");
  if (custom.background) {
    const ink = readableText(background);
    derived["editor-background"] = custom.background;
    derived["toolbar-background"] = custom.background;
    derived["surface-hover"] = mix(background, ink, 0.07);
    derived["surface-active"] = mix(background, ink, 0.14);
    derived["border-subtle"] = mix(background, ink, 0.1);
    derived.border = mix(background, ink, 0.18);
    derived["border-strong"] = mix(background, ink, 0.3);
    derived["code-bg"] = custom.field ?? mix(background, ink, 0.04);
  }
  if (custom.field) derived["code-bg"] = custom.field;
  if (custom["text-muted"]) derived["hl-comment"] = custom["text-muted"];
  if (custom.success) { derived["hl-string"] = custom.success; derived["tone-green"] = custom.success; }
  if (custom.warning) { derived["hl-number"] = custom.warning; derived["tone-orange"] = custom.warning; }
  if (custom.danger) derived["tone-red"] = custom.danger;
  if (custom.sidebar) {
    const sidebar = compositeColor(custom.sidebar, background);
    derived["sidebar-text"] = readableText(sidebar);
    derived["sidebar-secondary"] = readableTint(sidebar, 0.8);
    derived["sidebar-muted"] = readableTint(sidebar, 0.7);
  }
  if (custom.accent) {
    derived["on-accent"] = readableText(custom.accent);
    derived["accent-hover"] = mix(custom.accent, mode === "dark" ? "#FFFFFF" : "#000000", 0.12);
    derived["accent-ui"] = mix(custom.accent, readableText(background), 0.5);
    derived["accent-soft"] = mix(background, custom.accent, 0.18);
  }
  if (custom["accent-ui"] || derived["accent-ui"]) derived["focus-ring"] = custom["accent-ui"] ?? derived["accent-ui"];
  if (custom["accent-ui"] || derived["accent-ui"]) derived["hl-keyword"] = custom["accent-ui"] ?? derived["accent-ui"];
  return { ...derived, ...custom };
}

export function resolvePalette(config: ThemeConfig, mode: PaletteMode, choices: Choices): Record<ColorRole, string> {
  const base = basePalette(mode, choices, config.accent);
  return { ...base, ...overrides(config, mode, base) };
}

/** Only override requested/derived roles; an empty custom theme keeps the original CSS intact. */
export function themeVariables(config: ThemeConfig, choices: Choices): Record<string, string> {
  const lightBase = basePalette("light", choices, config.accent), darkBase = basePalette("dark", choices, config.accent);
  const light = overrides(config, "light", lightBase), dark = overrides(config, "dark", darkBase);
  const keys = new Set([...Object.keys(light), ...Object.keys(dark)] as ColorRole[]);
  return Object.fromEntries([...keys].map((key) => [`--${key}`, `light-dark(${light[key] ?? lightBase[key]}, ${dark[key] ?? darkBase[key]})`]));
}

export function contrastWarnings(colors: Record<ColorRole, string>) {
  const backdrop = compositeColor(colors.background, "#FFFFFF");
  const effective = Object.fromEntries(Object.entries(colors).map(([key, color]) => [key, key === "background" ? backdrop : compositeColor(color, backdrop)])) as Record<ColorRole, string>;
  const checks: [ColorRole, ColorRole, number][] = [];
  for (const text of ["text-primary", "text-secondary", "text-muted", "accent-ui", "success", "warning", "danger"] as const) {
    for (const bg of ["background", "editor-background", "toolbar-background", "surface-1", "surface-2", "field"] as const) checks.push([text, bg, 4.5]);
  }
  checks.push(["sidebar-text", "sidebar", 4.5], ["sidebar-secondary", "sidebar", 4.5], ["sidebar-muted", "sidebar", 4.5], ["on-accent", "accent", 4.5], ["on-accent", "accent-hover", 4.5], ["text-primary", "accent-soft", 4.5], ["accent-ui", "accent-soft", 4.5]);
  for (const bg of ["background", "sidebar", "field", "surface-2"] as const) checks.push(["focus-ring", bg, 3]);
  for (const fg of ["text-primary", "hl-keyword", "hl-string", "hl-number", "hl-title", "hl-comment"] as const) checks.push([fg, "code-bg", 4.5]);
  return checks.map(([fg, bg, minimum]) => ({ fg, bg, minimum, ratio: contrast(effective[fg], effective[bg]) })).filter((test) => test.ratio < test.minimum);
}

export function parseThemeFile(text: string, fileName?: string): { name: string; config: ThemeConfig } {
  const data = JSON.parse(text) as Record<string, unknown>;
  if (!data || data.format !== "suivelle-theme" || data.version !== 1) throw new Error("Choose a Suivelle theme file (version 1).");
  const name = fileName?.replace(/\.json$/i, "").trim() || (typeof data.name === "string" ? data.name.trim() : "") || "Imported theme";
  return { name: name.slice(0, 80), config: sanitizeTheme(data.config, true) };
}

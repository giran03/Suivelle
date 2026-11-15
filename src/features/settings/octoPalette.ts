import { hexToRgb, rgbToHex } from "../../lib/color";
import type { OctoToken } from "./octopolisThemes";

/** Octopolis's start-up colours (its Midnight theme); a theme that omits a token falls back to these. */
export const OCTO_MIDNIGHT: Readonly<Record<OctoToken, string>> = {
  bg: "#101216", surface: "#161920", "surface-2": "#1c2029", "surface-3": "#242935", border: "#262b36", "border-strong": "#343a48",
  text: "#e3e6ed", "text-muted": "#8b93a5", "text-faint": "#5d6576", accent: "#6d8cff", danger: "#f06b6b", "g-folder": "#e7b955", ok: "#5ec98a",
  "tag-jpg": "#f59e0b", "tag-png": "#38bdf8", "tag-gif": "#c084fc", "tag-webp": "#34d399", "tag-svg": "#f472b6", "tag-avif": "#2dd4bf",
  "tag-mp4": "#fb7185", "tag-mov": "#fb923c", "tag-webm": "#a3e635", "tag-mkv": "#818cf8", "tag-other": "#94a3b8",
};

const blend = (a: string, b: string, t: number) => { const x = hexToRgb(a), y = hexToRgb(b); return rgbToHex(x.map((v, i) => v * (1 - t) + y[i] * t)); };
const lum = (hex: string) => hexToRgb(hex).map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const onColor = (bg: string) => ratio("#ffffff", bg) >= ratio("#000000", bg) ? "#ffffff" : "#000000";

/** Nudges `color` toward white (dark themes) or black (light ones) until it reaches `min` contrast on every surface. */
function legible(color: string, surfaces: string[], min: number, dark: boolean): string {
  const target = dark ? "#ffffff" : "#000000";
  for (let t = 0; t <= 1.0001; t += 0.04) {
    const next = t === 0 ? color : blend(color, target, t);
    if (surfaces.every((surface) => ratio(next, surface) >= min)) return next;
  }
  return target;
}

/**
 * Expands an Octopolis token set into every Suivelle colour role. The window frame and sidebar sit on `bg`,
 * the page and toolbar are the raised `surface` card, and menus and panels use `surface-2`, as in Octopolis.
 * Text and status colours are nudged only as far as needed to stay at WCAG AA on every surface they meet.
 */
export function octoPalette(tokens: Readonly<Partial<Record<OctoToken, string>>>, scheme: "dark" | "light"): Record<string, string> {
  const t = { ...OCTO_MIDNIGHT, ...tokens } as Record<OctoToken, string>;
  const dark = scheme === "dark";
  const accentSoft = blend(t.surface, t.accent, dark ? 0.2 : 0.14);
  const surfaces = [t.bg, t.surface, t["surface-2"], t["surface-3"], accentSoft];
  const ink = (c: string, min = 4.5, extra: string[] = []) => legible(c, [...surfaces, ...extra], min, dark);
  const secondary = ink(t["text-muted"]);
  const muted = ink(blend(t["text-muted"], t["text-faint"], 0.3));
  const accentUi = ink(t.accent);
  const onAccent = onColor(t.accent);
  let accentHover: string = blend(t.accent, dark ? "#ffffff" : "#000000", 0.12);
  if (ratio(onAccent, accentHover) < 4.5) accentHover = t.accent;
  const success = ink(t.ok), warning = ink(t["g-folder"]), danger = ink(t.danger);
  const out: Record<string, string> = {
    background: t.bg, sidebar: t.bg, "editor-background": t.surface, "toolbar-background": t.surface,
    "surface-1": t["surface-2"], "surface-2": t["surface-2"], field: t.bg,
    "text-primary": t.text, "text-secondary": secondary, "text-muted": muted,
    "sidebar-text": t.text, "sidebar-secondary": secondary, "sidebar-muted": muted,
    accent: t.accent, "on-accent": onAccent, "accent-ui": accentUi, "accent-soft": accentSoft,
    "surface-hover": t["surface-2"], "surface-active": t["surface-3"], "accent-hover": accentHover, "focus-ring": accentUi,
    "border-subtle": blend(t.border, t.bg, 0.5), border: t.border, "border-strong": t["border-strong"],
    success, warning, danger,
    "code-bg": t.bg, "hl-keyword": accentUi, "hl-string": success, "hl-number": ink(t["tag-jpg"]), "hl-title": ink(t["tag-png"]), "hl-comment": muted,
    "tone-gray": muted, "tone-violet": ink(t["tag-gif"]), "tone-red": danger, "tone-orange": ink(t["tag-mov"]), "tone-green": success, "tone-blue": ink(t["tag-png"]),
  };
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.toUpperCase()]));
}

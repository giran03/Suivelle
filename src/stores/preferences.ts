import "../lib/legacy";
import { create } from "zustand";
import type { ThemeSetting } from "../types";

const KEY = "suivelle.preferences";

interface Option {
  id: string;
  label: string;
  /** CSS custom properties this choice sets on the document root. */
  vars: Record<string, string>;
}

/**
 * Every reading and layout preference, in one table: the settings dialog renders its rows from it
 * and `applyPreferences` turns the choices into CSS variables, so a new preference is one entry.
 * "Page" choices shape the document; "interface" choices shape the app around it.
 */
export const CHOICES = {
  textSize: {
    title: "Text size",
    hint: "The size of text inside pages.",
    fallback: "default",
    options: [
      { id: "small", label: "Small", vars: { "--doc-size": "0.9375rem" } },
      { id: "default", label: "Default", vars: { "--doc-size": "1rem" } },
      { id: "large", label: "Large", vars: { "--doc-size": "1.0625rem" } },
      { id: "xlarge", label: "Extra large", vars: { "--doc-size": "1.1875rem" } },
    ],
  },
  pageWidth: {
    title: "Page width",
    hint: "How wide a page reads. Databases always use the full width.",
    fallback: "standard",
    options: [
      { id: "narrow", label: "Narrow", vars: { "--page-max": "680px" } },
      { id: "standard", label: "Standard", vars: { "--page-max": "840px" } },
      { id: "wide", label: "Wide", vars: { "--page-max": "1080px" } },
      { id: "full", label: "Full", vars: { "--page-max": "100%" } },
    ],
  },
  pageSpacing: {
    title: "Page spacing",
    hint: "How much air there is between lines and blocks inside a page.",
    fallback: "normal",
    options: [
      { id: "compact", label: "Compact", vars: { "--doc-line": "1.4", "--doc-gap": "1px" } },
      { id: "normal", label: "Normal", vars: { "--doc-line": "1.5", "--doc-gap": "3px" } },
      { id: "relaxed", label: "Relaxed", vars: { "--doc-line": "1.72", "--doc-gap": "6px" } },
    ],
  },
  pageFont: {
    title: "Page font",
    hint: "The typeface for text inside pages. Titles and the app keep theirs.",
    fallback: "sans",
    options: [
      { id: "sans", label: "Sans", vars: { "--doc-font": "var(--font-ui)" } },
      { id: "serif", label: "Serif", vars: { "--doc-font": 'Cambria, "Iowan Old Style", Georgia, serif' } },
      { id: "mono", label: "Mono", vars: { "--doc-font": '"Cascadia Mono", Consolas, ui-monospace, monospace' } },
    ],
  },
  accent: {
    title: "Accent colour",
    hint: "Buttons, links, the selected page and the focus ring.",
    fallback: "sapphire",
    options: [
      { id: "sapphire", label: "Sapphire", vars: {} },
      { id: "cyan", label: "Cyan", vars: { "--accent": "light-dark(#0b6b84, #0b6b84)", "--accent-hover": "light-dark(#09566b, #137f9b)", "--accent-ui": "light-dark(#0b6b84, #9fe3f2)", "--accent-soft": "light-dark(#dcf0f5, #11313c)" } },
      { id: "violet", label: "Violet", vars: { "--accent": "light-dark(#6346dc, #7a58ee)", "--accent-hover": "light-dark(#5336cb, #6a48e2)", "--accent-ui": "light-dark(#6346dc, #a794ff)", "--accent-soft": "light-dark(#ebe8fb, #211e3a)" } },
      { id: "green", label: "Green", vars: { "--accent": "light-dark(#1f7a4a, #1f7a4a)", "--accent-hover": "light-dark(#1a6a40, #1a6a40)", "--accent-ui": "light-dark(#1f7a4a, #6fcf97)", "--accent-soft": "light-dark(#e2f3e9, #172e22)" } },
      { id: "rose", label: "Rose", vars: { "--accent": "light-dark(#c0305a, #c0305a)", "--accent-hover": "light-dark(#a82750, #a82750)", "--accent-ui": "light-dark(#c0305a, #f08aa8)", "--accent-soft": "light-dark(#fbe6ec, #331a24)" } },
    ],
  },
  density: {
    title: "Interface spacing",
    hint: "How tightly the sidebar, menus, lists and database rows are packed.",
    fallback: "normal",
    options: [
      { id: "compact", label: "Compact", vars: { "--density": "0.72" } },
      { id: "normal", label: "Normal", vars: { "--density": "1" } },
      { id: "relaxed", label: "Relaxed", vars: { "--density": "1.35" } },
    ],
  },
  corners: {
    title: "Corners",
    hint: "How round buttons, fields, menus, panels and page blocks are.",
    fallback: "default",
    options: [
      { id: "sharp", label: "Sharp", vars: { "--r-xs": "2px", "--r-sm": "3px", "--r-md": "4px", "--r-lg": "5px", "--r-xl": "6px", "--r-2xl": "8px" } },
      { id: "default", label: "Default", vars: {} },
      { id: "round", label: "Round", vars: { "--r-xs": "6px", "--r-sm": "9px", "--r-md": "12px", "--r-lg": "14px", "--r-xl": "18px", "--r-2xl": "22px" } },
    ],
  },
  lines: {
    title: "Lines",
    hint: "How visible borders and dividers are.",
    fallback: "default",
    options: [
      { id: "soft", label: "Soft", vars: { "--border-subtle": "light-dark(rgba(20, 20, 30, 0.035), rgba(255, 255, 255, 0.03))", "--border": "light-dark(rgba(20, 20, 30, 0.07), rgba(255, 255, 255, 0.055))", "--border-strong": "light-dark(rgba(20, 20, 30, 0.13), rgba(255, 255, 255, 0.1))" } },
      { id: "default", label: "Default", vars: {} },
      { id: "clear", label: "Clear", vars: { "--border-subtle": "light-dark(rgba(20, 20, 30, 0.14), rgba(255, 255, 255, 0.11))", "--border": "light-dark(rgba(20, 20, 30, 0.24), rgba(255, 255, 255, 0.2))", "--border-strong": "light-dark(rgba(20, 20, 30, 0.4), rgba(255, 255, 255, 0.34))" } },
    ],
  },
  uiScale: {
    title: "Interface size",
    hint: "Zooms the whole app: sidebar, menus, dialogs and pages together.",
    fallback: "100",
    options: [
      { id: "90", label: "90%", vars: {} },
      { id: "100", label: "100%", vars: {} },
      { id: "110", label: "110%", vars: {} },
      { id: "125", label: "125%", vars: {} },
      { id: "150", label: "150%", vars: {} },
    ],
  },
  motion: {
    title: "Motion",
    hint: "System follows your Windows setting. Subtle is shorter and softer. Reduced keeps quick fades only.",
    fallback: "system",
    options: [
      { id: "system", label: "System", vars: {} },
      { id: "subtle", label: "Subtle", vars: {} },
      { id: "reduced", label: "Reduced", vars: {} },
    ],
  },
} satisfies Record<string, { title: string; hint: string; fallback: string; options: Option[] }>;

export type ChoiceKey = keyof typeof CHOICES;
export type Choices = Record<ChoiceKey, string>;

/** How the app behaves around its window. Per device; the desktop shell keeps its own copy so it applies before the page loads. */
export interface ShellChoices {
  launchAtStartup: boolean;
  startMinimized: boolean;
  showTray: boolean;
  closeToTray: boolean;
  minimizeToTray: boolean;
  focusShortcut: boolean;
}
export const SHELL_DEFAULTS: ShellChoices = { launchAtStartup: false, startMinimized: false, showTray: false, closeToTray: false, minimizeToTray: false, focusShortcut: true };

interface Saved extends Choices {
  /** Null until the current workspace's legacy mode has been adopted once. */
  theme: ThemeSetting | null;
  /** Quick capture from any program with Ctrl+Alt+N. Off until asked for. */
  globalCapture: boolean;
  windowCorners: boolean;
  shell: ShellChoices;
}

const KEYS = Object.keys(CHOICES) as ChoiceKey[];

export const UI_SCALE_MIN = 50;
export const UI_SCALE_MAX = 200;

/** Whole percentages only: never pass an invalid zoom factor to the webview. */
export function parseUiScale(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const percent = Number(value);
  return Number.isInteger(percent) && percent >= UI_SCALE_MIN && percent <= UI_SCALE_MAX ? String(percent) : null;
}

function defaults(): Choices {
  return Object.fromEntries(KEYS.map((k) => [k, CHOICES[k].fallback])) as Choices;
}

/** A saved choice that no longer exists (an old version, a hand-edited value) falls back to the default. */
export function sanitize(raw: Partial<Record<string, unknown>>): Choices {
  const out = defaults();
  for (const k of KEYS) {
    const v = raw[k];
    if (k === "uiScale") { out[k] = parseUiScale(v) ?? CHOICES.uiScale.fallback; continue; }
    if (typeof v === "string" && CHOICES[k].options.some((o: Option) => o.id === v)) out[k] = v;
  }
  return out;
}

/** The CSS variables for a set of choices. */
export function varsFor(choices: Choices): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEYS) {
    const opt = (CHOICES[k].options as Option[]).find((o) => o.id === choices[k]);
    if (opt) Object.assign(out, opt.vars);
  }
  return out;
}

/** The interface-spacing multiplier for a choice (1 is normal). */
export function densityOf(id: string): number {
  return Number(varsFor({ ...defaults(), density: id })["--density"]) || 1;
}

/** A row height in pixels, scaled by the interface spacing. For code that must know the height, such as virtual lists. */
export function useScaled(px: number, min = 0): number {
  const id = usePreferences((s) => s.density);
  return Math.max(min, Math.round(px * densityOf(id)));
}

function read(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Record<string, unknown>>;
    const sh = (v.shell ?? {}) as Partial<Record<keyof ShellChoices, unknown>>;
    const shell = Object.fromEntries(Object.entries(SHELL_DEFAULTS).map(([k, fallback]) => [k, typeof sh[k as keyof ShellChoices] === "boolean" ? sh[k as keyof ShellChoices] : fallback])) as unknown as ShellChoices;
    const theme = v.theme === "system" || v.theme === "light" || v.theme === "dark" ? v.theme : null;
    return { ...sanitize(v), theme, globalCapture: v.globalCapture === true, windowCorners: v.windowCorners === true, shell };
  } catch {
    return { ...defaults(), theme: null, globalCapture: false, windowCorners: false, shell: SHELL_DEFAULTS };
  }
}

interface PreferencesState extends Saved {
  setTheme: (theme: ThemeSetting) => void;
  adoptTheme: (legacy: ThemeSetting) => void;
  set: (key: ChoiceKey, id: string) => void;
  setGlobalCapture: (on: boolean) => void;
  setWindowCorners: (on: boolean) => void;
  setShell: (shell: ShellChoices) => void;
  /** Back to the defaults for every reading and layout choice. */
  reset: () => void;
}

/** App-wide reading preferences for this device. Workspace settings live with the workspace instead. */
export const usePreferences = create<PreferencesState>((set, get) => {
  const save = (patch: Partial<Saved>) => {
    set(patch);
    try {
      const { set: _s, setTheme: _t, adoptTheme: _a, setGlobalCapture: _g, setWindowCorners: _w, setShell: _h, reset: _r, ...data } = get();
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      /* Convenience only: the choice still applies for this session. */
    }
  };
  return {
    ...read(),
    setTheme: (theme) => save({ theme }),
    adoptTheme: (legacy) => { if (get().theme === null) save({ theme: legacy }); },
    set: (key, id) => {
      if (key === "uiScale") {
        const scale = parseUiScale(id);
        if (scale !== null) save({ uiScale: scale });
      } else save({ [key]: id } as Partial<Saved>);
    },
    setGlobalCapture: (globalCapture) => save({ globalCapture }),
    setWindowCorners: (windowCorners) => save({ windowCorners }),
    setShell: (shell) => save({ shell }),
    reset: () => save({ ...defaults(), windowCorners: false }),
  };
});

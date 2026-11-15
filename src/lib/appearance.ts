import { ipc } from "./ipc";
import { useEffect } from "react";
import { compositeColor, normalizeHex } from "./color";
import { CHOICES, densityOf, usePreferences, varsFor, type ChoiceKey, type Choices } from "../stores/preferences";
import { COLOR_ROLES, themeVariables, type ThemeConfig } from "../features/settings/theme";
import { useThemes } from "../features/settings/themes";
import type { ThemeSetting } from "../types";

export interface TrayPalettePayload {
  surface1: string;
  textPrimary: string;
  textSecondary: string;
  borderStrong: string;
  accentUi: string;
  danger: string;
}

export interface TrayAppearancePayload {
  theme: ThemeSetting;
  light: TrayPalettePayload;
  dark: TrayPalettePayload;
  density: number;
  radiusCard: number;
  radiusItem: number;
  uiScale: number;
  reducedMotion: boolean;
  subtleMotion: boolean;
}

function splitLightDark(value: string | undefined, fallbackLight: string, fallbackDark: string): [string, string] {
  if (!value) return [fallbackLight, fallbackDark];
  const m = value.match(/^light-dark\(\s*([^,]+)\s*,\s*([^)]+)\s*\)$/i);
  if (m) return [m[1].trim(), m[2].trim()];
  return [value.trim(), value.trim()];
}

function solidHex(color: string, backdrop: string, fallback: string): string {
  const opaque = normalizeHex(color);
  if (opaque) return opaque;
  if (/^#[\da-f]{8}$/i.test(color)) return compositeColor(color, backdrop);
  return fallback;
}

/** Builds the resolved, solid-surface theme and geometry payload for the native Win32 tray menu. */
export function buildTrayAppearance(theme: ThemeSetting | null, choices: Choices, config: ThemeConfig): TrayAppearancePayload {
  const vars = { ...varsFor({ ...choices, accent: config.accent ?? choices.accent }), ...themeVariables(config, choices) };
  const roleDefaults = Object.fromEntries(COLOR_ROLES.map(([role, , , light, dark]) => [role, [light, dark] as const]));
  const pick = (role: string, mode: 0 | 1): string => {
    const [dLight, dDark] = roleDefaults[role];
    const [l, d] = splitLightDark(vars[`--${role}`], dLight, dDark);
    return mode === 0 ? l : d;
  };
  const paletteFor = (mode: 0 | 1): TrayPalettePayload => {
    const bg = solidHex(pick("background", mode), mode === 0 ? "#F6F7F9" : "#101216", mode === 0 ? "#F6F7F9" : "#101216");
    return {
      surface1: solidHex(pick("surface-1", mode), bg, mode === 0 ? "#F1F3F6" : "#1C2029"),
      textPrimary: solidHex(pick("text-primary", mode), bg, mode === 0 ? "#1B1F27" : "#E3E6ED"),
      textSecondary: solidHex(pick("text-secondary", mode), bg, mode === 0 ? "#5F6878" : "#949CAC"),
      borderStrong: solidHex(pick("border-strong", mode), bg, mode === 0 ? "#CFD4DD" : "#343A48"),
      accentUi: solidHex(pick("accent-ui", mode), bg, mode === 0 ? "#385BDD" : "#7995FF"),
      danger: solidHex(pick("danger", mode), bg, mode === 0 ? "#B43A3A" : "#F17171"),
    };
  };
  const radiusCard = parseFloat(vars["--r-xl"] ?? "10") || 10;
  const radiusItem = parseFloat(vars["--r-md"] ?? "6") || 6;
  return {
    theme: theme ?? "dark",
    light: paletteFor(0),
    dark: paletteFor(1),
    density: densityOf(choices.density),
    radiusCard,
    radiusItem,
    uiScale: (Number(choices.uiScale) || 100) / 100,
    reducedMotion: choices.motion === "reduced",
    subtleMotion: choices.motion === "subtle",
  };
}

const KEYS = Object.keys(CHOICES) as ChoiceKey[];

/** Store committed colors rather than a settings preview, for the dependency-free startup splash. */
export function rememberStartupAppearance(choices: Choices, config: ThemeConfig): void {
  const variables = { ...varsFor({ ...choices, accent: config.accent ?? choices.accent }), ...themeVariables(config, choices) };
  const roles = ["background", "text-primary", "surface-1", "border", "accent-ui", "accent"];
  const palette = Object.fromEntries(COLOR_ROLES.filter(([role]) => roles.includes(role)).map(([role, , , light, dark]) => [`--${role}`, variables[`--${role}`] ?? `light-dark(${light}, ${dark})`]));
  try { localStorage.setItem("suivelle.startup-appearance", JSON.stringify({ version: 1, variables: palette })); }
  catch { /* Appearance still works when browser storage is unavailable. */ }
}

/** Zooms the whole webview, so layout, menus and pointer positions all stay in one coordinate space. */
async function setZoom(percent: number): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    document.documentElement.style.removeProperty("--app-viewport-height");
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(percent / 100);
  } else {
    // A plain browser (development, tests) has no webview to zoom.
    (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = percent === 100 ? "" : String(percent / 100);
    document.documentElement.style.setProperty("--app-viewport-height", `${window.innerHeight / (percent / 100)}px`);
  }
}

/** Writes the reading and layout preferences to the document: CSS variables, motion, and zoom. */
export function applyAppearance(choices: Choices, config?: ThemeConfig): void {
  const root = document.documentElement;
  const vars = { ...varsFor({ ...choices, accent: config?.accent ?? choices.accent }), ...(config ? themeVariables(config, choices) : {}) };
  // A choice that leaves a variable unset (violet, the stylesheet default) must clear the previous one.
  for (const k of KEYS) for (const o of CHOICES[k].options) for (const name of Object.keys(o.vars)) if (!(name in vars)) root.style.removeProperty(name);
  for (const [role] of COLOR_ROLES) if (!(`--${role}` in vars)) root.style.removeProperty(`--${role}`);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  // "system" leaves the attribute off so motion.css can follow the operating system.
  if (choices.motion === "subtle" || choices.motion === "reduced") root.setAttribute("data-motion", choices.motion);
  else root.removeAttribute("data-motion");
}

/** Keeps the document in step with the preferences for as long as the app is mounted. */
export function useAppearance(): void {
  const choices = usePreferences((s) => s);
  const config = useThemes((s) => s.preview ?? s.config);
  const committedConfig = useThemes((s) => s.config);
  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) {
      void ipc.windowSetCorners(choices.windowCorners).catch((error) => console.warn("Could not apply window corners", error));
    }
  }, [choices.windowCorners]);
  const signature = KEYS.map((k) => choices[k]).join("|");
  useEffect(() => {
    rememberStartupAppearance(choices, committedConfig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, committedConfig]);
  useEffect(() => {
    applyAppearance(choices, config);
    if ("__TAURI_INTERNALS__" in window) {
      void ipc.traySetAppearance(buildTrayAppearance(choices.theme, choices, config)).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, choices.theme, config]);
  useEffect(() => {
    const update = () => void setZoom(Number(choices.uiScale)).catch(() => undefined);
    update();
    if (!("__TAURI_INTERNALS__" in window)) window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [choices.uiScale]);
}

import { ipc } from "./ipc";
import { useEffect } from "react";
import { CHOICES, usePreferences, varsFor, type ChoiceKey, type Choices } from "../stores/preferences";
import { COLOR_ROLES, themeVariables, type ThemeConfig } from "../features/settings/theme";
import { useThemes } from "../features/settings/themes";

const KEYS = Object.keys(CHOICES) as ChoiceKey[];

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
  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) {
      void ipc.windowSetCorners(choices.windowCorners).catch((error) => console.warn("Could not apply window corners", error));
    }
  }, [choices.windowCorners]);
  const signature = KEYS.map((k) => choices[k]).join("|");
  useEffect(() => {
    applyAppearance(choices, config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, config]);
  useEffect(() => {
    const update = () => void setZoom(Number(choices.uiScale)).catch(() => undefined);
    update();
    if (!("__TAURI_INTERNALS__" in window)) window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [choices.uiScale]);
}

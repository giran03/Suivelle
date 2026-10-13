import { useEffect } from "react";
import type { ThemeSetting } from "../types";
import { APP_ICON_PNG } from "./appIconData";

type Theme = "dark" | "light";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The theme actually in effect: the app's own choice, or the system's when it follows the system. */
export function resolveTheme(setting: ThemeSetting): Theme {
  if (setting === "dark" || setting === "light") return setting;
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

const dataUrl = (theme: Theme) => `data:image/png;base64,${APP_ICON_PNG[theme]}`;

/** Gives the window (and with it the taskbar button and title bar) the icon for `theme`. Does nothing outside the desktop app. */
async function setWindowIcon(theme: Theme): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const [{ getCurrentWindow }, { Image }] = await Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/image")]);
  const bytes = Uint8Array.from(atob(APP_ICON_PNG[theme]), (c) => c.charCodeAt(0));
  await getCurrentWindow().setIcon(await Image.fromBytes(bytes));
}

function setFavicon(theme: Theme): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  link.type = "image/png";
  link.href = dataUrl(theme);
}

/**
 * Keeps the application icon in step with the theme, including when the system theme changes while the
 * app is open. The icon of the installed file itself (the .exe and its shortcuts) is fixed when the app
 * is built; Windows does not let a program change it.
 */
export function useAppIcon(setting: ThemeSetting): void {
  useEffect(() => {
    const apply = () => {
      const theme = resolveTheme(setting);
      setFavicon(theme);
      void setWindowIcon(theme).catch(() => undefined);
    };
    apply();
    if (setting !== "system" || typeof matchMedia !== "function") return;
    const query = matchMedia(DARK_QUERY);
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [setting]);
}

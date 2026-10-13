import { useEffect } from "react";
import type { ThemeSetting } from "../types";

type Theme = "dark" | "light";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The theme actually in effect: the app's own choice, or the system's when it follows the system. */
export function resolveTheme(setting: ThemeSetting): Theme {
  if (setting === "dark" || setting === "light") return setting;
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** The icon PNGs (about 44 kB of base64) load after first paint instead of with the startup bundle. */
const iconPng = async (theme: Theme) => (await import("./appIconData")).APP_ICON_PNG[theme];

/** Gives the window (and with it the taskbar button and title bar) the icon for `theme`. Does nothing outside the desktop app. */
async function setWindowIcon(theme: Theme): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const [{ getCurrentWindow }, { Image }, png] = await Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/image"), iconPng(theme)]);
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  await getCurrentWindow().setIcon(await Image.fromBytes(bytes));
}

async function setFavicon(theme: Theme): Promise<void> {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  const png = await iconPng(theme);
  link.type = "image/png";
  link.href = `data:image/png;base64,${png}`;
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
      void setFavicon(theme).catch(() => undefined);
      void setWindowIcon(theme).catch(() => undefined);
    };
    apply();
    if (setting !== "system" || typeof matchMedia !== "function") return;
    const query = matchMedia(DARK_QUERY);
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [setting]);
}

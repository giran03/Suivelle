import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BrandMark } from "./BrandMark";
import { toAppError } from "../lib/ipc";
import "./titlebar.css";

/** Window chrome lives outside the workspace so switching spaces never resets its controls. */
export function Titlebar() {
  const desktop = "__TAURI_INTERNALS__" in window;
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    const stops: (() => void)[] = [];
    const keep = (stop: () => void) => { if (disposed) stop(); else stops.push(stop); };
    const refresh = () => { void appWindow.isMaximized().then((value) => { if (!disposed) setMaximized(value); }).catch(() => undefined); };
    refresh();
    void appWindow.isFocused().then((value) => { if (!disposed) setFocused(value); }).catch(() => undefined);
    void appWindow.onResized(refresh).then(keep).catch(() => undefined);
    void appWindow.onFocusChanged(({ payload }) => { if (!disposed) setFocused(payload); }).then(keep).catch(() => undefined);
    return () => { disposed = true; stops.forEach((stop) => stop()); };
  }, [desktop]);
  if (!desktop) return null;
  const run = async (action: "minimize" | "toggleMaximize" | "close") => {
    setError(null);
    try {
      const appWindow = getCurrentWindow();
      await appWindow[action]();
      if (action === "toggleMaximize") setMaximized(await appWindow.isMaximized());
    } catch (e) { setError(`Could not ${action === "toggleMaximize" ? "resize" : action} the window: ${toAppError(e).message}`); }
  };
  return <header className="app-titlebar" data-focused={focused} role="banner" aria-label="Application title bar">
    <div className="app-titlebar-drag" data-tauri-drag-region>
      <BrandMark size={18} /><span>Suivelle</span>
    </div>
    {error && <p className="app-titlebar-error" role="alert">{error}</p>}
    <div className="app-window-controls" role="group" aria-label="Window controls">
      <button type="button" aria-label="Minimize window" title="Minimize" onClick={() => void run("minimize")}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5h10" /></svg></button>
      <button type="button" aria-label={maximized ? "Restore window" : "Maximize window"} title={maximized ? "Restore" : "Maximize"} onClick={() => void run("toggleMaximize")}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">{maximized ? <path d="M5.5 5.5v-2h7v7h-2m-7-5h7v7h-7z" /> : <rect x="3.5" y="3.5" width="9" height="9" />}</svg></button>
      <button type="button" className="app-window-close" aria-label="Close window" title="Close" onClick={() => void run("close")}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9" /></svg></button>
    </div>
  </header>;
}

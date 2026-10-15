import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BrandMark } from "./BrandMark";
import { Icon } from "./Icon";
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
      <button type="button" aria-label="Minimize window" title="Minimize" onClick={() => void run("minimize")}><Icon name="minimize" /></button>
      <button type="button" aria-label={maximized ? "Restore window" : "Maximize window"} title={maximized ? "Restore" : "Maximize"} onClick={() => void run("toggleMaximize")}><Icon name={maximized ? "restoreWindow" : "maximize"} /></button>
      <button type="button" className="app-window-close" aria-label="Close window" title="Close" onClick={() => void run("close")}><Icon name="close" /></button>
    </div>
  </header>;
}

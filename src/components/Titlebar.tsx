import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BrandMark } from "./BrandMark";
import { Icon } from "./Icon";
import { toAppError } from "../lib/ipc";
import { usePreferences } from "../stores/preferences";
import "./titlebar.css";

/** Window chrome lives outside the workspace so switching spaces never resets its controls. */
export function Titlebar() {
  const desktop = "__TAURI_INTERNALS__" in window;
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const windowControls = usePreferences((s) => s.windowControls);
  const windowControlsSide = usePreferences((s) => s.windowControlsSide);
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
  const isMac = windowControls === "macos";
  const trafficLights = (right = false) => (
    <div className={right ? "tb-traffic tb-traffic-right" : "tb-traffic"} role="group" aria-label="Window controls">
      <button type="button" className="tl tl-close" aria-label="Close window" title="Close" onClick={() => void run("close")}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5 8.5 8.5M8.5 3.5 3.5 8.5" /></svg>
      </button>
      <button type="button" className="tl tl-min" aria-label="Minimize window" title="Minimize" onClick={() => void run("minimize")}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7" /></svg>
      </button>
      <button type="button" className="tl tl-max" aria-label={maximized ? "Restore window" : "Maximize window"} title={maximized ? "Restore" : "Maximize"} onClick={() => void run("toggleMaximize")}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          {maximized ? <path d="M3.5 5v3.5H7M5 3.5h3.5V7" /> : <path d="M6 2.5v7M2.5 6h7" />}
        </svg>
      </button>
    </div>
  );
  return <header className="app-titlebar" data-focused={focused} role="banner" aria-label="Application title bar">
    <div className="app-titlebar-drag" data-tauri-drag-region>
      {isMac && windowControlsSide === "left" && trafficLights()}
      <BrandMark size={18} /><span>Suivelle</span>
    </div>
    {error && <p className="app-titlebar-error" role="alert">{error}</p>}
    {isMac ? (
      windowControlsSide === "right" ? trafficLights(true) : null
    ) : (
      <div className="app-window-controls" role="group" aria-label="Window controls">
        <button type="button" aria-label="Minimize window" title="Minimize" onClick={() => void run("minimize")}><Icon name="minimize" size={12} /></button>
        <button type="button" aria-label={maximized ? "Restore window" : "Maximize window"} title={maximized ? "Restore" : "Maximize"} onClick={() => void run("toggleMaximize")}><Icon name={maximized ? "restoreWindow" : "maximize"} size={12} /></button>
        <button type="button" className="app-window-close" aria-label="Close window" title="Close" onClick={() => void run("close")}><Icon name="close" size={12} /></button>
      </div>
    )}
  </header>;
}

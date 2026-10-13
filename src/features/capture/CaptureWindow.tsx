import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { CaptureBody } from "./QuickCapture";
import { saveWindowCapture, type CaptureContext } from "./window";
import { useAppearance } from "../../lib/appearance";
import { sanitize, usePreferences } from "../../stores/preferences";
import { useThemes } from "../settings/themes";
import { sanitizeTheme } from "../settings/theme";

export function CaptureWindow() {
  const [context, setContext] = useState<CaptureContext>({ page: null, ready: false, theme: usePreferences.getState().theme ?? "system" });
  const [error, setError] = useState<string | null>(null);
  useAppearance();
  const close = () => void getCurrentWebviewWindow().close().catch(() => setError("Could not close the capture window."));

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    const popup = getCurrentWebviewWindow();
    popup.listen<CaptureContext>("capture-context", ({ payload }) => {
      if (payload.appearance) usePreferences.setState(sanitize(payload.appearance));
      if (payload.colors) useThemes.getState().setPreview(sanitizeTheme(payload.colors));
      setContext(payload);
    })
      .then(async (unlisten) => {
        if (cancelled) { unlisten(); return; }
        stop = unlisten;
        await popup.emitTo("main", "capture-ready");
      }).catch(() => setError("Could not connect to the workspace. Close this window and try again."));
    return () => { cancelled = true; stop?.(); };
  }, []);

  useEffect(() => {
    if (context.theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", context.theme);
  }, [context.theme]);

  return (
    <main className="capture-window">
      <CaptureBody onClose={close} onSave={saveWindowCapture} page={context.page} ready={context.ready} />
      {error && <p className="field-error" role="alert">{error}</p>}
    </main>
  );
}

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { capture } from "./capture";
import type { CaptureOptions } from "./QuickCapture";
import { useWorkspace } from "../../stores/workspace";
import { isPreparing, useUpdates } from "../updates/store";
import type { ThemeSetting } from "../../types";
import { usePreferences, sanitize, type Choices } from "../../stores/preferences";
import { useThemes } from "../settings/themes";
import type { ThemeConfig } from "../settings/theme";

export interface CaptureContext {
  page: { title: string } | null;
  ready: boolean;
  theme: ThemeSetting;
  appearance?: Choices;
  colors?: ThemeConfig;
}

interface CaptureRequest extends CaptureOptions { id: string; text: string }
interface CaptureResult { id: string; error: string | null }

/** Keep writes in the main webview, where the active workspace and unsaved editor live. */
export async function installCaptureWindowBridge(): Promise<() => void> {
  const main = getCurrentWebviewWindow();
  const context = () => {
    const s = useWorkspace.getState();
    return main.emitTo("quick-capture", "capture-context", {
      page: s.view === "page" && s.selectedPage?.kind === "page" ? { title: s.selectedPage.title } : null,
      ready: s.ready && !s.workspaceBusy && !isPreparing(useUpdates.getState().phase),
      theme: usePreferences.getState().theme ?? s.settings.theme,
      appearance: sanitize({ ...usePreferences.getState() }),
      colors: useThemes.getState().preview ?? useThemes.getState().config,
    } satisfies CaptureContext).catch(() => undefined);
  };
  const stopReady = await main.listen("capture-ready", () => void context());
  let stopSave: (() => void);
  try {
    stopSave = await main.listen<CaptureRequest>("capture-save", async ({ payload }) => {
      const s = useWorkspace.getState();
      const error = !s.ready || s.workspaceBusy || isPreparing(useUpdates.getState().phase)
        ? "The workspace is not ready yet. Please try again."
        : await capture(payload.text, { todo: payload.todo, target: payload.target });
      await main.emitTo("quick-capture", "capture-result", { id: payload.id, error } satisfies CaptureResult);
    });
  } catch (error) {
    stopReady();
    throw error;
  }
  const stopWorkspace = useWorkspace.subscribe(() => void context());
  const stopUpdates = useUpdates.subscribe(() => void context());
  const stopAppearance = usePreferences.subscribe(() => void context());
  const stopColors = useThemes.subscribe(() => void context());
  return () => { stopReady(); stopSave(); stopWorkspace(); stopUpdates(); stopAppearance(); stopColors(); };
}

export async function saveWindowCapture(text: string, options: CaptureOptions): Promise<string | null> {
  const popup = getCurrentWebviewWindow();
  const id = crypto.randomUUID();
  let stop: (() => void) | undefined;
  try {
    return await new Promise<string | null>((resolve, reject) => {
      popup.listen<CaptureResult>("capture-result", ({ payload }) => {
        if (payload.id === id) resolve(payload.error);
      }).then((unlisten) => {
        stop = unlisten;
        return popup.emitTo("main", "capture-save", { id, text, ...options } satisfies CaptureRequest);
      }).catch(reject);
    });
  } finally {
    stop?.();
  }
}

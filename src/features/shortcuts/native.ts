import { usePreferences } from "../../stores/preferences";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { ipc, toAppError } from "../../lib/ipc";
import { ACTIONS, overlaps, type Binding } from "./bindings";
export interface GlobalConfig { capture: Binding[]; focus: Binding[]; captureEnabled: boolean; focusEnabled: boolean }
export interface GlobalState { config: GlobalConfig; active: { capture: boolean; focus: boolean }; errors: Record<string, string> }
export const useGlobalShortcuts = create<{ state: GlobalState | null; error: string | null }>(() => ({ state: null, error: null }));
export async function loadGlobalShortcuts() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try { useGlobalShortcuts.setState({ state: await ipc.shortcutsGet(), error: null }); }
  catch (e) { useGlobalShortcuts.setState({ error: toAppError(e).message }); }
}
export async function saveGlobalBindings(id: string, bindings: Binding[], replace = false) {
  const state = useGlobalShortcuts.getState().state;
  if (!state) throw new Error("Global shortcuts have not loaded. Try reopening settings.");
  const config = { ...state.config, [id === "global-capture" ? "capture" : "focus"]: bindings };
  if (replace) {
    const other = id === "global-capture" ? "focus" : "capture";
    config[other] = config[other].filter(b => !bindings.some(candidate => overlaps(b, candidate)));
  }
  await setRecordingNative(false);
  try { useGlobalShortcuts.setState({ state: await ipc.shortcutsSet(config), error: null }); }
  catch (e) { await setRecordingNative(true); await loadGlobalShortcuts(); throw new Error(toAppError(e).message); }
}
export async function resetGlobalBindings() {
  const { ACTIONS } = await import("./bindings");
  const state = useGlobalShortcuts.getState().state;
  if (!state) throw new Error("Global shortcuts have not loaded.");
  useGlobalShortcuts.setState({ state: await ipc.shortcutsSet({ ...state.config, capture: ACTIONS.find(a => a.id === "global-capture")!.defaults, focus: ACTIONS.find(a => a.id === "global-focus")!.defaults }), error: null });
}
export async function enableGlobalBinding(id: string, enabled: boolean) {
  const state = useGlobalShortcuts.getState().state;
  if (!state) throw new Error("Global shortcuts have not loaded.");
  const bindingKey = id === "global-capture" ? "capture" : "focus";
  const bindings = state.config[bindingKey];
  const config = { ...state.config, [id === "global-capture" ? "captureEnabled" : "focusEnabled"]: enabled,
    [bindingKey]: enabled && !bindings.length ? ACTIONS.find(a => a.id === id)!.defaults : bindings };
  try { useGlobalShortcuts.setState({ state: await ipc.shortcutsSet(config), error: null }); }
  catch (e) { await loadGlobalShortcuts(); throw new Error(toAppError(e).message); }
}
let recordingQueue: Promise<unknown> = Promise.resolve();
export async function setRecordingNative(active: boolean) {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const next = recordingQueue.catch(() => undefined).then(() => ipc.shortcutsRecording(active));
  recordingQueue = next;
  try { await next; }
  catch (e) { const message = `Could not ${active ? "isolate" : "restore"} system-wide shortcuts: ${toAppError(e).message}`; useGlobalShortcuts.setState({ error: message }); if (active) throw new Error(message); }
}

export function installGlobalShortcutSync() {
  let disposed = false;
  let stop: (() => void) | undefined;
  if (!("__TAURI_INTERNALS__" in window)) return () => {};
  void listen<GlobalState>("shortcuts-changed", event => { useGlobalShortcuts.setState({ state: event.payload, error: null });
    const prefs = usePreferences.getState();
    prefs.setGlobalCapture(event.payload.config.captureEnabled);
    prefs.setShell({ ...prefs.shell, focusShortcut: event.payload.config.focusEnabled });
  }).then(un => { if (disposed) un(); else stop = un; });
  void loadGlobalShortcuts();
  return () => { disposed = true; stop?.(); };
}

import { invoke } from "@tauri-apps/api/core";

declare global {
  /** Set once at boot, before the app's modules load: why the workspace opened read-only, if it did. */
  var __SUIVELLE_SAFE_MODE__: string | null | undefined;
}

/** Asks the backend whether the workspace opened read-only. Outside the desktop app it never does. */
export async function loadSafeMode(): Promise<string | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  try { return (await invoke<string | null>("app_safe_mode")) ?? null; } catch { return null; }
}

export const safeModeReason = (): string | null => globalThis.__SUIVELLE_SAFE_MODE__ ?? null;

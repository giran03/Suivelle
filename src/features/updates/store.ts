import { create } from "zustand";
import { Channel, invoke } from "@tauri-apps/api/core";
import bundled from "../../../release-notes.json";
import { READ_ONLY } from "../../lib/access";
import { toAppError, waitForPendingIpc } from "../../lib/ipc";
import { flushAllEditors } from "../editor/flushRegistry";
import { useSettingsDialog } from "../settings/store";
import { useWorkspace } from "../../stores/workspace";

export interface Release { version: string; date: string; notes: string }
export interface UpdatePreferences { autoCheck: boolean; autoDownload: boolean }
export interface UpdateSnapshot {
  installed: Release; preferences: UpdatePreferences; lastCheck: string | null;
  available: Release | null; ready: boolean; pendingChangelog: boolean;
  unsupported: string | null; recoveryBackup: string | null; installationFailed: boolean;
}
export type Phase = "idle" | "checking" | "downloading" | "saving" | "installing";
interface Updates {
  snapshot: UpdateSnapshot | null; phase: Phase; error: string | null; progress: { downloaded: number; total: number | null };
  preparation: string; changelog: Release | null; returnToSettings: boolean; notice: boolean;
  init: () => Promise<void>; check: (automatic?: boolean) => Promise<void>; download: () => Promise<void>;
  preferences: (patch: Partial<UpdatePreferences>) => Promise<void>; install: () => Promise<void>;
  showChangelog: (release?: Release) => void; hideChangelog: () => void; acknowledge: () => Promise<void>;
}

export const isPreparing = (phase: Phase) => phase === "saving" || phase === "installing";
let initialization: Promise<void> | null = null;
let notifiedVersion: string | null = null;
export const useUpdates = create<Updates>((set, get) => ({
  snapshot: null, phase: "idle", error: null, progress: { downloaded: 0, total: null },
  preparation: "", changelog: null, returnToSettings: false, notice: false,
  init: () => {
    if (!initialization) initialization = (async () => {
      try {
        const snapshot = READ_ONLY ? {
          installed: bundled, preferences: { autoCheck: false, autoDownload: false }, lastCheck: null,
          available: null, ready: false, pendingChangelog: false,
          unsupported: "Updates are available in the installed desktop app.", recoveryBackup: null, installationFailed: false,
        } : await invoke<UpdateSnapshot>("update_status");
        set({ snapshot });
      } catch (e) { set({ error: toAppError(e).message }); initialization = null; }
    })();
    return initialization;
  },
  check: async (automatic = false) => {
    if (get().phase !== "idle" || get().snapshot?.unsupported || get().snapshot?.ready) return;
    set({ phase: "checking", error: null });
    try {
      const snapshot = await invoke<UpdateSnapshot>("update_check");
      set({ snapshot, phase: "idle" });
      if (automatic && snapshot.available && snapshot.preferences.autoCheck && snapshot.preferences.autoDownload) await get().download();
    } catch (e) { set({ phase: "idle", error: toAppError(e).message }); }
  },
  download: async () => {
    if (get().phase !== "idle" || !get().snapshot?.available || get().snapshot?.unsupported) return;
    set({ phase: "downloading", error: null, progress: { downloaded: 0, total: null } });
    const onProgress = new Channel<{ downloaded: number; total: number | null }>();
    onProgress.onmessage = (progress) => set({ progress });
    try {
      const snapshot = await invoke<UpdateSnapshot>("update_download", { onProgress });
      const notice = notifiedVersion !== snapshot.available?.version;
      notifiedVersion = snapshot.available?.version ?? null;
      set({ snapshot, phase: "idle", notice });
    } catch (e) { set({ phase: "idle", error: toAppError(e).message }); }
  },
  preferences: async (patch) => {
    const snapshot = get().snapshot;
    if (!snapshot || get().phase !== "idle" || snapshot.unsupported) return;
    try {
      const next = await invoke<UpdateSnapshot>("update_preferences", { preferences: { ...snapshot.preferences, ...patch } });
      set({ snapshot: next, error: null });
      if (patch.autoDownload && next.preferences.autoCheck && next.available && !next.ready) await get().download();
    } catch (e) { set({ error: toAppError(e).message }); }
  },
  install: async () => {
    if (get().phase !== "idle" || !get().snapshot?.ready || get().snapshot?.unsupported) return;
    if (useSettingsDialog.getState().closeGuard) {
      set({ error: "Apply or discard your theme changes before installing the update." }); return;
    }
    if (useWorkspace.getState().workspaceBusy || document.querySelector("dialog[open]:not(.settings)")) {
      set({ error: "Finish the current dialog or workspace operation before installing the update." }); return;
    }
    set({ phase: "saving", preparation: "Saving changes…", error: null, notice: false });
    useSettingsDialog.getState().hide();
    try {
      await flushAllEditors(true);
      await waitForPendingIpc();
      // An in-flight attachment may finish by changing its editor after the first flush.
      await flushAllEditors(true);
      await waitForPendingIpc();
      set({ phase: "installing", preparation: "Creating safety backup…" });
      const onProgress = new Channel<string>();
      onProgress.onmessage = (preparation) => set({ preparation });
      await invoke("update_install", { onProgress });
    } catch (e) {
      set({ phase: "idle", preparation: "", error: toAppError(e).message });
      useSettingsDialog.getState().show("updates");
    }
  },
  showChangelog: (release) => {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    const returnToSettings = useSettingsDialog.getState().open;
    useSettingsDialog.getState().requestClose(() => set({ changelog: release ?? snapshot.installed, returnToSettings }));
  },
  hideChangelog: () => {
    const returnToSettings = get().returnToSettings;
    set({ changelog: null, returnToSettings: false });
    if (returnToSettings) {
      // Wait for the existing dialog's close event, then restore settings and focus.
      const restore = () => {
        if (document.querySelector("dialog[open]")) window.setTimeout(restore, 50);
        else useSettingsDialog.getState().show("updates");
      };
      window.setTimeout(restore, 0);
    }
  },
  acknowledge: async () => {
    const snapshot = get().snapshot;
    if (!snapshot?.pendingChangelog) return;
    try {
      await invoke("update_changelog_presented");
      set((state) => ({ snapshot: state.snapshot ? { ...state.snapshot, pendingChangelog: false } : null }));
    } catch (e) { set({ error: toAppError(e).message }); }
  },
}));

const INTERVAL = 6 * 60 * 60 * 1000;
/** One scheduler per mounted app; failures back off and never interfere with editing. */
export function startUpdateScheduler(): () => void {
  let stopped = false;
  let nextAttempt = Date.now() + 15_000;
  let failures = 0;
  const tick = async () => {
    const { snapshot, phase } = useUpdates.getState();
    if (stopped || !snapshot || !snapshot.preferences.autoCheck || snapshot.unsupported || phase !== "idle" || snapshot.ready || Date.now() < nextAttempt) return;
    const checked = snapshot.lastCheck ? Date.parse(snapshot.lastCheck) : 0;
    if (!failures && checked && Date.now() - checked < INTERVAL) return;
    nextAttempt = Date.now() + INTERVAL;
    await useUpdates.getState().check(true);
    if (stopped) return;
    if (useUpdates.getState().error) {
      failures = Math.min(failures + 1, 6);
      nextAttempt = Date.now() + Math.min(60_000 * 2 ** failures, INTERVAL);
    } else failures = 0;
  };
  const timer = window.setInterval(() => void tick(), 30_000);
  const wake = () => { if (document.visibilityState === "visible") void tick(); };
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", wake);
  return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake); };
}

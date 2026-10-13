import { listen } from "@tauri-apps/api/event";
import { useWorkspace } from "../../stores/workspace";
import type { Reminder } from "../../types";

/** When a reminder fires while the app is open, says so in the window too, with a way to jump to the page. */
export function installReminderToasts(): () => void {
  if (!("__TAURI_INTERNALS__" in window)) return () => undefined;
  let stop: (() => void) | undefined;
  let cancelled = false;
  void listen<Reminder>("reminder-due", ({ payload }) => {
    const s = useWorkspace.getState();
    if (s.workspace && s.selectedPageId === payload.pageId) { s.notify(`Reminder: ${payload.note || payload.pageTitle || "this page"}`); return; }
    s.notify(`Reminder: ${payload.note || payload.pageTitle || "Untitled"}`, () => useWorkspace.getState().selectPage(payload.pageId), "Open");
  }).then((unlisten) => { if (cancelled) unlisten(); else stop = unlisten; });
  return () => { cancelled = true; stop?.(); };
}

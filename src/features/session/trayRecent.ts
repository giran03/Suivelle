import { listen } from "@tauri-apps/api/event";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";

/** Keeps the tray menu's recent pages current and opens the one picked there. Desktop only. */
export function installTrayRecent(): () => void {
  if (!("__TAURI_INTERNALS__" in window)) return () => undefined;
  let timer: number | undefined;
  let last = "";
  const refresh = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const ws = useWorkspace.getState().workspace;
      if (!ws) return;
      try {
        const pages = (await ipc.pageListRecent(ws.id, 5)).map((p) => ({ id: p.id, title: p.title }));
        const key = JSON.stringify(pages);
        if (key === last) return;
        last = key;
        await ipc.traySetRecent(pages);
      } catch { /* The tray is a convenience; the app works without it. */ }
    }, 1500);
  };
  const unsubscribe = useWorkspace.subscribe((s, prev) => { if (s.selectedPageId !== prev.selectedPageId || s.workspace?.id !== prev.workspace?.id) refresh(); });
  refresh();
  let stop: (() => void) | undefined;
  let cancelled = false;
  void listen<string>("open-page", ({ payload }) => void useWorkspace.getState().openPage(payload))
    .then((unlisten) => { if (cancelled) unlisten(); else stop = unlisten; });
  return () => { cancelled = true; stop?.(); unsubscribe(); window.clearTimeout(timer); };
}

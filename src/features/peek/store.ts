import { create } from "zustand";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { useSplit } from "../split/store";

/**
 * The "open beside" entry point. Side panes now live in the split view; this keeps the older
 * show/hide calls working and exposes the first side pane's page.
 */
const first = () => useSplit.getState().panes[0] ?? null;

export const usePeek = create<{ pageId: string | null; show: (pageId: string) => void; hide: () => void }>(() => ({
  pageId: null,
  show: (rawId) => {
    const hash = rawId.indexOf("#");
    const pageId = hash >= 0 ? rawId.slice(0, hash) : rawId;
    void (async () => {
      try {
        const page = await ipc.pageGet(pageId);
        const ws = useWorkspace.getState();
        if (page.workspaceId !== ws.workspace?.id) await ws.switchWorkspace(page.workspaceId);
      } catch {
        // Fall through to place(); SplitPane handles missing/inaccessible pages.
      }
      useSplit.getState().place(pageId);
    })();
  },
  hide: () => useSplit.getState().closeAll(),
}));

useSplit.subscribe(() => {
  const pageId = first();
  if (usePeek.getState().pageId !== pageId) usePeek.setState({ pageId });
});

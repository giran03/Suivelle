import { create } from "zustand";
import { useSplit } from "../split/store";

/**
 * The "open beside" entry point. Side panes now live in the split view; this keeps the older
 * show/hide calls working and exposes the first side pane's page.
 */
const first = () => useSplit.getState().panes[0] ?? null;

export const usePeek = create<{ pageId: string | null; show: (pageId: string) => void; hide: () => void }>(() => ({
  pageId: null,
  show: (pageId) => useSplit.getState().place(pageId),
  hide: () => useSplit.getState().closeAll(),
}));

useSplit.subscribe(() => {
  const pageId = first();
  if (usePeek.getState().pageId !== pageId) usePeek.setState({ pageId });
});

import { create } from "zustand";
import { useWorkspace } from "../../stores/workspace";

/** The page shown in the side peek beside the open page, if any. */
export const usePeek = create<{ pageId: string | null; show: (pageId: string) => void; hide: () => void }>((set) => ({
  pageId: null,
  // The page already open needs no peek; two editors on one page would race each other's saves.
  show: (pageId) => { const s = useWorkspace.getState(); if (s.view !== "page" || s.selectedPageId !== pageId) set({ pageId }); },
  hide: () => set({ pageId: null }),
}));

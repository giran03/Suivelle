import { create } from "zustand";
import type { Editor } from "@tiptap/core";

interface GalleryState {
  open: boolean;
  targetPageId: string | null;
  workspaceId: string | null;
  targetEditor: Editor | null;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  show: (targetPageId?: string, workspaceId?: string, targetEditor?: Editor) => void;
  hide: () => void;
}

export const useTemplateGallery = create<GalleryState>((set) => ({
  open: false,
  targetPageId: null,
  workspaceId: null,
  targetEditor: null,
  busy: false,
  setBusy: busy => set({ busy }),
  show: (targetPageId, workspaceId, targetEditor) => set(s => s.busy ? s : { open: true, targetPageId: targetPageId ?? null, workspaceId: workspaceId ?? null, targetEditor: targetEditor ?? null }),
  hide: () => set(s => s.busy ? s : { open: false, targetPageId: null, workspaceId: null, targetEditor: null }),
}));

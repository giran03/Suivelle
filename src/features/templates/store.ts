import { create } from "zustand";

interface GalleryState {
  open: boolean;
  show: () => void;
  hide: () => void;
}

export const useTemplateGallery = create<GalleryState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

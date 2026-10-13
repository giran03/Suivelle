import { create } from "zustand";

interface FilesState {
  open: boolean;
  show: () => void;
  hide: () => void;
}

export const useFilesDialog = create<FilesState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

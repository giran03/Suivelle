import { create } from "zustand";

interface DialogState {
  open: boolean;
  show: () => void;
  hide: () => void;
}

export const useBackupsDialog = create<DialogState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

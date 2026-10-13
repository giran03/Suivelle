import { create } from "zustand";

interface PanelState {
  open: boolean;
  toggle: () => void;
  hide: () => void;
}

export const useHistoryPanel = create<PanelState>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  hide: () => set({ open: false }),
}));

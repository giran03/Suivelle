import { create } from "zustand";

interface PaletteState {
  open: boolean;
  show: () => void;
  hide: () => void;
  toggle: () => void;
}

export const usePalette = create<PaletteState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

export const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl";

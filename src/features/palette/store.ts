import { create } from "zustand";

interface PaletteState {
  open: boolean;
  task: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  showTask: () => void;
  show: () => void;
  hide: () => void;
  toggle: () => void;
}

export const usePalette = create<PaletteState>((set) => ({
  open: false,
  task: false,
  busy: false,
  setBusy: busy => set({ busy }),
  showTask: () => set({ open: true, task: true }),
  show: () => set({ open: true, task: false }),
  hide: () => set(s => s.busy ? s : { open: false, task: false }),
  toggle: () => set((s) => s.busy ? s : { open: !s.open, task: false }),
}));

export const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl";

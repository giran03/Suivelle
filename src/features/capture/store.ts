import { create } from "zustand";

interface CaptureState {
  open: boolean;
  show: () => void;
  hide: () => void;
}

export const useQuickCapture = create<CaptureState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

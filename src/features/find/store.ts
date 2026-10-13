import { create } from "zustand";

interface FindUi {
  open: boolean;
  replace: boolean;
  /** Bumped on every request so an already-open bar re-focuses and selects its text. */
  nonce: number;
  show: (opts?: { replace?: boolean }) => void;
  hide: () => void;
}

export const useFindBar = create<FindUi>((set) => ({
  open: false,
  replace: false,
  nonce: 0,
  show: (opts) => set((s) => ({ open: true, replace: opts?.replace ?? s.replace, nonce: s.nonce + 1 })),
  hide: () => set({ open: false, replace: false }),
}));

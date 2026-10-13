import { create } from "zustand";

interface SettingsState {
  open: boolean;
  section: "updates" | null;
  show: (section?: "updates") => void;
  hide: () => void;
  closeGuard: ((after?: () => void) => void) | null;
  requestClose: (after?: () => void) => void;
  finishClose: (after?: () => void) => void;
}

export const useSettingsDialog = create<SettingsState>((set, get) => ({
  open: false,
  section: null,
  show: (section) => set({ open: true, section: section ?? null }),
  closeGuard: null,
  hide: () => get().requestClose(),
  requestClose: (after) => { if (get().open && get().closeGuard) get().closeGuard!(after); else get().finishClose(after); },
  finishClose: (after) => { set({ open: false, closeGuard: null }); after?.(); },
}));

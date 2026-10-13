import { create } from "zustand";

const KEY = "suivelle.outline";
const remembered = () => { try { return localStorage.getItem(KEY) === "open"; } catch { return false; } };

/** Whether the page outline is shown beside pages; remembered across launches on this device. */
export const useOutline = create<{ open: boolean; toggle: () => void }>((set, get) => ({
  open: remembered(),
  toggle: () => {
    const open = !get().open;
    try { localStorage.setItem(KEY, open ? "open" : "closed"); } catch { /* Convenience only. */ }
    set({ open });
  },
}));

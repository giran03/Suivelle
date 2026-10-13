import { create } from "zustand";

export type SaveIndicator = "idle" | "saving" | "saved" | "error";

interface SaveStatusState {
  status: SaveIndicator;
  detail: string | null;
  retry: (() => void) | null;
  /** Called by the open editor with its sync state; a finished save shows "Saved" briefly. */
  report: (state: "idle" | "saving" | "error", detail: string | null, retry: (() => void) | null) => void;
  clear: () => void;
}

let fade: number | undefined;

export const useSaveStatus = create<SaveStatusState>((set, get) => ({
  status: "idle",
  detail: null,
  retry: null,
  report: (state, detail, retry) => {
    window.clearTimeout(fade);
    if (state === "idle") {
      // Only a real save (saving, then idle) earns a "Saved" confirmation.
      if (get().status === "saving") {
        set({ status: "saved", detail: null, retry: null });
        fade = window.setTimeout(() => set({ status: "idle" }), 2200);
      } else set({ status: "idle", detail: null, retry: null });
    } else set({ status: state, detail, retry });
  },
  clear: () => {
    window.clearTimeout(fade);
    set({ status: "idle", detail: null, retry: null });
  },
}));

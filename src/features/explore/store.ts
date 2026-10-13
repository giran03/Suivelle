import { create } from "zustand";

export type ExplorePanel = "remind" | "reminders" | "tags" | "graph";

/** Which explore dialog is open: a new reminder, the reminders list, tags, or the link graph. */
export const useExplore = create<{ panel: ExplorePanel | null; tag: string | null; show: (panel: ExplorePanel, tag?: string) => void; hide: () => void }>((set) => ({
  panel: null,
  tag: null,
  show: (panel, tag) => set({ panel, tag: tag ?? null }),
  hide: () => set({ panel: null }),
}));

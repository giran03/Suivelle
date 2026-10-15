import { create } from "zustand";
import { ipc } from "../../lib/ipc";

export type ReviewTab = "review" | "activity" | "health";

interface AgentsState {
  /** Proposals waiting for review, for the sidebar badge. */
  pending: number;
  hasActiveAgents: boolean;
  open: boolean;
  tab: ReviewTab;
  /** Bumped whenever agents change something, so open lists reload. */
  epoch: number;
  show: (tab?: ReviewTab) => void;
  hide: () => void;
  setTab: (tab: ReviewTab) => void;
  refresh: () => Promise<void>;
}

export const useAgents = create<AgentsState>((set) => ({
  pending: 0,
  hasActiveAgents: false,
  open: false,
  tab: "review",
  epoch: 0,
  show: (tab) => set((s) => ({ open: true, tab: tab ?? s.tab })),
  hide: () => set({ open: false }),
  setTab: (tab) => set({ tab }),
  refresh: async () => {
    try {
      const overview = await ipc.agentsOverview();
      set((s) => ({ pending: overview.pending, hasActiveAgents: overview.agents.some((agent) => agent.status === "active"), epoch: s.epoch + 1 }));
    } catch {
      // The badge is a convenience; a failed count leaves the last one.
    }
  },
}));

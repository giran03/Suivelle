import { create } from "zustand";

type Tab = "import" | "export";

interface DialogState {
  open: boolean;
  tab: Tab;
  scope: "documents" | "workspace";
  workspaceId: string | null;
  busy: boolean;
  show: (tab?: Tab, scope?: "documents" | "workspace", workspaceId?: string) => void;
  setBusy: (busy: boolean) => void;
  hide: () => void;
}

export const useTransferDialog = create<DialogState>((set) => ({
  open: false,
  tab: "import",
  scope: "documents",
  workspaceId: null,
  busy: false,
  show: (tab = "import", scope = "documents", workspaceId) => set((s) => s.busy ? s : { open: true, tab, scope, workspaceId: workspaceId ?? null }),
  setBusy: (busy) => set({ busy }),
  hide: () => set((s) => s.busy ? s : { open: false }),
}));

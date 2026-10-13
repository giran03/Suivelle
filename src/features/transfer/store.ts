import { create } from "zustand";

type Tab = "import" | "export";

interface DialogState {
  open: boolean;
  tab: Tab;
  scope: "documents" | "workspace";
  busy: boolean;
  show: (tab?: Tab, scope?: "documents" | "workspace") => void;
  setBusy: (busy: boolean) => void;
  hide: () => void;
}

export const useTransferDialog = create<DialogState>((set) => ({
  open: false,
  tab: "import",
  scope: "documents",
  busy: false,
  show: (tab = "import", scope = "documents") => set((s) => s.busy ? s : { open: true, tab, scope }),
  setBusy: (busy) => set({ busy }),
  hide: () => set((s) => s.busy ? s : { open: false }),
}));

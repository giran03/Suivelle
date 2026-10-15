import { create } from "zustand";
import type { Page } from "../../types";

type Tab = "import" | "export";

interface DialogState {
  open: boolean;
  tab: Tab;
  scope: "documents" | "workspace";
  workspaceId: string | null;
  busy: boolean;
  pdfPage: Page | null;
  showPdf: (page: Page, workspaceId: string) => void;
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
  pdfPage: null,
  showPdf: (page, workspaceId) => set((s) => s.busy ? s : { open: true, tab: "export", scope: "documents", workspaceId, pdfPage: page }),
  show: (tab = "import", scope = "documents", workspaceId) => set((s) => s.busy ? s : { open: true, tab, scope, workspaceId: workspaceId ?? null, pdfPage: null }),
  setBusy: (busy) => set({ busy }),
  hide: () => set((s) => s.busy ? s : { open: false }),
}));

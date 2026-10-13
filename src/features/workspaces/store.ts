import { create } from "zustand";

export type WorkspaceDialogMode = "manage" | "create" | "delete";

/** Open state for the workspace dialog, kept apart from the dialog so it can load on demand. */
export const useWorkspaceDialog = create<{ open: boolean; mode: WorkspaceDialogMode; show: (mode?: WorkspaceDialogMode) => void; hide: () => void }>((set) => ({ open: false, mode: "manage", show: (mode = "manage") => set({ open: true, mode }), hide: () => set({ open: false }) }));

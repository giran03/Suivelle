import { create } from "zustand";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { CanvasBoard } from "../../types";

interface BoardsState {
  workspaceId: string | null;
  boards: CanvasBoard[];
  loaded: boolean;
  /** The board shown in the main area while the workspace view is "canvas". */
  activeId: string | null;
  load: (workspaceId: string) => Promise<void>;
  create: (name?: string) => Promise<CanvasBoard | null>;
  rename: (id: string, name: string) => Promise<void>;
  duplicate: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  open: (id: string) => void;
}

const report = (e: unknown) => useWorkspace.getState().setError(toAppError(e).message);
const byCreated = (a: CanvasBoard, b: CanvasBoard) => a.createdAt.localeCompare(b.createdAt);

/** The workspace's canvas boards: the sidebar lists them and the main area shows the open one. */
export const useBoards = create<BoardsState>((set, get) => ({
  workspaceId: null,
  boards: [],
  loaded: false,
  activeId: null,

  load: async (workspaceId) => {
    if (get().workspaceId !== workspaceId) set({ workspaceId, boards: [], loaded: false, activeId: null });
    try {
      const boards = await ipc.canvasBoardList(workspaceId);
      if (get().workspaceId !== workspaceId) return;
      set({ boards, loaded: true });
    } catch (e) {
      report(e);
    }
  },

  create: async (name) => {
    const ws = useWorkspace.getState().workspace;
    if (!ws) return null;
    try {
      const board = await ipc.canvasBoardCreate(ws.id, name ?? "");
      set((s) => ({ boards: [...s.boards, board].sort(byCreated) }));
      get().open(board.id);
      return board;
    } catch (e) {
      report(e);
      return null;
    }
  },

  rename: async (id, name) => {
    try {
      const board = await ipc.canvasBoardRename(id, name);
      set((s) => ({ boards: s.boards.map((b) => (b.id === id ? board : b)) }));
    } catch (e) {
      report(e);
    }
  },

  duplicate: async (id) => {
    try {
      const board = await ipc.canvasBoardDuplicate(id);
      set((s) => ({ boards: [...s.boards, board].sort(byCreated) }));
      get().open(board.id);
    } catch (e) {
      report(e);
    }
  },

  remove: async (id) => {
    try {
      await ipc.canvasBoardDelete(id);
      const wasOpen = get().activeId === id;
      set((s) => ({ boards: s.boards.filter((b) => b.id !== id), activeId: wasOpen ? null : s.activeId }));
      if (wasOpen && useWorkspace.getState().view === "canvas") useWorkspace.setState({ view: "page" });
    } catch (e) {
      report(e);
    }
  },

  open: (id) => {
    set({ activeId: id });
    useWorkspace.setState({ view: "canvas" });
  },
}));

type DropHandler = (pageIds: string[], x: number, y: number) => boolean;
let dropHandler: DropHandler = () => false;

/** The open canvas registers itself here so the sidebar can drop pages on it without importing it. */
export function registerBoardDrop(handler: DropHandler): () => void {
  dropHandler = handler;
  return () => {
    if (dropHandler === handler) dropHandler = () => false;
  };
}

/** Offers dragged pages to the open canvas; true when it took them. */
export function dropPagesOnBoard(pageIds: string[], x: number, y: number): boolean {
  return dropHandler(pageIds, x, y);
}

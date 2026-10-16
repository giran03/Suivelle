import { create } from "zustand";
import { useWorkspace } from "../../stores/workspace";
import { MAX_TILES, MIN_TILES, paneCount, presetTree, type Layout, type LayoutId } from "./layouts";
import { evenTree, insertLeaf, leaf, moveLeaf, rects, relabel, removeLeaf, resizeAt, type DockZone, type Tree } from "./tree";

/**
 * Split view. Pane 0 is always the main view (the page selected in the workspace store); the other
 * panes hold pages of their own, so a pane always has a page. A page lives in at most one pane,
 * because two editors on one page would race each other's saves. The tree decides where panes sit.
 */
interface SplitState {
  layout: Layout;
  tree: Tree;
  /** Pages in panes 1..n. */
  panes: string[];
  /** Arranges a preset from the pages that are open, borrowing favourites and top-level pages to fill it. */
  setLayout: (layout: LayoutId) => void;
  /** Shows a page in a pane: swapped into `slot`, or in a new pane beside the roomiest one when there is no slot. */
  place: (pageId: string, slot?: number) => void;
  /** Docks a page against one edge of a pane (or swaps it in for "center"), moving it if it is already shown. */
  dock: (pageId: string, slot: number, zone: DockZone) => void;
  swap: (a: number, b: number) => void;
  closePane: (slot: number) => void;
  removePage: (pageId: string) => void;
  closeAll: () => void;
  resizeAt: (path: number[], index: number, delta: number) => void;
  evenOut: () => void;
}

const SINGLE = { layout: "single" as Layout, tree: leaf(0) as Tree, panes: [] as string[] };
const mainId = () => {
  const s = useWorkspace.getState();
  return s.view === "page" ? s.selectedPageId : null;
};

export const useSplit = create<SplitState>((set, get) => {
  /** Opens a pane beside the roomiest one, cutting it along its longer side. */
  const addBeside = (pageId: string) => {
    const { tree, panes } = get();
    let best = 0;
    let area = -1;
    let wide = true;
    rects(tree).forEach((r, id) => {
      // Windows are wider than tall, so weigh width up to match what the eye sees.
      const w = r.w * 1.6;
      if (w * r.h > area) { area = w * r.h; best = id; wide = w >= r.h; }
    });
    set({ layout: "custom", tree: insertLeaf(tree, panes.length + 1, best, wide ? "right" : "bottom"), panes: [...panes, pageId] });
  };

  return {
    ...SINGLE,

    setLayout: (layout) => {
      if (layout === "single") return get().closeAll();
      const { panes } = get();
      const ws = useWorkspace.getState();
      const used = new Set<string>([mainId() ?? "", ...panes]);
      const pool: string[] = [];
      for (const p of [...ws.favorites, ...(ws.children.root ?? [])]) {
        if (used.has(p.id)) continue;
        used.add(p.id);
        pool.push(p.id);
      }
      const want = layout === "tiled" ? Math.max(MIN_TILES, Math.min(MAX_TILES, panes.length + 1)) : paneCount(layout);
      const n = Math.min(want, panes.length + 1 + pool.length);
      if (n < 2) return get().closeAll();
      const next = [...panes, ...pool].slice(0, n - 1);
      const shape: LayoutId = layout === "tiled" || n === want ? layout : n === 2 ? "columns" : "tiled";
      set({ layout: shape === "tiled" && n === 2 ? "columns" : shape, tree: presetTree(shape === "tiled" && n === 2 ? "columns" : shape, n), panes: next });
    },

    place: (pageId, slot) => {
      // The open page already has a pane (the main one); dropping it elsewhere moves nothing.
      if (pageId === mainId()) return;
      if (slot === 0) {
        void useWorkspace.getState().selectPage(pageId);
        return;
      }
      const { panes } = get();
      const from = panes.indexOf(pageId);
      if (slot === undefined) {
        if (from >= 0) return;
        if (panes.length + 1 >= MAX_TILES) set({ panes: [...panes.slice(0, -1), pageId] });
        else addBeside(pageId);
        return;
      }
      if (slot < 1 || slot > panes.length || from === slot - 1) return;
      const next = [...panes];
      // Already shown elsewhere: trade places so nothing is lost.
      if (from >= 0) next[from] = next[slot - 1];
      next[slot - 1] = pageId;
      set({ panes: next });
    },

    dock: (pageId, slot, zone) => {
      if (zone === "center") return get().place(pageId, slot);
      const { tree, panes } = get();
      if (slot < 0 || slot > panes.length) return;
      const main = mainId();
      const from = panes.indexOf(pageId);
      const id = pageId === main ? 0 : from >= 0 ? from + 1 : -1;
      if (id === slot) return;
      if (id >= 0) {
        set({ layout: "custom", tree: moveLeaf(tree, id, slot, zone) });
        return;
      }
      // A new page: past the pane limit it replaces the pane it was dropped on instead.
      if (panes.length + 1 >= MAX_TILES) return get().place(pageId, slot);
      set({ layout: "custom", tree: insertLeaf(tree, panes.length + 1, slot, zone), panes: [...panes, pageId] });
    },

    swap: (a, b) => {
      if (a === b) return;
      const panes = [...get().panes];
      const main = mainId();
      if (a === 0 || b === 0) {
        const other = a === 0 ? b : a;
        const incoming = panes[other - 1];
        if (!incoming) return;
        // The main view changes through navigation; the subscription below hands the old page to the pane.
        if (main) { panes[other - 1] = main; set({ panes }); } else get().closePane(other);
        void useWorkspace.getState().selectPage(incoming);
        return;
      }
      [panes[a - 1], panes[b - 1]] = [panes[b - 1], panes[a - 1]];
      set({ panes });
    },

    closePane: (slot) => {
      const { tree, panes } = get();
      if (slot < 1 || slot > panes.length) return;
      const rest = removeLeaf(tree, slot);
      if (!rest || panes.length === 1) return get().closeAll();
      set({ layout: "custom", tree: relabel(rest, (id) => (id > slot ? id - 1 : id)), panes: panes.filter((_, i) => i !== slot - 1) });
    },

    removePage: (pageId) => {
      const i = get().panes.indexOf(pageId);
      if (i >= 0) get().closePane(i + 1);
    },

    closeAll: () => {
      if (get().layout === "single" && !get().panes.length) return;
      set(SINGLE);
    },

    resizeAt: (path, index, delta) => set({ tree: resizeAt(get().tree, path, index, delta) }),

    evenOut: () => {
      const { layout, tree, panes } = get();
      set({ tree: layout === "custom" || layout === "single" ? evenTree(tree) : presetTree(layout, panes.length + 1) });
    },
  };
});

/**
 * Keeps panes honest while the open page changes. Opening a page that sits in a pane trades places
 * with it, and leaving the workspace clears the split. Returns an uninstall function.
 */
export function installSplit(): () => void {
  let workspace: string | null = null;
  return useWorkspace.subscribe((state, prev) => {
    const id = state.workspace?.id ?? null;
    if (id !== workspace) {
      workspace = id;
      useSplit.getState().closeAll();
      return;
    }
    const next = state.selectedPageId;
    if (!next || next === prev.selectedPageId) return;
    const { panes } = useSplit.getState();
    const at = panes.indexOf(next);
    if (at < 0) return;
    const before = prev.selectedPageId && prev.view === "page" ? prev.selectedPageId : null;
    if (!before) return useSplit.getState().closePane(at + 1);
    const copy = [...panes];
    copy[at] = before;
    useSplit.setState({ panes: copy });
  });
}

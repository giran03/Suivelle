import { create } from "zustand";
import { isInSubtree } from "../../lib/dnd";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";
import { openInNewTab } from "../tabs/tabs";

/** The pages picked in the sidebar with Ctrl+click and Shift+click. The anchor is where a Shift range starts. */
export interface Selection {
  ids: string[];
  anchor: string | null;
}

export const usePageSelection = create<Selection>(() => ({ ids: [], anchor: null }));

export const clearSelection = () => {
  if (usePageSelection.getState().ids.length) usePageSelection.setState({ ids: [], anchor: null });
};

/**
 * What a modified click does to a selection. `order` is the rows on screen, top to bottom, and `base` is the page open
 * right now: it counts as picked when Ctrl+click starts a selection, and is where a Shift range starts when nothing has.
 */
export function clicked(sel: Selection, order: string[], id: string, how: "toggle" | "range", base: string | null): Selection {
  if (how === "toggle") {
    const start = sel.ids.length ? sel.ids : base && base !== id && order.includes(base) ? [base] : [];
    const ids = start.includes(id) ? start.filter((x) => x !== id) : [...start, id];
    return { ids, anchor: id };
  }
  const from = sel.anchor ?? base ?? id;
  const a = order.indexOf(from);
  const b = order.indexOf(id);
  if (a < 0 || b < 0) return { ids: [id], anchor: id };
  return { ids: order.slice(Math.min(a, b), Math.max(a, b) + 1), anchor: from };
}

/** Puts picked ids in the order the rows appear; ids that are not on screen keep their place at the end. */
export function inOrder(ids: string[], order: string[]): string[] {
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...ids].sort((x, y) => rank(x) - rank(y));
}

/** Drops every page that sits inside another picked page: moving or trashing the parent already takes it along. */
export function topLevel(ids: string[], inside: (ancestor: string, id: string) => boolean): string[] {
  return ids.filter((id) => !ids.some((other) => other !== id && inside(other, id)));
}

/** The keys of the rows of one tree, top to bottom. */
const rowKeys = (tree: Element | null): string[] => (tree ? [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')].map((r) => r.dataset.key ?? "") : []);

/** Handles a click on a page row. Ctrl/Cmd toggles, Shift picks a range, Alt opens in a new tab, and a plain click opens here. */
export function clickPage(e: React.MouseEvent<HTMLElement>, id: string): void {
  const how = e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : null;
  if (how) {
    e.preventDefault();
    const order = rowKeys(e.currentTarget.closest('[role="tree"]'));
    usePageSelection.setState((sel) => clicked(sel, order, id, how, useWorkspace.getState().selectedPageId));
    return;
  }
  if (e.altKey) {
    e.preventDefault();
    void openInNewTab(id);
    return;
  }
  clearSelection();
  void useWorkspace.getState().selectPage(id);
}

export function pageById(id: string): Page | undefined {
  const s = useWorkspace.getState();
  for (const list of Object.values(s.children)) {
    const hit = list.find((p) => p.id === id);
    if (hit) return hit;
  }
  return s.favorites.find((p) => p.id === id) ?? (s.selectedPage?.id === id ? s.selectedPage : undefined);
}

/** The picked pages that still exist, in the order of the full page tree. */
export function pickedPages(): Page[] {
  const order = rowKeys(document.querySelector('[role="tree"][aria-label="All pages"]'));
  return inOrder(usePageSelection.getState().ids, order).map(pageById).filter((p): p is Page => !!p);
}

/** The picked pages without those already covered by a picked parent. */
export function pickedRoots(): Page[] {
  const pages = pickedPages();
  const keep = new Set(topLevel(pages.map((p) => p.id), (a, b) => isInSubtree(a, b, pageById)));
  return pages.filter((p) => keep.has(p.id));
}

export const usePicked = (id: string) => usePageSelection((s) => s.ids.includes(id));

let inWorkspace: string | null = null;
useWorkspace.subscribe((s) => {
  const id = s.workspace?.id ?? null;
  if (id !== inWorkspace) {
    inWorkspace = id;
    clearSelection();
  }
});

import "../../lib/legacy";
import type { MouseEvent } from "react";
import { create } from "zustand";
import { useWorkspace } from "../../stores/workspace";

/**
 * Page tabs: a short list of pages kept side by side, like browser tabs. The open page is always
 * the one selected in the workspace store, so tabs only decide which pages stay one click away.
 * With fewer than two pages there is nothing to switch between, so the strip stays hidden.
 */
const KEY = (workspaceId: string) => `suivelle.tabs.${workspaceId}`;
const MAX_TABS = 12;

function read(workspaceId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(workspaceId)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_TABS) : [];
  } catch {
    return [];
  }
}

function write(workspaceId: string | undefined, ids: string[]) {
  if (!workspaceId) return;
  try {
    if (ids.length) localStorage.setItem(KEY(workspaceId), JSON.stringify(ids));
    else localStorage.removeItem(KEY(workspaceId));
  } catch {
    /* Convenience only. */
  }
}

interface TabsState {
  /** Page ids, left to right. Empty (or one) means tabs are not in use. */
  ids: string[];
}

export const useTabs = create<TabsState>(() => ({ ids: [] }));

const workspaceId = () => useWorkspace.getState().workspace?.id;

function commit(ids: string[]) {
  // One tab is just the page you are on: leave tab mode rather than show a lonely tab.
  const next = ids.length >= 2 ? ids : [];
  useTabs.setState({ ids: next });
  write(workspaceId(), next);
}

/** Opens a page in its own tab next to the current one (or switches to it if it already has one). */
export async function openInNewTab(pageId: string): Promise<void> {
  const state = useWorkspace.getState();
  const current = state.selectedPageId;
  let ids = useTabs.getState().ids;
  if (!ids.length && current) ids = [current];
  if (!ids.includes(pageId)) {
    if (ids.length >= MAX_TABS) {
      state.setError(`You can keep up to ${MAX_TABS} tabs open. Close one first.`);
      return;
    }
    const at = current ? ids.indexOf(current) : -1;
    ids = [...ids];
    ids.splice(at >= 0 ? at + 1 : ids.length, 0, pageId);
  }
  commit(ids);
  await state.selectPage(pageId);
}

/** Closes a tab. Closing the open one moves to its neighbour. */
export async function closeTab(id: string): Promise<void> {
  const ids = useTabs.getState().ids;
  const i = ids.indexOf(id);
  if (i < 0) return;
  const rest = ids.filter((x) => x !== id);
  const wasOpen = useWorkspace.getState().selectedPageId === id;
  commit(rest);
  if (wasOpen && rest.length) await useWorkspace.getState().selectPage(rest[Math.min(i, rest.length - 1)]);
}

/** Removes a tab whose page no longer exists, without moving anywhere. */
export function dropTab(id: string): void {
  const ids = useTabs.getState().ids;
  if (ids.includes(id) && useWorkspace.getState().selectedPageId !== id) commit(ids.filter((x) => x !== id));
}

/** Puts a tab at a new position (clamped); the open page does not change. */
export function moveTab(id: string, to: number): void {
  const ids = useTabs.getState().ids;
  const from = ids.indexOf(id);
  if (from < 0) return;
  const target = Math.max(0, Math.min(ids.length - 1, to));
  if (target === from) return;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(target, 0, id);
  commit(next);
}

/** Moves to the next or previous tab, wrapping around. */
export async function cycleTab(dir: 1 | -1): Promise<void> {
  const ids = useTabs.getState().ids;
  if (ids.length < 2) return;
  const at = ids.indexOf(useWorkspace.getState().selectedPageId ?? "");
  const next = ids[(Math.max(at, 0) + dir + ids.length) % ids.length];
  await useWorkspace.getState().selectPage(next);
}

/** Click on a page link outside the sidebar tree: Ctrl/Cmd opens it in a new tab, a plain click opens it here. */
export function openFromClick(e: MouseEvent, id: string): void {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    void openInNewTab(id);
  } else void useWorkspace.getState().selectPage(id);
}

/** Middle click opens in a new tab. */
export function openFromAuxClick(e: MouseEvent, id: string): void {
  if (e.button !== 1) return;
  e.preventDefault();
  void openInNewTab(id);
}

/** Keeps the tab list in step with navigation and restores it per workspace. Returns an uninstall function. */
export function installTabs(): () => void {
  let current: string | null = null;
  return useWorkspace.subscribe((state, prev) => {
    const id = state.workspace?.id ?? null;
    if (id !== current) {
      current = id;
      useTabs.setState({ ids: id ? read(id) : [] });
      return;
    }
    const next = state.selectedPageId;
    if (next === prev.selectedPageId || !next) return;
    const ids = useTabs.getState().ids;
    if (!ids.length || ids.includes(next)) return;
    // Plain navigation inside tab mode changes what the open tab shows.
    const at = prev.selectedPageId ? ids.indexOf(prev.selectedPageId) : -1;
    const updated = [...ids];
    if (at >= 0) updated[at] = next;
    else updated.push(next);
    commit(updated.slice(0, MAX_TABS));
  });
}

import "../../lib/legacy";
import { useWorkspace } from "../../stores/workspace";

/**
 * Convenience memory across launches, kept in localStorage per workspace: which folders were open
 * in the sidebar and where each page was scrolled to. The open page itself is remembered by the
 * workspace store. Everything here fails soft: a blocked or full storage just means a fresh start.
 */
const EXPANDED = (workspaceId: string) => `suivelle.expanded.${workspaceId}`;
const SCROLL = "suivelle.scroll";
const MAX_EXPANDED = 200;
const MAX_SCROLL = 80;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Convenience only. */
  }
}

/** Saves the sidebar's open folders and re-opens them when a workspace finishes loading. */
export function installSessionPersistence(): () => void {
  let restoredFor: string | null = null;
  return useWorkspace.subscribe((state, prev) => {
    const id = state.workspace?.id;
    if (!id) return;
    if (restoredFor !== id) {
      // Wait for the top level to load: switching workspaces clears the tree first.
      if (!state.children.root) return;
      restoredFor = id;
      const saved = readJson<string[]>(EXPANDED(id), []).filter((x) => typeof x === "string");
      const missing = saved.filter((p) => !state.expanded[p]);
      if (missing.length) {
        useWorkspace.setState((s) => ({ expanded: { ...Object.fromEntries(missing.map((p) => [p, true])), ...s.expanded } }));
        void useWorkspace.getState().reloadTree();
      }
      return;
    }
    if (state.expanded !== prev.expanded) {
      const open = Object.keys(state.expanded).filter((k) => state.expanded[k]);
      writeJson(EXPANDED(id), open.slice(-MAX_EXPANDED));
    }
  });
}

export function rememberScroll(pageId: string, top: number) {
  const all = readJson<Record<string, number>>(SCROLL, {});
  delete all[pageId]; // re-insert so the most recent pages survive trimming
  if (top > 24) all[pageId] = Math.round(top);
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SCROLL))) delete all[k];
  writeJson(SCROLL, all);
}

export function recallScroll(pageId: string): number {
  const top = readJson<Record<string, number>>(SCROLL, {})[pageId];
  return typeof top === "number" ? top : 0;
}

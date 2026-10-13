/** Searches kept for reuse from the palette, per workspace, on this device. */
export interface SavedSearch { query: string; titlesOnly: boolean; dayIdx: number }

const KEY = (workspaceId: string) => `suivelle.savedSearches.${workspaceId}`;
const MAX = 12;

export function savedSearches(workspaceId: string): SavedSearch[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY(workspaceId)) ?? "[]");
    return Array.isArray(value) ? value.filter((s): s is SavedSearch => typeof s?.query === "string" && s.query.trim() !== "").slice(0, MAX) : [];
  } catch { return []; }
}

const write = (workspaceId: string, list: SavedSearch[]) => {
  try { localStorage.setItem(KEY(workspaceId), JSON.stringify(list.slice(0, MAX))); } catch { /* Convenience only. */ }
};

/** Adds or refreshes a search, newest first. */
export function saveSearch(workspaceId: string, search: SavedSearch): SavedSearch[] {
  const list = [search, ...savedSearches(workspaceId).filter((s) => s.query !== search.query)];
  write(workspaceId, list);
  return list.slice(0, MAX);
}

export function forgetSearch(workspaceId: string, query: string): SavedSearch[] {
  const list = savedSearches(workspaceId).filter((s) => s.query !== query);
  write(workspaceId, list);
  return list;
}

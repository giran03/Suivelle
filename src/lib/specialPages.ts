import { useWorkspace } from "../stores/workspace";
import type { Page } from "../types";
import { ipc } from "./ipc";

/**
 * A few features keep their pages inside one ordinary page of their own (the Templates page, the
 * Inbox). The workspace remembers which page that is in its settings under `key`, so the user can
 * rename or move it freely. It is created the first time something needs it, and quietly replaced
 * if it was deleted.
 */
function rawSettings(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export async function specialPage(key: string, make: { title: string; icon: string }, create: boolean): Promise<Page | null> {
  const ws = useWorkspace.getState().workspace;
  if (!ws) return null;
  const raw = rawSettings(ws.settingsJson);
  const known = typeof raw[key] === "string" ? (raw[key] as string) : null;
  if (known) {
    try {
      const page = await ipc.pageGet(known);
      if (!page.deletedAt && page.workspaceId === ws.id) return page;
    } catch {
      /* Deleted for good: a new one is made below if asked for. */
    }
  }
  if (!create) return null;
  const page = await ipc.pageCreate(ws.id, null, make.title);
  const withIcon = await ipc.pageUpdate({ id: page.id, icon: make.icon });
  const updated = await ipc.workspaceUpdateSettings(ws.id, JSON.stringify({ ...raw, [key]: page.id }));
  useWorkspace.setState((s) => ({
    workspace: s.workspace?.id === updated.id ? updated : s.workspace,
    workspaces: s.workspaces.map((w) => (w.id === updated.id ? updated : w)),
  }));
  await useWorkspace.getState().reloadTree();
  return withIcon;
}

import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";

/** Daily notes live as pages under one "Journal" page, titled by date so they sort in order. */
export const JOURNAL_TITLE = "Journal";
const HINT = (workspaceId: string) => `suivelle.journal.${workspaceId}`;

/** The day's title, in local time: 2026-10-13. */
export function dailyTitle(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

const usable = (page: Page | null | undefined, workspaceId: string): page is Page =>
  !!page && !page.deletedAt && page.kind === "page" && page.workspaceId === workspaceId;

/** The Journal page: the remembered one, else a top-level page with that title, else a new one. */
async function journal(workspaceId: string): Promise<Page> {
  let hint: string | null = null;
  try { hint = localStorage.getItem(HINT(workspaceId)); } catch { /* Convenience only. */ }
  if (hint) {
    const remembered = await ipc.pageGet(hint).catch(() => null);
    if (usable(remembered, workspaceId)) return remembered;
  }
  const roots = await ipc.pageListChildren(workspaceId, null);
  const page = roots.find((p) => usable(p, workspaceId) && p.title.trim() === JOURNAL_TITLE)
    ?? await ipc.pageCreate(workspaceId, null, JOURNAL_TITLE);
  try { localStorage.setItem(HINT(workspaceId), page.id); } catch { /* Convenience only. */ }
  return page;
}

/** Opens the note for `day` (today by default), creating it and the Journal page as needed. */
export async function openDailyNote(day = new Date()): Promise<void> {
  const state = useWorkspace.getState();
  const workspaceId = state.workspace?.id;
  if (!workspaceId) return;
  const parent = await journal(workspaceId);
  const title = dailyTitle(day);
  const existing = (await ipc.pageListChildren(workspaceId, parent.id)).find((p) => usable(p, workspaceId) && p.title === title);
  const note = existing ?? await ipc.pageCreate(workspaceId, parent.id, title);
  if (useWorkspace.getState().workspace?.id !== workspaceId) return;
  if (!existing) {
    useWorkspace.setState((s) => ({ expanded: { ...s.expanded, [parent.id]: true } }));
    await state.reloadTree();
  }
  await useWorkspace.getState().selectPage(note.id);
}

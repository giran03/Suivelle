import { create } from "zustand";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { flushAllEditors } from "../editor/flushRegistry";
import { pageById, pickedRoots } from "./pageSelection";
import type { Page } from "../../types";

/** The pages that were cut or copied, waiting to be pasted. Kept across workspaces, so pages can be carried to another one. */
interface Held {
  mode: "cut" | "copy";
  pages: Page[];
}

export const usePageClipboard = create<{ held: Held | null; pasting: boolean }>(() => ({ held: null, pasting: false }));

const title = (p: Page) => `“${p.title || "Untitled"}”`;
const what = (pages: Page[]) => (pages.length === 1 ? title(pages[0]) : `${pages.length} pages`);
const fail = (e: unknown) => useWorkspace.getState().setError(toAppError(e).message);

export function cutPages(pages: Page[]): void {
  usePageClipboard.setState({ held: { mode: "cut", pages } });
  useWorkspace.getState().notify(`Cut ${what(pages)}. Paste ${pages.length === 1 ? "it" : "them"} inside another page.`);
}

export function copyPages(pages: Page[]): void {
  usePageClipboard.setState({ held: { mode: "copy", pages } });
  useWorkspace.getState().notify(`Copied ${what(pages)}. Paste ${pages.length === 1 ? "it" : "them"} inside a page or at the top level, including in another workspace.`);
}

/** Whether pasting into `target` could work, judged from what is known here; the backend still checks the rest. */
export function canPasteInto(held: Held | null, target: Page | null): boolean {
  if (!held || !held.pages.length || usePageClipboard.getState().pasting || (target && target.kind !== "page")) return false;
  if (!target) return true;
  return !(held.mode === "cut" && held.pages.some((p) => p.id === target.id));
}

/** Keyboard copy takes the picked roots, or the focused hierarchy row when nothing is picked. */
export function copyHierarchyPages(focusedId?: string): boolean {
  const picked = pickedRoots();
  const focused = focusedId ? pageById(focusedId) : null;
  const pages = picked.length ? picked : focused ? [focused] : [];
  if (!pages.length) return false;
  if (pages.some(p => p.kind !== "page")) {
    useWorkspace.getState().notify("Select ordinary pages to copy. Databases and dashboards cannot be copied yet.");
    return true;
  }
  copyPages(pages);
  return true;
}

/** A focused page receives the paste; tree controls and blank hierarchy space paste at the top level. */
export function pasteHierarchyPages(focusedId?: string): boolean {
  const target = focusedId ? (pageById(focusedId) ?? null) : null;
  if (focusedId && !target || !canPasteInto(usePageClipboard.getState().held, target)) return false;
  void pastePages(target);
  return true;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Copies or moves pages, with the pages inside them, into another workspace (at its top level, or inside `parentId`).
 * A move is a copy followed by deleting the original for good, so it cannot be undone; a page that holds databases or
 * dashboards, which cannot be copied yet, is left where it is rather than deleted with them. Returns whether anything
 * was done. Callers ask the user to confirm a move first.
 */
export async function transferPages(pages: Page[], workspaceId: string, mode: "move" | "copy", parentId: string | null = null): Promise<boolean> {
  const store = useWorkspace.getState();
  const done: { from: Page; copy: string; moved: boolean }[] = [];
  const kept: Page[] = [];
  let inside = 0;
  let skipped = 0;
  try {
    await flushAllEditors(true);
    for (const page of pages) {
      const res = await ipc.pageDuplicate({ id: page.id, parentPageId: parentId, includeChildren: true, targetWorkspaceId: workspaceId });
      inside += res.pages - 1;
      skipped += res.skipped;
      if (mode === "move" && res.skipped > 0) {
        kept.push(page);
        done.push({ from: page, copy: res.page.id, moved: false });
        continue;
      }
      if (mode === "move") {
        // Through the trash (it moves the open page away and keeps the editor's pending edits), then out of it for good.
        if (page.workspaceId === store.workspace?.id) await store.trashPage(page);
        else await ipc.pageDelete(page.id);
        await ipc.pageDeletePermanent(page.id);
      }
      done.push({ from: page, copy: res.page.id, moved: mode === "move" });
    }
  } catch (e) {
    fail(e);
  }
  if (done.length === 0) return false;
  await store.reloadTree();
  const where = store.workspaces.find((w) => w.id === workspaceId)?.name ?? "the other workspace";
  if (useWorkspace.getState().workspace?.id === workspaceId && done.length === 1) await store.selectPage(done[0].copy);
  const extra = inside > 0 ? ` with ${plural(inside, "page", "pages")} inside` : "";
  const moved = done.filter((d) => d.moved);
  const verb = mode === "move" ? "Moved" : "Copied";
  const note = kept.length ? ` ${plural(kept.length, "page was", "pages were")} left in place because ${kept.length === 1 ? "it holds" : "they hold"} databases or dashboards, which cannot be moved yet.` : "";
  const gone = moved.length ? ` The original${moved.length === 1 ? " was" : "s were"} deleted.` : "";
  store.notify(`${verb} ${what(done.map((d) => d.from))}${extra} to “${where}”.${gone}${note}${mode === "copy" && skipped ? ` ${plural(skipped, "database or dashboard", "databases or dashboards")} inside ${skipped === 1 ? "was" : "were"} not copied.` : ""}`);
  return true;
}

/** Pastes what was cut or copied inside `target` (the top level when null). */
export async function pastePages(target: Page | null): Promise<void> {
  const store = useWorkspace.getState();
  const held = usePageClipboard.getState().held;
  const here = store.workspace?.id;
  if (!held || !here || !canPasteInto(held, target)) return;
  usePageClipboard.setState({ pasting: true });
  const parentId = target?.id ?? null;
  const { mode, pages } = held;
  try {
    const foreign = pages.filter((p) => p.workspaceId !== here);
    if (mode === "cut" && foreign.length && !window.confirm(`Move ${what(foreign)} into this workspace? The original${foreign.length === 1 ? "" : "s"} in the other workspace will be deleted for good.`)) return;
    const local = pages.filter((p) => p.workspaceId === here);
    if (foreign.length && await transferPages(foreign, here, mode === "cut" ? "move" : "copy", parentId)) {
      if (useWorkspace.getState().workspace?.id === here && parentId && !useWorkspace.getState().expanded[parentId]) await store.toggleExpanded(parentId);
      if (mode === "cut" && !local.length) usePageClipboard.setState({ held: null });
    }
    if (!local.length) return;
    if (mode === "cut") {
      await movePagesTo(local, parentId, null);
      usePageClipboard.setState({ held: null });
      return;
    }
    await flushAllEditors(true);
    let made = 0;
    let skipped = 0;
    for (const page of local) {
      const res = await ipc.pageDuplicate({ id: page.id, parentPageId: parentId, includeChildren: true });
      made += res.pages;
      skipped += res.skipped;
    }
    await store.reloadTree();
    if (useWorkspace.getState().workspace?.id === here && parentId && !useWorkspace.getState().expanded[parentId]) await store.toggleExpanded(parentId);
    store.notify(`Pasted ${plural(made, "page", "pages")}.${skipped ? ` ${plural(skipped, "database or dashboard", "databases or dashboards")} inside ${skipped === 1 ? "was" : "were"} not copied.` : ""}`);
  } catch (e) {
    fail(e);
  } finally {
    usePageClipboard.setState({ pasting: false });
  }
}

/**
 * Moves pages, in the order given, under `parentId` and before `beforeId` (the end when null). One page uses the normal
 * move, with its own Undo; several move together and Undo puts each back where it was.
 */
export async function movePagesTo(pages: Page[], parentId: string | null, beforeId: string | null): Promise<void> {
  const store = useWorkspace.getState();
  if (pages.length === 1) {
    await store.movePage(pages[0].id, parentId, beforeId);
    return;
  }
  const from = pages.map((p) => {
    const siblings = useWorkspace.getState().children[p.parentPageId ?? "root"] ?? [];
    const at = siblings.findIndex((s) => s.id === p.id);
    return { id: p.id, parent: p.parentPageId, next: at >= 0 ? (siblings[at + 1]?.id ?? null) : null };
  });
  for (const p of pages) await store.movePage(p.id, parentId, beforeId, { silent: true });
  store.notify(`Moved ${pages.length} pages`, async () => {
    // Last first, so a page that was put back before a neighbour finds that neighbour already home.
    for (const f of [...from].reverse()) await useWorkspace.getState().movePage(f.id, f.parent, f.next, { silent: true });
  });
}

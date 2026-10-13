import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";
import { openInNewTab } from "../tabs/tabs";
import { clearSelection } from "./pageSelection";

const MAX_TABS = 12;

/** Actions on several picked pages at once. Each acts on the pages as given; the caller passes the top-level ones. */

export async function trashPages(pages: Page[]): Promise<void> {
  const store = useWorkspace.getState();
  if (pages.length === 1) return store.trashPage(pages[0]);
  for (const p of pages) await useWorkspace.getState().trashPage(p);
  clearSelection();
  store.notify(`Moved ${pages.length} pages to trash`, async () => {
    for (const p of pages) await useWorkspace.getState().restorePage(p.id);
  });
}

/** Adds all of them to favorites, or removes all of them when every one already is a favorite. */
export async function favoritePages(pages: Page[]): Promise<void> {
  const store = useWorkspace.getState();
  const wantOn = !pages.every((p) => p.favorite);
  for (const p of pages.filter((p) => p.favorite !== wantOn)) await store.toggleFavorite(p);
}

export async function duplicatePages(pages: Page[]): Promise<void> {
  const store = useWorkspace.getState();
  try {
    let made = 0;
    for (const p of pages) made += (await ipc.pageDuplicate({ id: p.id, beside: true, includeChildren: true })).pages;
    await store.reloadTree();
    store.notify(`Duplicated ${pages.length} pages${made > pages.length ? ` and ${made - pages.length} inside them` : ""}.`);
  } catch (e) {
    store.setError(toAppError(e).message);
  }
}

export async function openInTabs(pages: Page[]): Promise<void> {
  for (const p of pages.slice(0, MAX_TABS)) await openInNewTab(p.id);
  if (pages.length > MAX_TABS) useWorkspace.getState().notify(`Opened the first ${MAX_TABS} pages in tabs.`);
}

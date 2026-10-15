import { ipc, toAppError } from "../../lib/ipc";
import { specialPage } from "../../lib/specialPages";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";
import { flushAllEditors } from "../editor/flushRegistry";
import type { Editor } from "@tiptap/core";

/**
 * Page templates are ordinary pages kept inside one "Templates" page (see `specialPage`), which is
 * created the first time something is saved as a template.
 */
const fail = (e: unknown) => useWorkspace.getState().setError(toAppError(e).message);

/** The templates page, or null when it does not exist (and `create` is off). */
export const templatesContainer = (create: boolean): Promise<Page | null> =>
  specialPage("templatesPageId", { title: "Templates", icon: "icon:layers" }, create);

/** The user's page templates, in the order they were arranged. */
export async function listPageTemplates(): Promise<Page[]> {
  const ws = useWorkspace.getState().workspace;
  if (!ws) return [];
  const container = await templatesContainer(false);
  if (!container) return [];
  return (await ipc.pageListChildren(ws.id, container.id)).filter((p) => p.kind === "page");
}

/** Copies a page beside itself and opens the copy. */
export async function duplicatePage(page: Page): Promise<void> {
  const store = useWorkspace.getState();
  try {
    const res = await ipc.pageDuplicate({ id: page.id, beside: true, includeChildren: true });
    await store.reloadTree();
    await store.selectPage(res.page.id);
    const extra = res.pages > 1 ? ` and ${res.pages - 1} ${res.pages === 2 ? "page" : "pages"} inside it` : "";
    const left = res.skipped ? ` ${res.skipped} database or dashboard inside was not copied.` : "";
    store.notify(`Duplicated “${page.title || "Untitled"}”${extra}.${left}`);
  } catch (e) {
    fail(e);
  }
}

/** Saves a copy of a page into the templates page. The original is left as it is. */
export async function saveAsTemplate(page: Page): Promise<void> {
  const store = useWorkspace.getState();
  try {
    const container = await templatesContainer(true);
    if (!container) return;
    if (page.id === container.id) {
      store.setError("The Templates page cannot be saved as a template.");
      return;
    }
    await ipc.pageDuplicate({ id: page.id, parentPageId: container.id, includeChildren: true });
    await store.reloadTree();
    store.notify(`Saved “${page.title || "Untitled"}” as a template. Use it from New from template.`);
  } catch (e) {
    fail(e);
  }
}

/** Creates a new page from a template, at the top level or inside `parentId`, and opens it. */
export async function createFromPageTemplate(templateId: string, parentId: string | null = null): Promise<string | null> {
  const store = useWorkspace.getState();
  try {
    const res = await ipc.pageDuplicate({ id: templateId, parentPageId: parentId, includeChildren: true });
    if (parentId) useWorkspace.setState((s) => ({ expanded: { ...s.expanded, [parentId]: true } }));
    await store.reloadTree();
    await store.selectPage(res.page.id);
    return null;
  } catch (e) {
    return toAppError(e).message;
  }
}

export async function applyPageTemplate(templateId: string, pageId: string, workspaceId: string, editor: Editor | null = null): Promise<string | null> {
  try {
    await flushAllEditors(true);
    if (useWorkspace.getState().workspace?.id !== workspaceId) throw new Error("The workspace changed. Open the template picker again.");
    await ipc.pageApplyTemplate(templateId, pageId);
    window.dispatchEvent(new CustomEvent("page-template-applied", { detail: { pageId, focusEditor: editor } }));
    try { await useWorkspace.getState().reloadTree(); }
    catch { useWorkspace.getState().notify("Template applied. Reopen the sidebar to refresh its pages."); }
    return null;
  } catch (e) { return toAppError(e).message; }
}

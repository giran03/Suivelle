import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ipc, toAppError } from "../../lib/ipc";
import { specialPage } from "../../lib/specialPages";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";
import { blocksToDoc, docToBlocks, rowFromBlock } from "./convert";

/**
 * A synced block is one set of blocks shown in many places. Its content lives in an ordinary page
 * (inside a "Synced blocks" page), and each place that shows it holds a small block pointing at that
 * page, so editing it anywhere edits the one copy.
 */
export const syncedContainer = (create: boolean): Promise<Page | null> => specialPage("syncedPageId", { title: "Synced blocks", icon: "icon:duplicate" }, create);

/** The pages that hold synced content, in the order they were arranged. */
export async function listSyncedPages(): Promise<Page[]> {
  const ws = useWorkspace.getState().workspace;
  const container = await syncedContainer(false);
  if (!ws || !container) return [];
  return (await ipc.pageListChildren(ws.id, container.id)).filter((p) => p.kind === "page");
}

/** A new page of synced content, optionally starting with blocks. */
export async function createSyncedPage(title: string, content?: JSONContent[]): Promise<Page> {
  const ws = useWorkspace.getState().workspace;
  const container = await syncedContainer(true);
  if (!ws || !container) throw new Error("The workspace is not ready yet.");
  const page = await ipc.pageCreate(ws.id, container.id, title);
  if (content?.length) {
    const rows = docToBlocks({ type: "doc", content });
    await ipc.blockApplyBatch({ pageId: page.id, upserts: rows, deleteIds: [] });
  }
  await useWorkspace.getState().reloadTree();
  return page;
}

/** A copy of a node tree without block ids, so it can be saved as new rows on another page. */
export function withoutIds(node: JSONContent): JSONContent {
  const { attrs, content, ...rest } = node;
  const clean = attrs ? Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== "blockId")) : undefined;
  return { ...rest, ...(clean && Object.keys(clean).length ? { attrs: clean } : {}), ...(content ? { content: content.map(withoutIds) } : {}) };
}

/** Blocks that make sense to turn into a synced block (a list item is only part of a list). */
const SYNCABLE_NOT = new Set(["listItem", "taskItem", "column", "syncedBlock", "databaseView", "tableOfContents"]);

function contains(node: PMNode, type: string): boolean {
  let found = false;
  node.descendants((n) => {
    if (n.type.name === type) found = true;
    return !found;
  });
  return found;
}

export function canSync(editor: Editor, node: PMNode): boolean {
  return !!editor.schema.nodes.syncedBlock && !SYNCABLE_NOT.has(node.type.name) && !contains(node, "syncedBlock");
}

const titleFor = (node: PMNode) => node.textContent.trim().slice(0, 40) || "Synced block";

/** Moves a block's content into its own synced page and leaves a synced block in its place. */
export async function syncBlock(editor: Editor, pos: number, node: PMNode): Promise<void> {
  if (!canSync(editor, node)) return;
  try {
    const page = await createSyncedPage(titleFor(node), [withoutIds(node.toJSON())]);
    if (editor.isDestroyed) return;
    // The document may have shifted while the page was being made; find the block again by identity.
    let at = -1;
    editor.state.doc.descendants((n, p) => {
      if (at < 0 && n === node) at = p;
      return at < 0;
    });
    const from = at >= 0 ? at : pos;
    editor.chain().focus().insertContentAt({ from, to: from + node.nodeSize }, { type: "syncedBlock", attrs: { pageId: page.id } }).run();
  } catch (e) {
    useWorkspace.getState().setError(toAppError(e).message);
  }
}

/** Replaces a synced block with its content as ordinary blocks of this page (the synced page is kept). */
export async function unsyncBlock(editor: Editor, getPos: () => number | undefined, node: PMNode, pageId: string): Promise<void> {
  try {
    const rows = (await ipc.blockList(pageId)).map(rowFromBlock);
    const nodes = (blocksToDoc(rows).content ?? []).map(withoutIds);
    const pos = getPos();
    if (pos === undefined || editor.isDestroyed) return;
    editor.chain().focus().insertContentAt({ from: pos, to: pos + node.nodeSize }, nodes).run();
  } catch (e) {
    useWorkspace.getState().setError(toAppError(e).message);
  }
}

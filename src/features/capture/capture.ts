import type { JSONContent } from "@tiptap/core";
import { newId } from "../../lib/ids";
import { ipc, toAppError } from "../../lib/ipc";
import { specialPage } from "../../lib/specialPages";
import { useActiveEditor } from "../../stores/activeEditor";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";

export interface CaptureItem {
  text: string;
  todo: boolean;
}

/**
 * Lines of typed text become blocks. Empty lines are dropped, "- " or "* " list markers are
 * removed, and "[ ] " (or "- [ ] ") makes a line a to-do on its own. With `todo`, every line is one.
 */
export function parseCapture(text: string, todo: boolean): CaptureItem[] {
  const items: CaptureItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let isTodo = todo;
    line = line.replace(/^[-*](\s+|$)/, "");
    const box = /^\[( |x|X)?\](\s+|$)/.exec(line);
    if (box) {
      isTodo = true;
      line = line.slice(box[0].length);
    }
    line = line.trim();
    if (line) items.push({ text: line, todo: isTodo });
  }
  return items;
}

const run = (text: string): JSONContent[] => [{ type: "text", text }];

/** Editor content for the items: runs of to-dos share one list. */
export function toEditorNodes(items: CaptureItem[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const item of items) {
    if (!item.todo) {
      out.push({ type: "paragraph", content: run(item.text) });
      continue;
    }
    const entry: JSONContent = { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: run(item.text) }] };
    const last = out[out.length - 1];
    if (last?.type === "taskList") last.content!.push(entry);
    else out.push({ type: "taskList", content: [entry] });
  }
  return out;
}

/** The Inbox page, created on first use. */
export const inboxPage = (create: boolean): Promise<Page | null> => specialPage("inboxPageId", { title: "Inbox", icon: "icon:note" }, create);

export interface Captured {
  page: Page;
  count: number;
  undo: () => Promise<void>;
}

/**
 * Adds the text to the end of a page. If that page is open in the editor the blocks go in through
 * the editor (so what is on screen stays the truth); otherwise they are written straight to the page.
 */
export async function appendToPage(page: Page, items: CaptureItem[]): Promise<Captured> {
  const editor = useActiveEditor.getState().editor;
  if (editor && !editor.isDestroyed && editor.isEditable && useWorkspace.getState().selectedPageId === page.id) {
    editor.chain().insertContentAt(editor.state.doc.content.size, toEditorNodes(items)).run();
    return { page, count: items.length, undo: async () => void editor.commands.undo() };
  }
  const existing = await ipc.blockList(page.id);
  const last = existing.reduce((m, b) => Math.max(m, b.position), 0);
  const rows = items.map((item, i) => ({
    id: newId(),
    parentBlockId: null as string | null,
    type: (item.todo ? "todo" : "paragraph") as "todo" | "paragraph",
    position: last + 1 + i,
    dataJson: JSON.stringify(item.todo ? { content: run(item.text), checked: false } : { content: run(item.text) }),
    schemaVersion: 2,
  }));
  await ipc.blockApplyBatch({ pageId: page.id, upserts: rows, deleteIds: [] });
  return {
    page,
    count: items.length,
    undo: async () => ipc.blockApplyBatch({ pageId: page.id, upserts: [], deleteIds: rows.map((r) => r.id) }),
  };
}

/** Saves a capture to the Inbox, or to the open page, and says what happened. Resolves to an error message or null. */
export async function capture(text: string, opts: { todo: boolean; target: "inbox" | "page" }): Promise<string | null> {
  const items = parseCapture(text, opts.todo);
  if (!items.length) return "Type something to capture.";
  const store = useWorkspace.getState();
  try {
    let page: Page | null;
    if (opts.target === "page") {
      page = store.selectedPage;
      if (!page || page.kind !== "page" || store.view !== "page") return "Open a page first, or send this to the Inbox.";
    } else page = await inboxPage(true);
    if (!page) return "The workspace is not ready yet.";
    const done = await appendToPage(page, items);
    const where = opts.target === "page" ? `“${page.title || "Untitled"}”` : "the Inbox";
    store.notify(`Added ${done.count} ${done.count === 1 ? "item" : "items"} to ${where}`, done.undo);
    return null;
  } catch (e) {
    return toAppError(e).message;
  }
}

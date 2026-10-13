import type { Editor, JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { addColumnAfter, addRowAfter, isInTable, selectedRect, TableMap } from "@tiptap/pm/tables";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ID_TYPES } from "./extensions/blockId";

const LIST_ITEMS = new Set(["listItem", "taskItem"]);

/** Insert beside the active cell and move the caret into the new row or column. */
export function insertTableAfter(editor: Editor, axis: "row" | "column"): boolean {
  if (!editor.isEditable || !isInTable(editor.state)) return false;
  const rect = selectedRect(editor.state);
  const row = axis === "row" ? rect.bottom : rect.top;
  const col = axis === "column" ? rect.right : rect.left;
  const command = axis === "row" ? addRowAfter : addColumnAfter;
  return command(editor.state, (tr) => {
    const table = tr.doc.nodeAt(rect.tableStart - 1)!;
    const map = TableMap.get(table);
    const cell = map.map[row * map.width + col];
    tr.setSelection(TextSelection.near(tr.doc.resolve(rect.tableStart + cell + 1)));
    tr.setStoredMarks([]);
    editor.view.dispatch(closeHistory(tr).scrollIntoView());
  });
}

export function insertRowOrBlockAbove(editor: Editor): boolean {
  return isInTable(editor.state) ? insertTableAfter(editor, "row") : insertBlockAbove(editor);
}

export interface BlockRef {
  node: PMNode;
  /** Position just before the node. */
  pos: number;
  depth: number;
}

/** The nearest block (an own-row node) around the selection. */
export function currentBlock(editor: Editor): BlockRef | null {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection && ID_TYPES.includes(selection.node.type.name)) {
    return { node: selection.node, pos: selection.from, depth: selection.$from.depth + 1 };
  }
  const $from = selection.$from;
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (!ID_TYPES.includes(node.type.name)) continue;
    // The first paragraph of a list item is the item's own text; the item is the block.
    if (node.type.name === "paragraph" && LIST_ITEMS.has($from.node(d - 1).type.name) && $from.index(d - 1) === 0) continue;
    return { node, pos: $from.before(d), depth: d };
  }
  return null;
}

/** Insert plain text above the block, outside containers that cannot hold a paragraph (lists). */
export function insertBlockAbove(editor: Editor): boolean {
  if (!editor.isEditable) return false;
  const block = currentBlock(editor);
  if (!block) return false;
  const { state } = editor;
  const paragraph = state.schema.nodes.paragraph;
  let pos = block.pos;
  let $pos = state.doc.resolve(pos);
  while (!$pos.parent.canReplaceWith($pos.index(), $pos.index(), paragraph)) {
    if ($pos.depth === 0) return false;
    pos = $pos.before();
    $pos = state.doc.resolve(pos);
  }
  const tr = closeHistory(state.tr).insert(pos, paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, pos + 1)).setStoredMarks([]);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Lifts the block around the caret out of any lists, one level at a time. Nested children stay
 * with the item (they follow it as a sub-list), unlike `clearNodes`, which cannot unwrap those.
 */
export function unwrapLists(editor: Editor): void {
  for (let i = 0; i < 16; i++) {
    const b = currentBlock(editor);
    if (!b || !LIST_ITEMS.has(b.node.type.name)) return;
    if (!editor.chain().focus().liftListItem(b.node.type.name).run()) return;
  }
}

/** Puts the caret inside (or selects) the block starting at `pos`. */
export function selectBlockAt(editor: Editor, pos: number): void {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const sel = node.isAtom ? NodeSelection.create(editor.state.doc, pos) : TextSelection.near(editor.state.doc.resolve(pos + 1));
  editor.view.dispatch(editor.state.tr.setSelection(sel));
  editor.view.focus();
}

/**
 * Replaces the current empty paragraph with `node` (or inserts after a non-empty block) and keeps a
 * paragraph after it so the caret always has somewhere to go.
 */
export function replaceBlock(editor: Editor, node: JSONContent, opts: { select?: boolean } = {}): void {
  unwrapLists(editor);
  const b = currentBlock(editor);
  if (!b) return;
  const empty = b.node.type.name === "paragraph" && b.node.content.size === 0;
  const from = empty ? b.pos : b.pos + b.node.nodeSize;
  const to = empty ? b.pos + b.node.nodeSize : from;
  const chain = editor.chain().focus().insertContentAt({ from, to }, [node, { type: "paragraph" }]);
  if (opts.select) chain.setNodeSelection(from);
  chain.run();
}

/** Swaps the block with its previous/next sibling (list items stay within their list). */
export function moveBlock(editor: Editor, dir: -1 | 1): boolean {
  const b = currentBlock(editor);
  if (!b) return false;
  const { state } = editor;
  const $pos = state.doc.resolve(b.pos);
  const parent = $pos.parent;
  const index = $pos.index();
  const sibIndex = index + dir;
  if (sibIndex < 0 || sibIndex >= parent.childCount) return false;
  const sibling = parent.child(sibIndex);
  const caretOffset = state.selection.from - b.pos;
  const tr = state.tr;
  let newStart: number;
  if (dir < 0) {
    newStart = b.pos - sibling.nodeSize;
    tr.replaceWith(newStart, b.pos + b.node.nodeSize, [b.node, sibling]);
  } else {
    newStart = b.pos + sibling.nodeSize;
    tr.replaceWith(b.pos, b.pos + b.node.nodeSize + sibling.nodeSize, [sibling, b.node]);
  }
  const target = Math.min(newStart + Math.max(1, caretOffset), tr.doc.content.size);
  tr.setSelection(b.node.isAtom ? NodeSelection.create(tr.doc, newStart) : TextSelection.near(tr.doc.resolve(target)));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function duplicateBlock(editor: Editor): boolean {
  const b = currentBlock(editor);
  if (!b) return false;
  // Copied ids are replaced with fresh ones by the BlockId plugin.
  editor.view.dispatch(editor.state.tr.insert(b.pos + b.node.nodeSize, b.node));
  return true;
}

export function deleteBlock(editor: Editor): boolean {
  const b = currentBlock(editor);
  if (!b) return false;
  editor.view.dispatch(editor.state.tr.delete(b.pos, b.pos + b.node.nodeSize).scrollIntoView());
  editor.view.focus();
  return true;
}

/**
 * Deletes the block at `pos` without leaving a container that needs content empty (a column, callout or toggle
 * cannot be empty, so a plain delete there is rejected and nothing happens). A lone block is cleared instead; a
 * lone empty paragraph removes the container around it, and a column removes the whole columns block.
 */
export function deleteBlockAt(editor: Editor, pos: number): boolean {
  const { doc, schema } = editor.state;
  const node = doc.nodeAt(pos);
  if (!node) return false;
  const $p = doc.resolve(pos);
  const tr = editor.state.tr;
  const isEmptyParagraph = node.type.name === "paragraph" && node.content.size === 0;
  if ($p.depth > 0 && $p.parent.childCount === 1) {
    if (!isEmptyParagraph && schema.nodes.paragraph) {
      tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.paragraph.create());
    } else {
      let d = $p.depth;
      while (d > 1 && $p.node(d - 1).childCount === 1) d--;
      if ($p.node(d).type.name === "column") d--;
      tr.delete($p.before(d), $p.after(d));
    }
  } else {
    tr.delete(pos, pos + node.nodeSize);
  }
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** The columns block around `pos`, if any. */
export function enclosingColumns(editor: Editor, pos: number): { pos: number; size: number } | null {
  const $p = editor.state.doc.resolve(Math.min(pos + 1, editor.state.doc.content.size));
  for (let d = $p.depth; d >= 1; d--) if ($p.node(d).type.name === "columns") return { pos: $p.before(d), size: $p.node(d).nodeSize };
  return null;
}

/** Select the whole block around the caret (first Esc press). */
export function selectEnclosingBlock(editor: Editor): boolean {
  const b = currentBlock(editor);
  if (!b || editor.state.selection instanceof NodeSelection) return false;
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, b.pos)));
  return true;
}

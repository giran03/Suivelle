import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { copyText, editingItems } from "../../components/editingMenu";
import { blockItems } from "./BlockHandle";
import { currentBlock, selectBlockAt } from "./commands";
import { editorDom } from "./editorDom";
import { MEDIA_KINDS } from "./extensions/media";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { copyPlainText, pastePlainText } from "./plainText";
import { imageItems } from "./imageActions";
import { BlockRangeSelection, blockRange } from "./blockSelection";
import { selectedBlockItems } from "./blockSelectionActions";

export function EditorContextMenu({ editor }: { editor: Editor }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  useEffect(() => {
    const open = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      const point = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      const imagePos = (event as MouseEvent & { imageBlockPos?: number }).imageBlockPos;
      const selection = editor.state.selection;
      if (selection instanceof BlockRangeSelection) {
        const target = event.target instanceof Element ? event.target : null;
        const inside = blockRange(editor.state.doc, selection.from, selection.to).some(({ pos }) => {
          const dom = editor.view.nodeDOM(pos);
          return dom instanceof Element && !!target && dom.contains(target);
        });
        if (inside || (point && point.pos >= selection.from && point.pos < selection.to)) {
          setMenu({ x: event.clientX, y: event.clientY, items: selectedBlockItems(editor) });
          return;
        }
      }
      if (typeof imagePos === "number") selectBlockAt(editor,imagePos);
      else if (point && (point.pos < selection.from || point.pos > selection.to || selection.empty)) {
        const node = editor.state.doc.nodeAt(point.pos);
        if (node?.isAtom) selectBlockAt(editor, point.pos);
        else editor.commands.setTextSelection(point.pos);
      }
      const block = currentBlock(editor);
      const imageActions = block ? imageItems(editor, block.pos, block.node) : [];
      const bookmark = editor.state.selection.getBookmark();
      const restore = () => { editor.view.dispatch(editor.state.tr.setSelection(bookmark.resolve(editor.state.doc))); editor.view.focus(); };
      const items = editingItems(editor.view.dom, {
        undo: () => { restore(); editor.commands.undo(); },
        redo: () => { restore(); editor.commands.redo(); },
        paste: (text) => { restore(); editor.view.pasteText(text); },
        selectAll: () => { editor.chain().focus().selectAll().run(); },
      });
      // ProseMirror's selection is authoritative even before the DOM selection catches up.
      const selectedText = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n");
      const copy = items.find((item) => item.label === "Copy");
      if (copy) { copy.disabled = !selectedText; copy.onSelect = () => { restore(); if (!document.execCommand("copy")) void copyText(selectedText); }; }
      const cut = items.find((item) => item.label === "Cut");
      if (cut) { cut.disabled = !selectedText; cut.onSelect = () => { restore(); if (!document.execCommand("cut")) useWorkspace.getState().setError("Could not cut to the clipboard. Use Ctrl+X (or Command+X)."); }; }
      const copyAt = items.findIndex((item) => item.label === "Copy");
      if (copyAt >= 0) items.splice(copyAt + 1, 0, { label: "Copy as plain text", shortcut: "copy-plain", disabled: !selectedText, onSelect: () => { restore(); copyPlainText(editor); } });
      const pasteAt = items.findIndex((item) => item.label === "Paste text");
      if (pasteAt >= 0) items.splice(pasteAt + 1, 0, { label: "Paste as plain text", shortcut: "paste-plain", onSelect: () => { restore(); pastePlainText(editor); } });
      if (editor.isEditable) {
        const undo = items.find((item) => item.label === "Undo"); if (undo) undo.disabled = !editor.can().undo();
        const redo = items.find((item) => item.label === "Redo"); if (redo) redo.disabled = !editor.can().redo();
      }
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest<HTMLAnchorElement>("a[href]");
      if (link) {
        items.push({ label: "Copy link address", separated: true, onSelect: () => void copyText(link.href) });
        if (editor.isEditable) items.push({ label: "Remove link", onSelect: () => { restore(); editor.chain().focus().extendMarkRange("link").unsetLink().run(); } });
      }
      if (block && editor.isEditable && block.node.type.name !== "file" && MEDIA_KINDS.some((kind) => kind === block.node.type.name) && block.node.attrs.attachmentId) {
        const shown = block.node.attrs.showName === true;
        items.push({ label: shown ? "Hide name (show as tooltip)" : "Show name below", separated: true, onSelect: () => { editor.view.dispatch(editor.state.tr.setNodeAttribute(block.pos, "showName", !shown)); } });
      }
      if (block && MEDIA_KINDS.some((kind) => kind === block.node.type.name) && block.node.attrs.attachmentId) {
        items.push({ label: "Save a copy…", separated: block.node.type.name === "file", onSelect: () => void ipc.attachmentSaveAs(block.node.attrs.attachmentId as string).catch((error) => useWorkspace.getState().setError(toAppError(error).message)) });
      }
      if (block && editor.isEditable) {
        const actions = blockItems(editor, block); actions[0].separated = true;
        items.push(...actions);
      }
      items.push(...imageActions);
      setMenu({ x: event.clientX, y: event.clientY, items });
    };
    // TipTap throws when the view is read before it mounts; attach once it exists.
    let dom: HTMLElement | null = null;
    const attach = () => {
      dom = editorDom(editor);
      dom?.addEventListener("contextmenu", open);
    };
    attach();
    if (!dom) editor.on("create", attach);
    return () => {
      editor.off("create", attach);
      dom?.removeEventListener("contextmenu", open);
    };
  }, [editor]);
  return menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />;
}

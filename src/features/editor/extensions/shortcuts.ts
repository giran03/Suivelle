import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { registerScope } from "../../shortcuts/runtime";
import { duplicateBlock, insertRowOrBlockAbove, insertTableAfter, moveBlock } from "../commands";
import { BlockRangeSelection } from "../blockSelection";
import { duplicateSelectedBlocks, moveSelectedBlocks } from "../blockSelectionActions";
import { copyPlainText, pastePlainText } from "../plainText";
import { READ_ONLY } from "../../../lib/access";

/** Register every editor (including nested synced blocks) without rebuilding its state. */
export const RebindableShortcuts = Extension.create({
  name: "rebindableShortcuts",
  addProseMirrorPlugins() {
    const editor = this.editor;
    const run = (action: () => boolean) => () => !READ_ONLY && editor.isEditable ? action() : false;
    return [new Plugin({ view: view => {
      const stop = registerScope(view.dom, "editor", {
        bold: run(() => editor.commands.toggleBold()), italic: run(() => editor.commands.toggleItalic()),
        underline: run(() => editor.commands.toggleUnderline()), strike: run(() => editor.commands.toggleStrike()),
        "inline-code": run(() => editor.commands.toggleCode()), undo: run(() => editor.commands.undo()), redo: run(() => editor.commands.redo()),
        "copy-plain": () => copyPlainText(editor), "paste-plain": run(() => pastePlainText(editor)),
        "insert-above": run(() => insertRowOrBlockAbove(editor)),
        "table-column-right": run(() => insertTableAfter(editor, "column")),
        "duplicate-block": run(() => editor.state.selection instanceof BlockRangeSelection ? duplicateSelectedBlocks(editor) : duplicateBlock(editor)),
        "move-block-up": run(() => editor.state.selection instanceof BlockRangeSelection ? moveSelectedBlocks(editor, -1) : moveBlock(editor, -1)),
        "move-block-down": run(() => editor.state.selection instanceof BlockRangeSelection ? moveSelectedBlocks(editor, 1) : moveBlock(editor, 1)),
        "heading-1": run(() => editor.commands.toggleHeading({ level: 1 })),
        "heading-2": run(() => editor.commands.toggleHeading({ level: 2 })),
        "heading-3": run(() => editor.commands.toggleHeading({ level: 3 })),
        "task-list": run(() => editor.commands.toggleTaskList()), "code-block": run(() => editor.commands.toggleCodeBlock()),
        paragraph: run(() => editor.commands.setParagraph()),
        "bullet-list": run(() => editor.commands.toggleBulletList()), "ordered-list": run(() => editor.commands.toggleOrderedList()),
      });
      return { destroy: stop };
    } })];
  },
});

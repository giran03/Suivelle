import { Extension } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { duplicateBlock, insertRowOrBlockAbove, insertTableAfter, moveBlock, selectEnclosingBlock } from "../commands";
import { BlockRangeSelection } from "../blockSelection";
import { duplicateSelectedBlocks, moveSelectedBlocks } from "../blockSelectionActions";

const RESETTABLE = new Set(["heading", "quote", "callout", "codeBlock"]);

/** Keyboard behaviour that belongs to the block model rather than to any single node. */
export const Behaviors = Extension.create({
  name: "behaviors",

  addKeyboardShortcuts() {
    return {
      // Backspace at the start of a heading, quote, callout or code block turns it back into text.
      Backspace: ({ editor }) => {
        const { selection, schema } = editor.state;
        if (!(selection instanceof TextSelection) || !selection.empty || selection.$from.parentOffset !== 0) return false;
        const parent = selection.$from.parent;
        if (!RESETTABLE.has(parent.type.name)) return false;
        const pos = selection.$from.before();
        const tr = editor.state.tr.setNodeMarkup(pos, schema.nodes.paragraph, { blockId: parent.attrs.blockId });
        editor.view.dispatch(tr);
        return true;
      },
      "Alt-Shift-ArrowUp": ({ editor }) => editor.state.selection instanceof BlockRangeSelection ? moveSelectedBlocks(editor, -1) : moveBlock(editor, -1),
      "Alt-Shift-ArrowDown": ({ editor }) => editor.state.selection instanceof BlockRangeSelection ? moveSelectedBlocks(editor, 1) : moveBlock(editor, 1),
      "Mod-Shift-d": ({ editor }) => editor.state.selection instanceof BlockRangeSelection ? duplicateSelectedBlocks(editor) : duplicateBlock(editor),
      // First Esc selects the whole block so it can be moved, copied or deleted as a unit.
      Escape: ({ editor }) => selectEnclosingBlock(editor),
    };
  },
});

/** Precedes node-specific Mod-Enter handlers, including exiting a code block. */
export const InsertBlockAbove = Extension.create({
  name: "insertBlockAbove",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": ({ editor }) => insertRowOrBlockAbove(editor),
      "Mod-Shift-Enter": ({ editor }) => insertTableAfter(editor, "column"),
    };
  },
});

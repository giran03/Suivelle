import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from "@tiptap/pm/transform";
import { newId } from "../../../lib/ids";

/** Node types that are persisted as their own `block` row and therefore carry a stable id. */
export const ID_TYPES = [
  "paragraph",
  "heading",
  "listItem",
  "taskItem",
  "details",
  "quote",
  "callout",
  "horizontalRule",
  "codeBlock",
  "equation",
  "table",
  "tabs",
  "tabPanel",
  "columns",
  "column",
  "databaseView",
  "tableOfContents",
  "syncedBlock",
  "image",
  "audio",
  "video",
  "file",
  "pdf",
  "embed",
];

const LIST_ITEMS = new Set(["listItem", "taskItem"]);

/**
 * Gives every block a stable id and makes sure ids stay unique (split, paste and duplicate
 * all copy attributes). The first occurrence keeps its id; later copies get a fresh one.
 */
export const BlockId = Extension.create({
  name: "blockId",

  addGlobalAttributes() {
    return [
      {
        types: ID_TYPES,
        attributes: { blockId: { default: null, rendered: false, keepOnSplit: false } },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("blockId"),
        appendTransaction: (transactions, _old, state) => {
          if (!transactions.some((t) => t.docChanged)) return null;
          // Typing inside an identified text block cannot introduce or duplicate block ids.
          // Structural edits (split, paste, move, undo) still take the normalization path.
          const onlyText = transactions.every((t) => t.steps.every((step, i) => {
            if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return true;
            if (!(step instanceof ReplaceStep)) return false;
            const from = t.docs[i].resolve(step.from);
            const to = t.docs[i].resolve(step.to);
            if (!from.sameParent(to) || !from.parent.isTextblock || !from.parent.attrs.blockId) return false;
            let text = true;
            step.slice.content.forEach((node) => { if (!node.isText) text = false; });
            return text;
          }));
          if (onlyText) return null;
          const seen = new Set<string>();
          const tr = state.tr;
          let changed = false;
          state.doc.descendants((node, pos, parent, index) => {
            if (!ID_TYPES.includes(node.type.name)) return true;
            // The first paragraph of a list item is part of the item's own row.
            const isItemText = node.type.name === "paragraph" && parent && LIST_ITEMS.has(parent.type.name) && index === 0;
            if (!isItemText) {
              const id = node.attrs.blockId as string | null;
              if (!id || seen.has(id)) {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: newId() });
                changed = true;
              } else {
                seen.add(id);
              }
            }
            // Table cells are stored inside the table block; do not descend.
            return node.type.name !== "table";
          });
          return changed ? tr : null;
        },
      }),
    ];
  },
});

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** Plugin key; dispatch `tr.setMeta(blockFlashKey, blockId | null)` to highlight (or clear) one block. */
export const blockFlashKey = new PluginKey<string | null>("blockFlash");

/**
 * Highlights one block with a decoration. A class added straight to the DOM would be wiped the
 * next time ProseMirror redraws the node, so the highlight lives in editor state instead.
 */
export const BlockFlash = Extension.create({
  name: "blockFlash",

  addProseMirrorPlugins() {
    return [
      new Plugin<string | null>({
        key: blockFlashKey,
        state: {
          init: () => null,
          apply: (tr, value) => {
            const meta = tr.getMeta(blockFlashKey) as string | null | undefined;
            return meta !== undefined ? meta : value;
          },
        },
        props: {
          decorations(state) {
            const id = blockFlashKey.getState(state);
            if (!id) return null;
            let found: DecorationSet | null = null;
            state.doc.descendants((node, pos) => {
              if (found) return false;
              if (node.attrs?.blockId === id) {
                found = DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, { class: "block-flash" })]);
                return false;
              }
              return true;
            });
            return found;
          },
        },
      }),
    ];
  },
});

import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion } from "@tiptap/suggestion";
import { create } from "zustand";
import { filterKinds, type BlockKind } from "../blockKinds";

/** UI state for the slash menu; the suggestion plugin writes it, `SlashMenu` reads it. */
interface SlashState {
  open: boolean;
  query: string;
  items: BlockKind[];
  index: number;
  rect: (() => DOMRect | null) | null;
  choose: ((kind: BlockKind) => void) | null;
}

export const useSlash = create<SlashState>(() => ({ open: false, query: "", items: [], index: 0, rect: null, choose: null }));
const close = () => useSlash.setState({ open: false, items: [], index: 0, rect: null, choose: null });

const key = new PluginKey("slashMenu");

export const Slash = Extension.create({
  name: "slash",

  addProseMirrorPlugins() {
    return [
      Suggestion<BlockKind, BlockKind>({
        editor: this.editor,
        pluginKey: key,
        char: "/",
        // Not inside code, where "/" is just a character.
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => filterKinds(query),
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run();
          void props.apply(editor);
        },
        render: () => {
          const sync = (p: { query: string; items: BlockKind[]; clientRect?: (() => DOMRect | null) | null; command: (k: BlockKind) => void }) =>
            useSlash.setState((s) => ({
              open: true,
              query: p.query,
              items: p.items,
              index: p.query === s.query ? Math.min(s.index, Math.max(0, p.items.length - 1)) : 0,
              rect: p.clientRect ?? null,
              choose: p.command,
            }));
          return {
            onStart: sync,
            onUpdate: sync,
            onExit: close,
            onKeyDown: ({ event, view }) => {
              const { items, index, choose } = useSlash.getState();
              if (event.key === "Escape") {
                exitSuggestion(view, key);
                return true;
              }
              if (!items.length) return false;
              if (event.key === "ArrowDown") {
                useSlash.setState({ index: (index + 1) % items.length });
                return true;
              }
              if (event.key === "ArrowUp") {
                useSlash.setState({ index: (index - 1 + items.length) % items.length });
                return true;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                choose?.(items[index]);
                return true;
              }
              return false;
            },
          };
        },
      }),
    ];
  },
});

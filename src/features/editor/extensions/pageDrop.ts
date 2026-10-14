import { Extension, type Editor } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { useWorkspace } from "../../../stores/workspace";
import { registerPageDrop } from "../pageDropBridge";

/**
 * The sidebar drags pages with pointer events (not HTML5 drag and drop), so the editor cannot
 * receive a `drop` event. Instead each mounted editor registers here and the sidebar asks, when a
 * drag ends, whether the pointer is over one. A page dropped on text becomes a page mention.
 */
const editors = new Set<Editor>();

/** Inserts a mention for each page at the pointer. Returns false when no editable editor is under it. */
export function dropPagesOnEditor(pageIds: string[], x: number, y: number): boolean {
  const under = document.elementsFromPoint(x, y);
  for (const editor of editors) {
    if (!editor.isEditable || !under.includes(editor.view.dom)) continue;
    const { selectedPageId } = useWorkspace.getState();
    const ids = pageIds.filter((id) => id !== selectedPageId);
    if (!ids.length) return true; // over the editor, but nothing worth linking: swallow the drop
    const at = editor.view.posAtCoords({ left: x, top: y });
    const chain = editor.chain().focus();
    if (at) chain.setTextSelection(TextSelection.near(editor.state.doc.resolve(at.pos)).from);
    chain
      .insertContent(ids.flatMap((id) => [{ type: "pageMention", attrs: { pageId: id } }, { type: "text", text: " " }]))
      .run();
    void useWorkspace.getState().ensureTitles(ids);
    return true;
  }
  return false;
}

registerPageDrop(dropPagesOnEditor);

export const PageDrop = Extension.create({
  name: "pageDrop",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        view: () => {
          editors.add(editor);
          return { destroy: () => void editors.delete(editor) };
        },
      }),
    ];
  },
});

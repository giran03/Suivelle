import { Extension, type Editor } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { useWorkspace } from "../../../stores/workspace";
import { dockTargetAt } from "../../split/dropOnSplit";
import { registerPageDrop } from "../pageDropBridge";

/**
 * The sidebar drags pages with pointer events (not HTML5 drag and drop), so the editor cannot
 * receive a `drop` event. Instead each mounted editor registers here and the sidebar asks, when a
 * drag ends, whether the pointer is over one. A page dropped on text becomes a page mention.
 */
const editors = new Set<Editor>();

/** The document position a page dropped at this point would land on; past the last block it lands at the end. */
function dropPos(editor: Editor, x: number, y: number): number {
  const at = editor.view.posAtCoords({ left: x, top: y });
  return at ? TextSelection.near(editor.state.doc.resolve(at.pos)).from : TextSelection.atEnd(editor.state.doc).from;
}

/** Inserts a mention for each page at the pointer. Returns false when no editable editor is under it. */
export function dropPagesOnEditor(pageIds: string[], x: number, y: number): boolean {
  const under = document.elementsFromPoint(x, y);
  for (const editor of editors) {
    if (!editor.isEditable || !under.includes(editor.view.dom)) continue;
    const selectedPageId = editor.view.dom.dataset.contextPage ?? useWorkspace.getState().selectedPageId;
    const ids = pageIds.filter((id) => id !== selectedPageId);
    if (!ids.length) return true; // over the editor, but nothing worth linking: swallow the drop
    editor
      .chain()
      .focus()
      .setTextSelection(dropPos(editor, x, y))
      .insertContent(ids.flatMap((id) => [{ type: "pageMention", attrs: { pageId: id } }, { type: "text", text: " " }]))
      .run();
    hidePreview();
    void useWorkspace.getState().ensureTitles(ids);
    return true;
  }
  return false;
}

registerPageDrop(dropPagesOnEditor);

/**
 * While a sidebar page is dragged over an editor, a caret and a skeleton chip show exactly where the
 * mention will land, using the same position the drop itself uses.
 */
let caret: HTMLElement | null = null;
function hidePreview() { caret?.removeAttribute("data-on"); }
function showPreview(x: number, y: number) {
  // Near a pane's edge the drop docks a pane instead of linking, and the dock outline says so.
  if (dockTargetAt(x, y)) return hidePreview();
  const under = document.elementsFromPoint(x, y);
  const editor = [...editors].find((ed) => ed.isEditable && under.includes(ed.view.dom));
  if (!editor) return hidePreview();
  const box = editor.view.coordsAtPos(dropPos(editor, x, y));
  if (!caret) {
    caret = document.createElement("div");
    caret.className = "page-drop-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.innerHTML = '<span class="page-drop-chip"></span>';
    document.body.appendChild(caret);
  }
  caret.style.left = `${box.left}px`;
  caret.style.top = `${box.top}px`;
  caret.style.height = `${box.bottom - box.top}px`;
  caret.setAttribute("data-on", "");
}
if (typeof window !== "undefined") {
  window.addEventListener("pointermove", (e) => { if (document.body.classList.contains("page-drag")) showPreview(e.clientX, e.clientY); else if (caret?.hasAttribute("data-on")) hidePreview(); }, true);
}

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

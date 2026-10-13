import type { Editor } from "@tiptap/core";

/** The editor's DOM node, or null while the view is not mounted (TipTap throws on early access). */
export function editorDom(editor: Editor): HTMLElement | null {
  try {
    return editor.isDestroyed ? null : (editor.view.dom as HTMLElement);
  } catch {
    return null;
  }
}

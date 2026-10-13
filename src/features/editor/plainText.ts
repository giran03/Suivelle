import type { Editor } from "@tiptap/core";
import { copyText } from "../../components/editingMenu";
import { useWorkspace } from "../../stores/workspace";

/** Set while a "paste as plain text" runs, so Intake does not turn Markdown-looking text into blocks. */
export const plainPaste = { active: false };

export function selectedPlainText(editor: Editor): string {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, "\n");
}

export function copyPlainText(editor: Editor): boolean {
  const text = selectedPlainText(editor);
  if (!text) return false;
  void copyText(text);
  return true;
}

export function pastePlainText(editor: Editor, text?: string): boolean {
  if (!editor.isEditable) return false;
  const insert = (value: string) => {
    plainPaste.active = true;
    try { editor.view.pasteText(value); } finally { plainPaste.active = false; }
  };
  if (text !== undefined) { insert(text); return true; }
  navigator.clipboard.readText().then(insert, () => useWorkspace.getState().setError("Could not paste from the clipboard. Use Ctrl+Shift+V (or Command+Shift+V)."));
  return true;
}

import type { MenuItem } from "./ContextMenu";
import { useWorkspace } from "../stores/workspace";

export const copyText = async (text: string) => {
  try { await navigator.clipboard.writeText(text); }
  catch { useWorkspace.getState().setError("Could not access the clipboard. Try the keyboard shortcut."); }
};

/** Capture selection before the menu takes focus, and restore it before editing. */
export function editingItems(target: HTMLElement, overrides: Partial<Record<"undo" | "redo" | "selectAll", () => void>> & { paste?: (text: string) => void } = {}): MenuItem[] {
  const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
  const selectable = !field || field.selectionStart !== null;
  const start = field?.selectionStart ?? 0, end = field?.selectionEnd ?? 0;
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const text = field ? selectable ? field.value.slice(start, end) : field.value : selection?.toString() ?? "";
  const editable = field ? !field.readOnly && !field.disabled : target.isContentEditable;
  const privateField = field instanceof HTMLInputElement && field.type === "password";
  const restore = () => {
    if (!target.isConnected) return false;
    target.focus({ preventScroll: true });
    if (field) { try { field.setSelectionRange(start, end); } catch { /* Date/number fields have no text selection. */ } }
    else if (range) { selection?.removeAllRanges(); selection?.addRange(range); }
    return true;
  };
  const command = (name: string) => () => { if (restore()) document.execCommand(name); };
  return [
    ...(editable ? [
      { label: "Undo", onSelect: overrides.undo ?? command("undo") },
      { label: "Redo", onSelect: overrides.redo ?? command("redo") },
    ] : []),
    ...(!privateField ? [{ label: selectable ? "Copy" : "Copy value", separated: editable, disabled: !text, onSelect: () => { if (!restore()) return; if (!selectable || !document.execCommand("copy")) void copyText(text); } }] : []),
    ...(editable ? [
      ...(!privateField ? [{ label: "Cut", disabled: !text || !selectable, onSelect: command("cut") }] : []),
      { label: "Paste text", disabled: !!field && !selectable && field.type !== "number", onSelect: async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (!restore()) return;
          if (overrides.paste) overrides.paste(text);
          else if (!document.execCommand("insertText", false, text)) throw new Error("Paste unavailable");
        } catch { useWorkspace.getState().setError("Could not paste from the clipboard. Use Ctrl+V (or Command+V)."); }
      } },
    ] : []),
    { label: "Select all", disabled: !selectable, separated: true, onSelect: overrides.selectAll ?? (() => { if (!target.isConnected) return; target.focus(); if (field) field.select(); else document.execCommand("selectAll"); }) },
  ];
}

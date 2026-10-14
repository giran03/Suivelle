import type { MenuItem } from "../../components/ContextMenu";
import { usePeek } from "../peek/store";
import { copyText } from "../../components/editingMenu";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";
import { useHistoryPanel } from "../history/store";

export const copyPageLink = (id: string) => copyText(`suivelle://page/${id}`);
export function pageItems(page: Page): MenuItem[] {
  const store = useWorkspace.getState();
  return [
    { label: "Open", onSelect: () => void store.openPage(page.id) },
    ...(page.id !== store.selectedPageId ? [{ label: "Open beside", onSelect: () => usePeek.getState().show(page.id) }] : []),
    { label: "Copy link", shortcut: "copy-link", onSelect: () => void copyPageLink(page.id) },
    { label: page.favorite ? "Remove from favorites" : "Add to favorites", shortcut: page.favorite ? "unfavorite" : "favorite", onSelect: () => void store.toggleFavorite(page) },
    ...(page.kind === "page" ? [{ label: "Add page inside", shortcut: "new-subpage", onSelect: () => void store.createPage(page.id) }] : []),
    ...((page.kind === "page" || page.kind === "record") && page.id === store.selectedPageId ? [{ label: "Version history", shortcut: "history", onSelect: () => useHistoryPanel.getState().toggle() }] : []),
    { label: "Move to trash", shortcut: "page-trash", separated: true, danger: true, onSelect: () => void store.trashPage(page) },
  ];
}

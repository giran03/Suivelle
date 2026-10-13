import type { MenuItem } from "../../components/ContextMenu";
import { copyText } from "../../components/editingMenu";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";
import { useHistoryPanel } from "../history/store";

export const copyPageLink = (id: string) => copyText(`suivelle://page/${id}`);
export function pageItems(page: Page): MenuItem[] {
  const store = useWorkspace.getState();
  return [
    { label: "Open", onSelect: () => void store.openPage(page.id) },
    { label: "Copy link", onSelect: () => void copyPageLink(page.id) },
    { label: page.favorite ? "Remove from favorites" : "Add to favorites", onSelect: () => void store.toggleFavorite(page) },
    ...(page.kind === "page" ? [{ label: "Add page inside", onSelect: () => void store.createPage(page.id) }] : []),
    ...((page.kind === "page" || page.kind === "record") && page.id === store.selectedPageId ? [{ label: "Version history", onSelect: () => useHistoryPanel.getState().toggle() }] : []),
    { label: "Move to trash", separated: true, danger: true, onSelect: () => void store.trashPage(page) },
  ];
}

import { key } from "../features/shortcuts/bindings";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { copyText, editingItems } from "./editingMenu";
import { pageItems } from "../features/pages/pageMenu";
import { useWorkspace } from "../stores/workspace";

/** Suppress browser menus; specialized surfaces claim their events first. */
export function AppContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; host: HTMLElement } | null>(null);
  useEffect(() => {
    const open = (e: MouseEvent, fieldsOnly = false) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const field = target.closest<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
      if (fieldsOnly && (!field || (field instanceof HTMLInputElement && ["checkbox", "radio", "range", "color", "file", "button", "submit", "reset", "hidden"].includes(field.type)))) return;
      if (!fieldsOnly && e.defaultPrevented) return;
      if (fieldsOnly) e.stopPropagation();
      e.preventDefault();
      if (target.closest('[role="menu"]')) return;
      let items: MenuItem[] = [];
      if (field && !(field instanceof HTMLInputElement && ["checkbox", "radio", "range", "color", "file", "button", "submit", "reset", "hidden"].includes(field.type))) items = editingItems(field);
      else {
        const link = target.closest<HTMLAnchorElement>("a[href]");
        const pageId = target.closest<HTMLElement>("[data-context-page]")?.dataset.contextPage;
        const store = useWorkspace.getState();
        const page = pageId === store.selectedPage?.id ? store.selectedPage : store.ancestors.find((p) => p.id === pageId);
        if (link) items = [{ label: "Copy link address", onSelect: () => void copyText(link.href) }];
        else if (page) items = pageItems(page);
        else if (window.getSelection()?.toString()) { const text = window.getSelection()!.toString(); items = [{ label: "Copy", shortcut: [key("c", "Primary")], onSelect: () => void copyText(text) }]; }
        else if (target.closest(".sidebar")) items = [
          { label: "New page", shortcut: "new-page", onSelect: () => void store.createPage(null) },
          { label: "New database", shortcut: "new-database", onSelect: () => void store.createDatabase(null) },
          { label: "New dashboard", shortcut: "new-dashboard", onSelect: () => void store.createDashboard(null) },
        ];
      }
      // Keep modal-dialog menus within its non-inert DOM subtree.
      if (items.length) setMenu({ x: e.clientX, y: e.clientY, items, host: target.closest<HTMLDialogElement>("dialog[open]") ?? document.body });
      else setMenu(null);
    };
    const capture = (e: MouseEvent) => open(e, true);
    const bubble = (e: MouseEvent) => open(e);
    const keyboard = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
      const target = document.activeElement;
      if (!(target instanceof HTMLElement)) return;
      e.preventDefault();
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.bottom }));
    };
    document.addEventListener("contextmenu", capture, true);
    document.addEventListener("contextmenu", bubble);
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("contextmenu", capture, true); document.removeEventListener("contextmenu", bubble); document.removeEventListener("keydown", keyboard); };
  }, []);
  return menu ? createPortal(<ContextMenu key={`${menu.x}:${menu.y}`} x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />, menu.host) : null;
}

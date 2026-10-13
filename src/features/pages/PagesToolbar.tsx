import { useEffect, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { Icon } from "../../components/Icon";
import { useWorkspace } from "../../stores/workspace";
import { modKey } from "../palette/store";
import { useTemplateGallery } from "../templates/store";
import { pastePages, usePageClipboard } from "./pageClipboard";
import { READ_ONLY } from "../../lib/access";
import { useShortcut } from "../shortcuts/useShortcut";
import { clearSelection, usePageSelection } from "./pageSelection";

/** Creation stays one click away; tree controls remain visible without hovering. */
export function PagesToolbar() {
  const held = usePageClipboard(s => s.held);
  const pasting = usePageClipboard(s => s.pasting);
  const pasteShortcut = useShortcut("page-paste");
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const roots = useWorkspace((s) => s.children.root);
  const expanded = useWorkspace((s) => s.expanded);
  const expanding = useWorkspace((s) => s.treeExpanding);
  const currentPage = useWorkspace((s) => s.view === "page" ? s.selectedPage : null);
  const pickedCount = usePageSelection((s) => s.ids.length);
  const [refreshing, setRefreshing] = useState(false);
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ kind: "new" | "options"; x: number; y: number } | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const available = !!workspaceId && !!roots;
  const hasBranches = roots?.some((p) => p.childCount > 0) ?? false;
  const hasExpanded = Object.values(expanded).some(Boolean);

  useEffect(() => { setMenu(null); setRevealTarget(null); }, [workspaceId]);
  useEffect(() => {
    if (!revealTarget) return;
    const row = [...document.querySelectorAll<HTMLElement>('.tree[aria-label="All pages"] [role="treeitem"]')].find((el) => el.dataset.key === revealTarget);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
    setRevealTarget(null);
  }, [revealTarget]);

  const openMenu = (button: HTMLButtonElement, kind: "new" | "options") => {
    menuTrigger.current = button;
    const r = button.getBoundingClientRect();
    setMenu({ kind, x: r.left, y: r.bottom + 4 });
  };
  const closeMenu = () => {
    setMenu(null);
    menuTrigger.current?.focus({ preventScroll: true });
  };
  const reveal = async () => {
    setRevealTarget(await useWorkspace.getState().revealCurrentPage());
  };
  const refresh = async () => {
    setRefreshing(true);
    try { await useWorkspace.getState().reloadTree(); }
    finally { setRefreshing(false); }
  };
  const items: MenuItem[] = menu?.kind === "new" ? [
    { label: "New page", shortcut: "new-page", onSelect: () => void useWorkspace.getState().createPage(null) },
    { label: "New database", shortcut: "new-database", onSelect: () => void useWorkspace.getState().createDatabase(null) },
    { label: "New dashboard", shortcut: "new-dashboard", onSelect: () => void useWorkspace.getState().createDashboard(null) },
    { label: "New from template…", shortcut: "new-from-template", separated: true, onSelect: () => useTemplateGallery.getState().show() },
  ] : [
    ...(!READ_ONLY && held ? [{ label: pasting ? "Pasting pages…" : "Paste pages at top level", shortcut: "page-paste", disabled: !available || pasting, onSelect: () => void pastePages(null) }] : []),
    { label: currentPage?.kind === "record" ? "Show current database in tree" : "Show current page in tree", disabled: !currentPage, onSelect: () => void reveal() },
    { label: refreshing ? "Refreshing pages…" : "Refresh pages", disabled: refreshing || expanding, onSelect: () => void refresh() },
    ...(pickedCount ? [{ label: `Clear selection (${pickedCount})`, separated: true, onSelect: clearSelection }] : []),
  ];

  return (
    <div className="pages-tools">
      <div className="pages-heading">
        <h2>Pages</h2>
        <div className="pages-create">
          <button type="button" className="pages-new" aria-label="New page" title={`New page (${modKey}+N)`} disabled={!available} onClick={() => void useWorkspace.getState().createPage(null)}>
            <Icon name="plus" size={14} /><span>New</span>
          </button>
          <button type="button" className="pages-new-menu" aria-label="More ways to create" title="New database, dashboard or template" aria-haspopup="menu" aria-expanded={menu?.kind === "new"} disabled={!available} onClick={(e) => openMenu(e.currentTarget, "new")}>
            <Icon name="chevron" size={12} />
          </button>
        </div>
      </div>
      <div className="pages-tree-tools" role="group" aria-label="Page tree controls">
        <button type="button" className="pages-tree-action" aria-label={expanding ? "Expanding all pages" : "Expand all pages"} title="Expand all pages" disabled={!available || !hasBranches || expanding || refreshing} onClick={() => void useWorkspace.getState().expandAllPages()}>
          <Icon name="expandAll" size={14} /><span>{expanding ? "Expanding…" : "Expand"}</span>
        </button>
        <button type="button" className="pages-tree-action" aria-label="Collapse all pages" title={expanding ? "Stop expanding and collapse all pages" : "Collapse all pages"} disabled={!available || (!hasExpanded && !expanding)} onClick={() => useWorkspace.getState().collapseAllPages()}>
          <Icon name="collapseAll" size={14} /><span>Collapse</span>
        </button>
        {!READ_ONLY && held && <button type="button" className="icon-btn" aria-label="Paste pages at top level" title={`Paste pages at top level${pasteShortcut.label ? ` (${pasteShortcut.label})` : ""}`} disabled={!available || pasting} onClick={() => void pastePages(null)}><Icon name="duplicate" /></button>}
        <button type="button" className="icon-btn pages-options" aria-label="Page tree options" title="Page tree options" aria-haspopup="menu" aria-expanded={menu?.kind === "options"} disabled={!available} onClick={(e) => openMenu(e.currentTarget, "options")}>
          <Icon name="more" />
        </button>
      </div>
      <span className="sr-only" role="status">{expanding ? "Expanding all pages. Collapse all cancels expansion." : refreshing ? "Refreshing pages." : ""}</span>
      {menu && <ContextMenu key={`${workspaceId}-${menu.kind}`} x={menu.x} y={menu.y} items={items} onClose={closeMenu} />}
    </div>
  );
}

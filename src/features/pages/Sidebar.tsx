import { CanvasesSection } from "../canvas/CanvasesSection";
import { useNodeMap } from "../node-map/store";
import { useAgents } from "../agents/store";
import { dropPagesOnBoard } from "../canvas/store";
import { key } from "../shortcuts/bindings";
import { usePeek } from "../peek/store";
import { clearDockHint, dropOnSplit, updateDockHint } from "../split/dropOnSplit";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragMoveEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useBackupsDialog } from "../backup/store";
import { READ_ONLY } from "../../lib/access";
import { useSlidingIndicator } from "../../lib/useSlidingIndicator";
import { useTransferDialog } from "../transfer/store";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { copyPageLink } from "./pageMenu";
import { IconSwap } from "../../components/Swap";
import { Icon } from "../../components/Icon";
import { WorkspaceSwitcher } from "../workspaces/WorkspaceSwitcher";
import { workspaceOptions } from "../workspaces/model";
import { dropZone, isInSubtree, resolveDrop, type DropZone } from "../../lib/dnd";
import { ipc } from "../../lib/ipc";
import { useSettingsDialog } from "../settings/store";
import { sidebarRail, useLayout } from "../../stores/layout";
import { useWorkspace } from "../../stores/workspace";
import { dropPagesOnEditor, lastPointer } from "../editor/pageDropBridge";
import { PageGlyph } from "./PageGlyph";
import { Tree, TreeItem } from "./TreeItem";
import { openFromAuxClick, openInNewTab } from "../tabs/tabs";
import { duplicatePage, saveAsTemplate } from "../templates/pageTemplates";
import type { Page } from "../../types";
import { Collapse } from "../../components/Collapse";
import { canPasteInto, copyPages, cutPages, movePagesTo, pastePages, usePageClipboard } from "./pageClipboard";
import { duplicatePages, favoritePages, openInTabs, trashPages } from "./pageBatch";
import { clearSelection, clickPage, pickedRoots, usePageSelection, usePicked } from "./pageSelection";
import { usePageTransfer } from "./PageTransferDialog";
import { PagesToolbar } from "./PagesToolbar";
import { useShortcutScope } from "../shortcuts/runtime";
import { copyHierarchyPages, pasteHierarchyPages } from "./pageClipboard";
import { useShortcut } from "../shortcuts/useShortcut";

interface Drop {
  id: string;
  zone: DropZone;
}
interface TreeCtx {
  dropTarget: Drop | null;
  openMenu: (e: { clientX: number; clientY: number }, page: Page) => void;
}
const Ctx = createContext<TreeCtx>({ dropTarget: null, openMenu: () => {} });

const label = (p: Page) => p.title || "Untitled";

function PageRow({ page, depth, index, count }: { page: Page; depth: number; index: number; count: number }) {
  const { dropTarget, openMenu } = useContext(Ctx);
  const children = useWorkspace((s) => s.children[page.id]);
  const open = useWorkspace((s) => !!s.expanded[page.id]);
  const selected = useWorkspace((s) => s.view === "page" && s.selectedPageId === page.id);
  const cut = usePageClipboard((s) => s.held?.mode === "cut" && s.held.pages.some((p) => p.id === page.id));
  const picked = usePicked(page.id);
  const { toggleExpanded, createPage } = useWorkspace.getState();

  const drag = useDraggable({ id: page.id, disabled: READ_ONLY });
  const drop = useDroppable({ id: page.id });
  const ref = (el: HTMLDivElement | null) => {
    drag.setNodeRef(el);
    drop.setNodeRef(el);
  };
  const zone = dropTarget?.id === page.id ? dropTarget.zone : null;
  const nested = open && children && children.length > 0 ? children : null;

  // The row is the one focusable thing (see TreeItem); its buttons are for the pointer, and the menu
  // key opens the same actions for the keyboard.
  return (
    <TreeItem
      ref={ref}
      {...drag.listeners}
      itemKey={page.id}
      label={label(page)}
      level={depth + 1}
      index={index}
      count={count}
      expanded={page.childCount > 0 ? open : undefined}
      selected={selected}
      picked={picked}
      className={`node${selected ? " selected" : ""}${picked ? " picked" : ""}${cut ? " cut" : ""}${drag.isDragging ? " dragging" : ""}${zone ? ` drop-${zone}` : ""}`}
      style={{ paddingLeft: 6 + depth * 16 }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, page);
      }}
      group={nested && { style: { "--d": depth } as React.CSSProperties, children: nested.map((c, i) => <PageRow key={c.id} page={c} depth={depth + 1} index={i} count={nested.length} />) }}
    >
      {page.childCount > 0 ? (
        <button className="icon-btn chevron" tabIndex={-1} aria-hidden="true" aria-expanded={open} onClick={() => void toggleExpanded(page.id)}>
          <Icon name="chevron" />
        </button>
      ) : (
        <span className="icon-spacer" />
      )}
      <button className="title" tabIndex={-1} aria-hidden="true" onClick={(e) => clickPage(e, page.id)} onAuxClick={(e) => openFromAuxClick(e, page.id)}>
        <PageGlyph page={page} />
        <span>{label(page)}</span>
      </button>
      <span className="actions" aria-hidden="true">
        <button
          className="icon-btn"
          tabIndex={-1}
          title={`More actions for ${label(page)}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu({ clientX: r.left, clientY: r.bottom + 4 }, page);
          }}
        >
          <Icon name="more" />
        </button>
        {page.kind !== "database" && page.kind !== "dashboard" && (
          <button className="icon-btn" tabIndex={-1} title={`Add a page inside ${label(page)}`} onClick={() => void createPage(page.id)}>
            <Icon name="plus" />
          </button>
        )}
      </span>
    </TreeItem>
  );
}

/** The page tree: every top-level page and, for those expanded, the pages nested under them. */
function PageTree({ roots }: { roots: Page[] }) {
  const children = useWorkspace((s) => s.children);
  const expanded = useWorkspace((s) => s.expanded);
  const keys: string[] = [];
  const walk = (list: Page[]) => {
    for (const p of list) {
      keys.push(p.id);
      if (expanded[p.id] && children[p.id]) walk(children[p.id]);
    }
  };
  walk(roots);
  return (
    <Tree name="pages" label="All pages" keys={keys}>
      {roots.map((p, i) => (
        <PageRow key={p.id} page={p} depth={0} index={i} count={roots.length} />
      ))}
    </Tree>
  );
}

/** The last few pages opened, newest first. Collapsible, and hidden until there is something to show. */
function Recents() {
  const pickedIds = usePageSelection((s) => s.ids);
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const selectedPageId = useWorkspace((s) => s.selectedPageId);
  const view = useWorkspace((s) => s.view);
  const open = useLayout((s) => s.recentOpen);
  const favorites = useWorkspace((s) => s.favorites);
  const [recent, setPages] = useState<Page[]>([]);
  // Favorites already sit one section above, so listing them again only adds noise.
  const pages = recent.filter((p) => !favorites.some((f) => f.id === p.id));

  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    // Opening a page records the visit a moment later, so wait before asking.
    const timer = window.setTimeout(() => {
      ipc
        .pageListRecent(workspaceId, 11)
        .then((list) => alive && setPages(list.filter((p) => p.id !== selectedPageId).slice(0, 10)))
        .catch(() => undefined);
    }, 500);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [workspaceId, selectedPageId]);

  if (pages.length === 0) return null;
  return (
    <section className="sidebar-recents">
      <h2>
        <button className="section-toggle" aria-expanded={open} onClick={() => useLayout.getState().toggleRecent()}>
          <Icon name="chevron" size={12} />
          Recent
        </button>
      </h2>
      <Collapse open={open}>
        <Tree name="recent" label="Recent files" className="tree recent-list" keys={pages.map((p) => p.id)}>
          {pages.map((p, i) => (
            <TreeItem key={p.id} itemKey={p.id} label={label(p)} level={1} index={i} count={pages.length} selected={view === "page" && selectedPageId === p.id} picked={pickedIds.includes(p.id)} className={`node plain${view === "page" && selectedPageId === p.id ? " selected" : ""}${pickedIds.includes(p.id) ? " picked" : ""}`} style={{ paddingLeft: 6 }}>
              <span className="icon-spacer" />
              <button className="title" tabIndex={-1} aria-hidden="true" onClick={(e) => clickPage(e, p.id)} onAuxClick={(e) => openFromAuxClick(e, p.id)}>
                <PageGlyph page={p} />
                <span>{label(p)}</span>
              </button>
            </TreeItem>
          ))}
        </Tree>
      </Collapse>
    </section>
  );
}

function RailPageButton({
  page,
  current,
  onClick,
  onAuxClick,
  onContextMenu,
}: {
  page: Page;
  current: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onAuxClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const drag = useDraggable({ id: page.id });
  return (
    <button
      ref={drag.setNodeRef}
      type="button"
      className={`rail-page${drag.isDragging ? " dragging" : ""}`}
      title={label(page)}
      aria-label={label(page)}
      aria-current={current ? "page" : undefined}
      {...drag.attributes}
      {...drag.listeners}
      onClick={onClick}
      onAuxClick={onAuxClick}
      onContextMenu={onContextMenu}
    >
      <PageGlyph page={page} />
    </button>
  );
}

export function Sidebar() {
  const navigation = useRef<HTMLElement>(null);
  useShortcutScope(navigation, "pages", {
    "page-copy": () => { if (READ_ONLY) return false; return copyHierarchyPages(); },
    "page-paste": () => { if (READ_ONLY) return false; return pasteHierarchyPages(); },
  });
  const rail = useLayout(sidebarRail);
  const compact = useLayout((s) => s.compact);
  const sidebarAction = compact ? "Close navigation" : rail ? "Expand sidebar" : "Collapse sidebar";
  const settingsShortcut = useShortcut("settings");
  const sidebarShortcut = useShortcut("sidebar");
  const workspace = useWorkspace((s) => s.workspace);
  const roots = useWorkspace((s) => s.children.root);
  const favorites = useWorkspace((s) => s.favorites);
  const view = useWorkspace((s) => s.view);
  const agentsPending = useAgents((s) => s.pending);
  const hasActiveAgents = useAgents((s) => s.hasActiveAgents);
  const selectedPageId = useWorkspace((s) => s.selectedPageId);
  const expanded = useWorkspace((s) => s.expanded);
  const childrenMap = useWorkspace((s) => s.children);
  const navIndicator = useSlidingIndicator(
    navigation,
    rail ? '.rail-page[aria-current="page"]' : ".node.selected",
    [view, selectedPageId, favorites, roots, expanded, childrenMap],
    rail
  );
  const pickedIds = usePageSelection((s) => s.ids);
  const { createPage, showTrash, toggleFavorite } = useWorkspace.getState();

  const [menu, setMenu] = useState<{ x: number; y: number; page: Page } | null>(null);
  const [toolsMenu, setToolsMenu] = useState<{ x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<Drop | null>(null);
  const [dragging, setDragging] = useState<Page | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const lookup = (id: string): Page | undefined => {
    const s = useWorkspace.getState();
    for (const list of Object.values(s.children)) {
      const hit = list.find((p) => p.id === id);
      if (hit) return hit;
    }
    return undefined;
  };
  const siblingsOf = (parentId: string | null) => useWorkspace.getState().children[parentId ?? "root"] ?? [];

  const target = (e: DragMoveEvent | DragEndEvent): Drop | null => {
    const { over, active, activatorEvent, delta } = e;
    if (!over || over.id === active.id || isInSubtree(String(active.id), String(over.id), lookup)) return null;
    const y = (activatorEvent as PointerEvent).clientY + delta.y;
    return { id: String(over.id), zone: dropZone(y, over.rect.top, over.rect.height) };
  };

  /** Where the drag ended: the live pointer, falling back to the start plus the distance travelled. */
  const endPoint = (e: { activatorEvent: Event; delta: { x: number; y: number } }) => {
    const live = lastPointer();
    if (live) return live;
    const start = e.activatorEvent as PointerEvent;
    return start && typeof start.clientX === "number" ? { x: start.clientX + e.delta.x, y: start.clientY + e.delta.y } : null;
  };

  /** Whether the pointer ended over the tab strip (or its drop strip), where a page opens in a new tab. */
  const overTabs = (e: DragEndEvent) => {
    const end = endPoint(e);
    if (!end) return false;
    return document.elementsFromPoint(end.x, end.y).some((el) => el.closest(".tabbar"));
  };

  const onDragEnd = (e: DragEndEvent) => {
    // Test where the pointer is while the drop strip still exists; removing the class hides it.
    const onTabs = overTabs(e);
    const end0 = endPoint(e);
    const onSplit = !!end0 && dropOnSplit(String(e.active.id), end0.x, end0.y);
    clearDockHint();
    if (onSplit) {
      document.body.classList.remove("page-drag");
      setDropTarget(null);
      setDragging(null);
      return;
    }
    if (onTabs) {
      document.body.classList.remove("page-drag");
      setDropTarget(null);
      setDragging(null);
      void openInNewTab(String(e.active.id));
      return;
    }
    // Dropped on a page's text: link to it (every picked page, when the dragged one is among them).
    // The drag class stays until the drop is placed: it shows the tab drop strip, and hiding that
    // first would shift the page upward and land the link on whatever slid under the pointer.
    const end = endPoint(e);
    if (end) {
      const dragged = String(e.active.id);
      const picked = usePageSelection.getState().ids;
      const ids = picked.includes(dragged) ? picked : [dragged];
      const { x, y } = end;
      const taken = dropPagesOnEditor(ids, x, y) || dropPagesOnBoard(ids, x, y);
      document.body.classList.remove("page-drag");
      if (taken) {
        setDropTarget(null);
        setDragging(null);
        return;
      }
    }
    document.body.classList.remove("page-drag");
    const drop = target(e);
    setDropTarget(null);
    setDragging(null);
    const over = drop && lookup(drop.id);
    if (!drop || !over) return;
    const dest = resolveDrop(String(e.active.id), over, drop.zone, siblingsOf);
    const dragged = String(e.active.id);
    if (usePageSelection.getState().ids.includes(dragged)) {
      const group = pickedRoots().filter((p) => p.id !== drop.id && !isInSubtree(p.id, drop.id, lookup));
      if (group.length > 1) {
        // Dropping before a page that is itself moving would have nothing to sit before: use the next one that stays.
        const ids = new Set(group.map((p) => p.id));
        const sibs = siblingsOf(dest.parentPageId);
        let at = dest.beforePageId ? sibs.findIndex((s) => s.id === dest.beforePageId) : -1;
        while (at >= 0 && at < sibs.length && ids.has(sibs[at].id)) at++;
        void movePagesTo(group, dest.parentPageId, at >= 0 && at < sibs.length ? sibs[at].id : null);
        return;
      }
    }
    void useWorkspace.getState().movePage(dragged, dest.parentPageId, dest.beforePageId);
  };

  /** Right-clicking a page outside the picked ones drops the selection first; the menu is then for that page alone. */
  const showMenu = (x: number, y: number, page: Page) => {
    const ids = usePageSelection.getState().ids;
    if (ids.length && !ids.includes(page.id)) clearSelection();
    setMenu({ x, y, page });
  };

  /** The menu for several picked pages: what can be done to all of them at once. */
  const multiItems = (): MenuItem[] => {
    const pages = pickedRoots();
    const n = pages.length;
    const noun = n === 1 ? "page" : "pages";
    const plain = pages.every((p) => p.kind === "page");
    return [
      { label: `Open ${n} ${noun} in new tabs`, shortcut: "page-new-tab", onSelect: () => void openInTabs(pages) },
      { label: `Cut ${n} ${noun}`, separated: true, disabled: pages.some((p) => p.kind === "record"), onSelect: () => cutPages(pages) },
      { label: `Copy ${n} ${noun}`, shortcut: "page-copy", disabled: !plain, onSelect: () => copyPages(pages) },
      { label: `Duplicate ${n} ${noun}`, shortcut: "duplicate", disabled: !plain, onSelect: () => void duplicatePages(pages) },
      { label: pages.every((p) => p.favorite) ? "Remove from favorites" : "Add to favorites", shortcut: pages.every(p => p.favorite) ? "unfavorite" : "favorite", separated: true, onSelect: () => void favoritePages(pages) },
      { label: "Move to workspace…", separated: true, disabled: !plain, onSelect: () => usePageTransfer.getState().show(pages, "move") },
      { label: "Copy to workspace…", disabled: !plain, onSelect: () => usePageTransfer.getState().show(pages, "copy") },
      { label: `Move ${n} ${noun} to trash`, shortcut: "page-trash", danger: true, separated: true, onSelect: () => void trashPages(pages) },
      { label: "Clear selection", onSelect: clearSelection },
    ];
  };

  const menuItems = (page: Page): MenuItem[] => {
    const picked = usePageSelection.getState().ids;
    if (picked.length > 1 && picked.includes(page.id)) return multiItems();
    const siblings = siblingsOf(page.parentPageId);
    const i = siblings.findIndex((p) => p.id === page.id);
    const nudge = useWorkspace.getState().nudgePage;
    const held = usePageClipboard.getState().held;
    return [
      { label: "Open", shortcut: [key("Enter")], onSelect: () => void useWorkspace.getState().openPage(page.id) },
      { label: "Open in new tab", shortcut: "page-new-tab", onSelect: () => void openInNewTab(page.id) },
      ...(page.id !== useWorkspace.getState().selectedPageId ? [{ label: "Open beside", onSelect: () => usePeek.getState().show(page.id) }] : []),
      { label: "Cut", separated: true, disabled: page.kind === "record", onSelect: () => cutPages([page]) },
      { label: "Copy", shortcut: "page-copy", disabled: page.kind !== "page", onSelect: () => copyPages([page]) },
      { label: "Paste inside", shortcut: "page-paste", disabled: !canPasteInto(held, page), onSelect: () => void pastePages(page) },
      { label: "Duplicate", shortcut: "duplicate", separated: true, disabled: page.kind !== "page", onSelect: () => void duplicatePage(page) },
      { label: "Save as template", shortcut: "save-template", disabled: page.kind !== "page", onSelect: () => void saveAsTemplate(page) },
      { label: "Copy link", shortcut: "copy-link", onSelect: () => void copyPageLink(page.id) },
      { label: "Add page inside", shortcut: "new-subpage", disabled: page.kind === "database" || page.kind === "dashboard", onSelect: () => void createPage(page.id) },
      { label: page.favorite ? "Remove from favorites" : "Add to favorites", shortcut: page.favorite ? "unfavorite" : "favorite", onSelect: () => void toggleFavorite(page) },
      { label: "Move to workspace…", separated: true, disabled: page.kind !== "page", onSelect: () => usePageTransfer.getState().show([page], "move") },
      { label: "Copy to workspace…", disabled: page.kind !== "page", onSelect: () => usePageTransfer.getState().show([page], "copy") },
      { label: "Move up", separated: true, disabled: i <= 0, onSelect: () => void nudge(page, "up") },
      { label: "Move down", disabled: i < 0 || i >= siblings.length - 1, onSelect: () => void nudge(page, "down") },
      { label: "Indent under previous page", disabled: i <= 0, onSelect: () => void nudge(page, "in") },
      { label: "Move out one level", disabled: !page.parentPageId, onSelect: () => void nudge(page, "out") },
      { label: "Move to trash", shortcut: "page-trash", danger: true, separated: true, onSelect: () => void useWorkspace.getState().trashPage(page) },
    ];
  };

  const onDragStart = (e: { active: { id: string | number } }) => {
    document.body.classList.add("page-drag");
    setDragging(lookup(String(e.active.id)) ?? null);
  };
  const onDragMove = (e: DragMoveEvent) => {
    if (!rail) setDropTarget(target(e));
    const pt = endPoint(e);
    if (pt) updateDockHint(pt.x, pt.y);
  };
  const onDragCancel = () => {
    document.body.classList.remove("page-drag");
    clearDockHint();
    setDropTarget(null);
    setDragging(null);
  };
  const dragOverlay = (
    <DragOverlay dropAnimation={null}>
      {dragging && (
        <div className="drag-chip">
          <PageGlyph page={dragging} />
          <span>{label(dragging)}</span>
        </div>
      )}
    </DragOverlay>
  );

  return (
    <aside id="workspace-sidebar" className="sidebar" aria-label="Workspace navigation" data-density={workspaceOptions(workspace).sidebarDensity}>
      <div className="ws-row">
        <WorkspaceSwitcher iconOnly={rail} />
        <button type="button" className="icon-btn sidebar-collapse" aria-label={sidebarAction} aria-controls="workspace-sidebar" aria-expanded={!rail} aria-keyshortcuts={sidebarShortcut.aria} title={`${sidebarAction}${sidebarShortcut.label ? ` (${sidebarShortcut.label})` : ""}`} onClick={() => useLayout.getState().toggleSidebar()}>
          <IconSwap name={rail ? "expandSidebar" : "collapseSidebar"} />
        </button>
      </div>

      {rail ? <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
        <nav ref={navigation} tabIndex={0} className="scroll rail-pages" aria-label="Pages">
          <span className={`sidebar-nav-indicator${navIndicator.animate ? " anim" : ""}`} aria-hidden="true" style={navIndicator.style} />
          {[...favorites, ...(roots ?? []).filter(p => !favorites.some(f => f.id === p.id))].map(p => (
            <RailPageButton
              key={p.id}
              page={p}
              current={view === "page" && selectedPageId === p.id}
              onClick={e => clickPage(e, p.id)}
              onAuxClick={e => openFromAuxClick(e, p.id)}
              onContextMenu={e => { e.preventDefault(); showMenu(e.clientX, e.clientY, p); }}
            />
          ))}
          {!READ_ONLY && <button type="button" className="rail-page" title="New page" aria-label="New page" onClick={() => void createPage(null)}><Icon name="plus" /></button>}
        </nav>
        {dragOverlay}
      </DndContext> : <nav ref={navigation} tabIndex={0} className="scroll" aria-label="Pages" onMouseDown={e => { if (e.target === e.currentTarget) e.currentTarget.focus(); }} onKeyDown={(e) => {
        if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && (e.target as Element).matches('[role="treeitem"]')) useLayout.setState({ compactOpen: false });
      }} onClick={(e) => {
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && (e.target as Element).closest("button.title")) useLayout.setState({ compactOpen: false });
      }}>
        <span className={`sidebar-nav-indicator${navIndicator.animate ? " anim" : ""}`} aria-hidden="true" style={navIndicator.style} />
        {favorites.length > 0 && (
          <section>
            <h2>Favorites</h2>
            <Tree name="favorites" label="Favorites" keys={favorites.map((p) => p.id)}>
              {favorites.map((p, i) => {
                const current = view === "page" && selectedPageId === p.id;
                return (
                  <TreeItem
                    key={p.id}
                    itemKey={p.id}
                    label={label(p)}
                    level={1}
                    index={i}
                    count={favorites.length}
                    selected={current}
                    picked={pickedIds.includes(p.id)}
                    className={`node${current ? " selected" : ""}${pickedIds.includes(p.id) ? " picked" : ""}`}
                    style={{ paddingLeft: 6 }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      showMenu(e.clientX, e.clientY, p);
                    }}
                  >
                    <span className="icon-spacer" />
                    <button className="title" tabIndex={-1} aria-hidden="true" onClick={(e) => clickPage(e, p.id)} onAuxClick={(e) => openFromAuxClick(e, p.id)}>
                      <PageGlyph page={p} />
                      <span>{label(p)}</span>
                    </button>
                    <span className="actions" aria-hidden="true">
                      <button className="icon-btn on" tabIndex={-1} title={`Remove ${label(p)} from favorites`} onClick={() => void toggleFavorite(p)}>
                        <Icon name="star" filled />
                      </button>
                    </span>
                  </TreeItem>
                );
              })}
            </Tree>
          </section>
        )}

        <Recents />
        <CanvasesSection />

        <section>
          <PagesToolbar />
          <Ctx.Provider
            value={{ dropTarget, openMenu: (e, page) => showMenu(e.clientX, e.clientY, page) }}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={pointerWithin}
              onDragStart={onDragStart}
              onDragMove={onDragMove}
              onDragEnd={onDragEnd}
              onDragCancel={onDragCancel}
            >
              {roots && roots.length > 0 ? (
                <PageTree roots={roots} />
              ) : roots ? (
                <p className="side-empty">
                  No pages yet.{" "}
                  <button className="link" onClick={() => void createPage(null)}>
                    Create one
                  </button>
                </p>
              ) : null}
              {dragOverlay}
            </DndContext>
          </Ctx.Provider>
        </section>
      </nav>}

      <footer role="toolbar" aria-label="Workspace tools" aria-orientation={rail ? "vertical" : "horizontal"}>
        {rail ? (
          <button
            type="button"
            className="foot-icon agents-launch rail-tools-btn"
            aria-label={agentsPending > 0 ? `Workspace tools (${agentsPending} waiting in inbox)` : "Workspace tools"}
            title="Workspace tools"
            aria-haspopup="menu"
            aria-expanded={toolsMenu !== null}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setToolsMenu((prev) => (prev ? null : { x: rect.right + 6, y: rect.top }));
            }}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" className="app-icon" aria-hidden="true">
              <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {agentsPending > 0 && <span className="agx-badge" aria-hidden="true">{agentsPending}</span>}
          </button>
        ) : (
          <>
            <button type="button" className={`foot-icon${view === "node-map" ? " active" : ""}`} title="Node Map" aria-label="Node Map" aria-pressed={view === "node-map"} onClick={() => useNodeMap.getState().show()}>
              <Icon name="nodeMap" />
            </button>
            {(hasActiveAgents || agentsPending > 0) && (
              <button
                type="button"
                className="foot-icon agents-launch"
                title={agentsPending > 0 ? `Agents inbox (${agentsPending} waiting)` : "Agents: review inbox"}
                aria-label={agentsPending > 0 ? `Agents inbox: ${agentsPending} waiting for review` : "Agents inbox"}
                onClick={() => useAgents.getState().show("review")}
              >
                <Icon name="inbox" />
                {agentsPending > 0 && <span className="agx-badge" aria-hidden="true">{agentsPending}</span>}
              </button>
            )}
            <button type="button" aria-label="Trash" title="Trash" aria-pressed={view === "trash"} className={`foot-icon${view === "trash" ? " active" : ""}`} onClick={() => void showTrash()}>
              <Icon name="trash" />
            </button>
            <button type="button" className="foot-icon" aria-label="Backups" title="Backups" onClick={() => useBackupsDialog.getState().show()}>
              <Icon name="restore" />
            </button>
            <button type="button" className="foot-icon" aria-label="Import and export" title="Import and export" onClick={() => useTransferDialog.getState().show()}>
              <Icon name="importExport" />
            </button>
            <button type="button" className="foot-icon" aria-label="Settings" title={`Settings${settingsShortcut.label ? ` (${settingsShortcut.label})` : ""}`} onClick={() => useSettingsDialog.getState().show()}>
              <Icon name="gear" />
            </button>
          </>
        )}
      </footer>

      {toolsMenu && (
        <ContextMenu
          x={toolsMenu.x}
          y={toolsMenu.y}
          items={[
            { label: "Node Map", onSelect: () => useNodeMap.getState().show() },
            ...(hasActiveAgents || agentsPending > 0
              ? [{ label: agentsPending > 0 ? `Agents inbox (${agentsPending})` : "Agents inbox", onSelect: () => useAgents.getState().show("review") }]
              : []),
            { label: "Trash", separated: true, onSelect: () => void showTrash() },
            { label: "Backups", onSelect: () => useBackupsDialog.getState().show() },
            { label: "Import and export", onSelect: () => useTransferDialog.getState().show() },
            { label: "Settings", shortcut: "settings", separated: true, onSelect: () => useSettingsDialog.getState().show() },
          ]}
          onClose={() => setToolsMenu(null)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.page)} onClose={() => setMenu(null)} />}
    </aside>
  );
}

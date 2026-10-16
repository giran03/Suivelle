import { useShortcutScope } from "../shortcuts/runtime";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Icon } from "../../components/Icon";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";
import { PageGlyph } from "../pages/PageGlyph";
import { DRAG_CLASS, dropOnSplit } from "../split/dropOnSplit";
import { closeTab, dropTab, moveTab, openTabBeside, useTabs } from "./tabs";
import "./tabs.css";

/** Finds what the sidebar already knows about a page before falling back to the title cache. */
function useTabPage(id: string): { title: string; page: Pick<Page, "icon" | "kind">; gone: boolean } {
  // Select the stable pieces and derive here: a selector that built a new object would re-render forever.
  const selectedPage = useWorkspace((s) => s.selectedPage);
  const children = useWorkspace((s) => s.children);
  const favorites = useWorkspace((s) => s.favorites);
  const titles = useWorkspace((s) => s.pageTitles);
  return useMemo(() => {
    let page: Page | undefined = selectedPage?.id === id ? selectedPage : undefined;
    if (!page) for (const list of Object.values(children)) page = page ?? list.find((p) => p.id === id);
    page = page ?? favorites.find((p) => p.id === id);
    if (page) return { title: page.title, page, gone: false };
    const cached = titles[id];
    return {
      title: cached?.title ?? "",
      page: { icon: cached?.icon ?? null, kind: "page" as const },
      gone: !!cached && (cached.deleted || !!cached.missing),
    };
  }, [id, selectedPage, children, favorites, titles]);
}

/**
 * Drag a tab anywhere. A ghost of it follows the pointer; over the strip the other tabs make room
 * as it passes them, and over a pane the dock hint shows where it would land. A drag never counts
 * as a click. Returns the pointer handler.
 */
function useTabDrag(id: string) {
  return (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const bar = e.currentTarget.closest<HTMLElement>(".tabbar");
    const tab = e.currentTarget.closest<HTMLElement>(".tab");
    if (!bar || !tab) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const grab = tab.getBoundingClientRect();
    // Keep the pointer stream ours: without this a press on the page icon can start the browser's own image drag, which cancels the pointer and loses the drop.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* Not capturable; the window listeners still work. */ }
    let dragging = false;
    let ghost: HTMLElement | null = null;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      if (!dragging) {
        dragging = true;
        tab.classList.add("dragging");
        document.body.classList.add(DRAG_CLASS, "tab-moving");
        ghost = tab.cloneNode(true) as HTMLElement;
        ghost.classList.add("tab-ghost");
        ghost.classList.remove("dragging");
        ghost.style.width = `${grab.width}px`;
        ghost.style.height = `${grab.height}px`;
        ghost.removeAttribute("role");
        ghost.setAttribute("aria-hidden", "true");
        document.body.appendChild(ghost);
      }
      const box = bar.getBoundingClientRect();
      const inStrip = ev.clientY >= box.top - 28 && ev.clientY <= box.bottom + 28 && ev.clientX >= box.left && ev.clientX <= box.right;
      if (ghost) {
        ghost.style.transform = `translate(${ev.clientX - (startX - grab.left)}px, ${ev.clientY - (startY - grab.top)}px)`;
        ghost.classList.toggle("docking", !inStrip);
      }
      if (!inStrip) return;
      // The tab takes the slot whose centre the pointer has passed.
      const others = [...bar.querySelectorAll<HTMLElement>(".tab")].filter((t) => t !== tab);
      const slot = others.filter((t) => {
        const r = t.getBoundingClientRect();
        return ev.clientX > r.left + r.width / 2;
      }).length;
      moveTab(id, slot);
    };
    const stop = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      tab.classList.remove("dragging");
      ghost?.remove();
      // Test the drop while the targets still exist; removing the class hides them.
      if (dragging && ev.type !== "pointercancel") dropOnSplit(id, ev.clientX, ev.clientY);
      document.body.classList.remove(DRAG_CLASS, "tab-moving");
      if (dragging) {
        // The click that ends a drag must not also switch tabs.
        const swallow = (c: MouseEvent) => c.stopPropagation();
        window.addEventListener("click", swallow, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
}

function Tab({ id, active, focusable }: { id: string; active: boolean; focusable: boolean }) {
  const inputRef = useRef<HTMLDivElement>(null);
  useShortcutScope(inputRef, "tab", {
    "tab-close": t => { if (t.closest(".tab-close")) return false; void closeTab(id); },
    "tab-move-left": () => { moveTab(id, useTabs.getState().ids.indexOf(id) - 1); },
    "tab-move-right": () => { moveTab(id, useTabs.getState().ids.indexOf(id) + 1); },
  });
  const { title, page, gone } = useTabPage(id);
  const onPointerDown = useTabDrag(id);
  // A tab whose page was deleted or trashed elsewhere quietly goes away.
  useEffect(() => {
    if (gone) dropTab(id);
  }, [gone, id]);
  const label = title || "Untitled";
  return (
    <div ref={inputRef} className={`tab${active ? " on" : ""}`} role="presentation" data-tab={id} onDragStart={(e) => e.preventDefault()}>
      <button
        className="tab-main"
        role="tab"
        aria-selected={active}
        tabIndex={focusable ? 0 : -1}
        title={`${label} · Alt+click to open beside`}
        onPointerDown={onPointerDown}
        onClick={(e) => { if (e.altKey) void openTabBeside(id); else void useWorkspace.getState().selectPage(id); }}

      >
        <PageGlyph page={page} size={14} />
        <span>{label}</span>
      </button>
      <button className="tab-close" aria-label={`Close ${label}`} title="Close tab" onClick={() => void closeTab(id)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

/** The strip of open pages. Hidden until a second page is opened in a new tab (Alt+click or middle-click a page). */
export function TabBar() {
  const ids = useTabs((s) => s.ids);
  const selected = useWorkspace((s) => s.selectedPageId);
  const view = useWorkspace((s) => s.view);
  const bar = useRef<HTMLDivElement>(null);
  const lefts = useRef(new Map<string, number>());
  // Tabs glide to their new places when one is moved, opened or closed.
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    bar.current?.querySelectorAll<HTMLElement>("[data-tab]").forEach((t) => {
      const left = t.getBoundingClientRect().left;
      const was = lefts.current.get(t.dataset.tab ?? "");
      next.set(t.dataset.tab ?? "", left);
      if (!calm && was !== undefined && Math.abs(was - left) > 1) t.animate([{ transform: `translateX(${was - left}px)` }, { transform: "none" }], { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    });
    lefts.current = next;
  }, [ids]);
  useEffect(() => {
    if (ids.length) void useWorkspace.getState().ensureTitles(ids);
  }, [ids]);
  // With no tabs yet there is nothing to show, except a strip to drop a page on while one is being dragged.
  if (ids.length < 2) {
    return (
      <div className="tabbar tabbar-drop" aria-hidden="true">
        <Icon name="plus" size={16} />
      </div>
    );
  }
  return (
    <div
      ref={bar}
      className="tabbar"
      role="tablist"
      aria-label="Open pages"
      onKeyDown={(e) => {
        // Arrow keys, Home and End move focus between tabs; Enter or Space opens the focused one.
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".tab-main")];
        const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
        if (at < 0) return;
        e.preventDefault();
        const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].focus();
      }}
    >
      {ids.map((id, i) => (
        <Tab key={id} id={id} active={view === "page" && id === selected} focusable={view === "page" && selected && ids.includes(selected) ? id === selected : i === 0} />
      ))}
    </div>
  );
}

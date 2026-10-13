import { useShortcutScope } from "../shortcuts/runtime";
import { useEffect, useMemo, useRef } from "react";
import { Icon } from "../../components/Icon";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";
import { PageGlyph } from "../pages/PageGlyph";
import { closeTab, dropTab, moveTab, useTabs } from "./tabs";
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

/** Drag a tab sideways to reorder; a drag never counts as a click. Returns the pointer handler. */
function useTabDrag(id: string) {
  return (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const bar = e.currentTarget.closest(".tabbar");
    const tab = e.currentTarget.closest<HTMLElement>(".tab");
    if (!bar || !tab) return;
    const startX = e.clientX;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) < 6) return;
      if (!dragging) {
        dragging = true;
        tab.classList.add("dragging");
      }
      // The tab under the pointer decides the new slot.
      const tabs = [...bar.querySelectorAll<HTMLElement>(".tab")];
      const over = tabs.findIndex((t) => {
        const r = t.getBoundingClientRect();
        return ev.clientX >= r.left && ev.clientX < r.right;
      });
      if (over >= 0) moveTab(id, over);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      tab.classList.remove("dragging");
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
    <div ref={inputRef} className={`tab${active ? " on" : ""}`} role="presentation">
      <button
        className="tab-main"
        role="tab"
        aria-selected={active}
        tabIndex={focusable ? 0 : -1}
        title={label}
        onPointerDown={onPointerDown}
        onClick={() => void useWorkspace.getState().selectPage(id)}

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
  useEffect(() => {
    if (ids.length) void useWorkspace.getState().ensureTitles(ids);
  }, [ids]);
  // With no tabs yet there is nothing to show, except a strip to drop a page on while one is being dragged.
  if (ids.length < 2) {
    return (
      <div className="tabbar tabbar-drop" aria-hidden="true">
        Drop here to open in a new tab
      </div>
    );
  }
  return (
    <div
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

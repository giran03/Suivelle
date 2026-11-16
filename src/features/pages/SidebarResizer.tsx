import { useRef } from "react";
import { SIDEBAR_COLLAPSE_THRESHOLD, SIDEBAR_HIDE_THRESHOLD, SIDEBAR_MAX, SIDEBAR_MIN, useLayout } from "../../stores/layout";

/** A draggable edge on the sidebar. Dragging <= 100px snaps to rail, <= 28px hides; double-click or Home restores default. */
export function SidebarResizer() {
  const width = useLayout((s) => s.width);
  const collapsed = useLayout((s) => s.collapsed);
  const hidden = useLayout((s) => s.hidden);
  const setWidth = useLayout((s) => s.setWidth);
  const setCollapsed = useLayout((s) => s.setCollapsed);
  const setHidden = useLayout((s) => s.setHidden);
  const ref = useRef<HTMLDivElement>(null);

  const current = () => ref.current?.parentElement?.querySelector<HTMLElement>(".sidebar")?.offsetWidth ?? width ?? 240;
  const collapseToRail = (restoreWidth: number) => {
    setHidden(false);
    setCollapsed(true);
    setWidth(restoreWidth > SIDEBAR_COLLAPSE_THRESHOLD ? restoreWidth : null);
  };

  return (
    <div
      ref={ref}
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={hidden ? 0 : collapsed ? 64 : (width ?? 240)}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        const startWidth = useLayout.getState().width ?? current();
        let snapTimer: ReturnType<typeof setTimeout> | undefined;
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging", "resizing");
        document.body.classList.add("resizing");
        const left = el.parentElement!.getBoundingClientRect().left;
        const move = (ev: PointerEvent) => {
          const next = ev.clientX - left;
          if (next <= SIDEBAR_HIDE_THRESHOLD) {
            clearTimeout(snapTimer);
            snapTimer = undefined;
            el.classList.remove("resizing");
            if (!useLayout.getState().hidden) setHidden(true);
            return;
          }
          if (next <= SIDEBAR_COLLAPSE_THRESHOLD) {
            clearTimeout(snapTimer);
            snapTimer = undefined;
            el.classList.remove("resizing");
            if (useLayout.getState().hidden) setHidden(false);
            if (!useLayout.getState().collapsed) setCollapsed(true);
            return;
          }
          const state = useLayout.getState();
          if (state.hidden || state.collapsed) {
            if (state.hidden) setHidden(false);
            if (state.collapsed) setCollapsed(false);
            setWidth(next);
            clearTimeout(snapTimer);
            snapTimer = setTimeout(() => el.classList.add("resizing"), 220);
            return;
          }
          setWidth(next);
        };
        const stop = () => {
          clearTimeout(snapTimer);
          el.classList.remove("dragging", "resizing");
          document.body.classList.remove("resizing");
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", stop);
          el.removeEventListener("pointercancel", stop);
          const state = useLayout.getState();
          if (state.hidden || state.collapsed) {
            setWidth(startWidth > SIDEBAR_COLLAPSE_THRESHOLD ? startWidth : null);
          }
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", stop);
        el.addEventListener("pointercancel", stop);
      }}
      onDoubleClick={() => {
        if (hidden) setHidden(false);
        if (collapsed) setCollapsed(false);
        setWidth(null);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowLeft") {
          if (hidden) return;
          if (collapsed) {
            setHidden(true);
          } else {
            const next = current() - step;
            if (next <= SIDEBAR_COLLAPSE_THRESHOLD) collapseToRail(current());
            else setWidth(next);
          }
        } else if (e.key === "ArrowRight") {
          if (hidden) {
            setHidden(false);
            setCollapsed(true);
          } else if (collapsed) {
            setCollapsed(false);
            setWidth(SIDEBAR_MIN);
          } else {
            setWidth(current() + step);
          }
        } else if (e.key === "Home") {
          if (hidden) setHidden(false);
          if (collapsed) setCollapsed(false);
          setWidth(null);
        } else return;
        e.preventDefault();
      }}
    />
  );
}

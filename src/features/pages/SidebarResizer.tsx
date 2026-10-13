import { useRef } from "react";
import { SIDEBAR_MAX, SIDEBAR_MIN, useLayout } from "../../stores/layout";

/** A draggable edge on the sidebar. Arrow keys nudge it; double-click or Home restores the default. */
export function SidebarResizer() {
  const width = useLayout((s) => s.width);
  const setWidth = useLayout((s) => s.setWidth);
  const ref = useRef<HTMLDivElement>(null);

  const current = () => ref.current?.parentElement?.querySelector<HTMLElement>(".sidebar")?.offsetWidth ?? width ?? 240;

  return (
    <div
      ref={ref}
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        document.body.classList.add("resizing");
        const left = el.parentElement!.getBoundingClientRect().left;
        const move = (ev: PointerEvent) => setWidth(ev.clientX - left);
        const stop = () => {
          document.body.classList.remove("resizing");
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", stop);
          el.removeEventListener("pointercancel", stop);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", stop);
        el.addEventListener("pointercancel", stop);
      }}
      onDoubleClick={() => setWidth(null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowLeft") setWidth(current() - step);
        else if (e.key === "ArrowRight") setWidth(current() + step);
        else if (e.key === "Home") setWidth(null);
        else return;
        e.preventDefault();
      }}
    />
  );
}

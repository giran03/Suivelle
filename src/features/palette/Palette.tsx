import { lazy, Suspense, useEffect, useRef } from "react";
import { usePalette } from "./store";
import { syncDialog } from "../../lib/dialog";

const PaletteBody = lazy(() => import("./PaletteBody").then(m => ({ default: m.PaletteBody })));
const ProjectTaskAction = lazy(() => import("./ProjectTaskAction").then(m => ({ default: m.ProjectTaskAction })));

/** Ctrl/Cmd+K overlay. A native <dialog> gives modal focus handling, Esc and focus restore. */
export function Palette() {
  const open = usePalette((s) => s.open);
  const task = usePalette(s => s.task);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    syncDialog(d, open);
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const stopBackgroundScroll = (event: WheelEvent | TouchEvent) => {
      if (!dialog.open) return;
      if (!(event.target instanceof Node) || event.target === dialog || !dialog.contains(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("wheel", stopBackgroundScroll, { capture: true, passive: false });
    window.addEventListener("touchmove", stopBackgroundScroll, { capture: true, passive: false });
    return () => {
      window.removeEventListener("wheel", stopBackgroundScroll, true);
      window.removeEventListener("touchmove", stopBackgroundScroll, true);
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="Search and commands"
      onKeyDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      onClose={() => usePalette.getState().hide()}
      onCancel={e => { e.preventDefault(); usePalette.getState().hide(); }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) usePalette.getState().hide();
      }}
    >
      {open && <Suspense fallback={<p className="palette-note" role="status">Loading commands…</p>}>{task ? <ProjectTaskAction /> : <PaletteBody />}</Suspense>}
    </dialog>
  );
}

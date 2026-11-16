import { lazy, Suspense, useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { PageGlyph } from "../pages/PageGlyph";
import type { Page } from "../../types";
import { ErrorBoundary } from "../../app/ErrorBoundary";
import { dockTargetAt, DRAG_CLASS, useDockHint } from "./dropOnSplit";
import { useSplit } from "./store";
import "../peek/peek.css";

const Editor = lazy(() => import("../editor/Editor").then((m) => ({ default: m.Editor })));
const DatabaseView = lazy(() => import("../database/DatabaseView").then((m) => ({ default: m.DatabaseView })));
const DashboardView = lazy(() => import("../dashboard/DashboardView").then((m) => ({ default: m.DashboardView })));
const RecordProperties = lazy(() => import("../database/RecordProperties").then((m) => ({ default: m.RecordProperties })));

/**
 * Lets a pane header be dragged to dock somewhere else. Once the drag starts the pane is lifted out of the
 * layout, so the others reflow and every edge is a clear drop target with its preview; a chip with the
 * pane's title follows the pointer. Dropping on an edge docks it there, on the middle swaps it with that
 * pane, and letting go anywhere else (or pressing Escape) puts it back exactly where it was.
 */
function useHeaderDrag(slot: number) {
  return (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const header = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let lifted: { layout: ReturnType<typeof useSplit.getState>["layout"]; tree: ReturnType<typeof useSplit.getState>["tree"]; panes: string[]; pageId: string } | null = null;
    let chip: HTMLElement | null = null;

    const lift = () => {
      const state = useSplit.getState();
      const pageId = state.panes[slot - 1];
      if (!pageId) return;
      lifted = { layout: state.layout, tree: state.tree, panes: state.panes, pageId };
      chip = document.createElement("div");
      chip.className = "pane-chip";
      chip.setAttribute("aria-hidden", "true");
      for (const child of Array.from(header.children)) if (!child.matches("button")) chip.append(child.cloneNode(true));
      document.body.append(chip);
      useSplit.getState().closePane(slot);
    };
    let lastX = startX;
    let lastY = startY;
    /** Moves the chip and points the drop preview at whatever is under the pointer, right here rather than via another listener. */
    const aim = () => {
      const next = dockTargetAt(lastX, lastY, true);
      const prev = useDockHint.getState().target;
      const same = prev === next || (!!prev && !!next && prev.slot === next.slot && prev.zone === next.zone && prev.rect.left === next.rect.left && prev.rect.top === next.rect.top && prev.rect.width === next.rect.width && prev.rect.height === next.rect.height);
      if (!same) useDockHint.setState({ target: next });
    };
    const follow = (ev: PointerEvent) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (chip) chip.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
      aim();
    };
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        document.body.classList.add(DRAG_CLASS, "split-moving");
        lift();
        // The panes reflow without animating while one is carried, so the preview's geometry is final at once.
        window.setTimeout(aim, 60);
      }
      follow(ev);
    };
    const finish = (ev: PointerEvent | KeyboardEvent, cancelled: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      const target = dragging && !cancelled && "clientX" in ev ? dockTargetAt(ev.clientX, ev.clientY, true) : null;
      document.body.classList.remove(DRAG_CLASS, "split-moving");
      useDockHint.setState({ target: null });
      chip?.remove();
      chip = null;
      const from = lifted;
      lifted = null;
      if (!from) return;
      const restore = () => useSplit.setState({ layout: from.layout, tree: from.tree, panes: from.panes });
      if (!target) { restore(); return; }
      if (target.zone === "center") {
        // Slots after the lifted pane were renumbered; map the one under the pointer back to its old number.
        const original = target.slot >= slot ? target.slot + 1 : target.slot;
        restore();
        useSplit.getState().swap(slot, original);
        return;
      }
      useSplit.getState().dock(from.pageId, target.slot, target.zone);
    };
    const up = (ev: PointerEvent) => finish(ev, false);
    const cancel = (ev: PointerEvent) => finish(ev, true);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape" && dragging) { ev.preventDefault(); ev.stopPropagation(); finish(ev, true); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };
}

/** One side pane of the split: a header to move or close it, and the page below, editable. */
export function SplitPane({ slot, pageId }: { slot: number; pageId: string }) {
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const epoch = useWorkspace((s) => s.dataEpoch);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [mapEpoch, setMapEpoch] = useState(0);
  const onHeaderDown = useHeaderDrag(slot);

  useEffect(() => {
    const refresh = (event: Event) => { if ((event as CustomEvent<string[]>).detail?.includes(pageId ?? "")) setMapEpoch((n) => n + 1); };
    window.addEventListener("suivelle:map-content-changed", refresh);
    return () => window.removeEventListener("suivelle:map-content-changed", refresh);
  }, [pageId]);

  useEffect(() => {
    let alive = true;
    setError("");
    setPage(null);
    void ipc.pageGet(pageId).then((p) => {
      if (!alive) return;
      // A page that was trashed or deleted closes its pane rather than showing a dead page.
      if (!p || p.deletedAt || p.workspaceId !== workspaceId) useSplit.getState().removePage(pageId);
      else setPage(p);
    }, (e) => { if (alive) setError(toAppError(e).message); });
    return () => { alive = false; };
  }, [pageId, workspaceId, epoch]);

  const title = page ? page.title || "Untitled" : "…";
  return (
    <section
      className="peek-panel split-pane"
      aria-label={`Pane ${slot + 1}: ${title}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !document.querySelector("dialog[open], [data-popover]")) useSplit.getState().closePane(slot);
      }}
    >
      <div className="peek-head split-head" onPointerDown={onHeaderDown} onDragStart={(e) => e.preventDefault()} title="Drag to move this pane">
        {page ? <PageGlyph page={page} size={18} /> : <Icon name="page" size={18} />}
        <span className="peek-title">{title}</span>
        <button type="button" className="icon-btn" aria-label="Open in the main view" title="Open in the main view" onClick={() => useSplit.getState().swap(slot, 0)}>
          <Icon name="open" size={16} />
        </button>
        <button type="button" className="icon-btn" aria-label="Close pane" title="Close pane" onClick={() => useSplit.getState().closePane(slot)}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="peek-body">
        {error && <p role="alert" className="error-text">{error}</p>}
        {page?.id === pageId && (
          <ErrorBoundary key={pageId} label="This pane could not be shown.">
            <Suspense fallback={<p role="status">Loading page…</p>}>
              {page.kind === "database" ? <DatabaseView key={pageId} pageId={pageId} />
                : page.kind === "dashboard" ? <DashboardView key={pageId} pageId={pageId} />
                : <>{page.kind === "record" && <RecordProperties pageId={pageId} />}<Editor key={`${pageId}:${mapEpoch}`} pageId={pageId} peek /></>}
            </Suspense>
          </ErrorBoundary>
        )}
      </div>
    </section>
  );
}

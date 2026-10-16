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

/** Lets a pane header be dragged onto another pane (or the main view) to trade places. */
function useHeaderDrag(slot: number) {
  return (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      dragging = true;
      document.body.classList.add(DRAG_CLASS, "split-moving");
    };
    const stop = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      const target = dragging && ev.type !== "pointercancel" ? dockTargetAt(ev.clientX, ev.clientY, true) : null;
      document.body.classList.remove(DRAG_CLASS, "split-moving");
      useDockHint.setState({ target: null });
      if (!target || target.slot === slot) return;
      const split = useSplit.getState();
      if (target.zone === "center") split.swap(slot, target.slot);
      else if (split.panes[slot - 1]) split.dock(split.panes[slot - 1], target.slot, target.zone);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
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
      <div className="peek-head split-head" onPointerDown={onHeaderDown} title="Drag to move this pane">
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

import { lazy, Suspense, useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { PageGlyph } from "../pages/PageGlyph";
import type { Page } from "../../types";
import { usePeek } from "./store";
import { ErrorBoundary } from "../../app/ErrorBoundary";
import "./peek.css";

const Editor = lazy(() => import("../editor/Editor").then((m) => ({ default: m.Editor })));
const DatabaseView = lazy(() => import("../database/DatabaseView").then((m) => ({ default: m.DatabaseView })));
const DashboardView = lazy(() => import("../dashboard/DashboardView").then((m) => ({ default: m.DashboardView })));
const RecordProperties = lazy(() => import("../database/RecordProperties").then((m) => ({ default: m.RecordProperties })));

/** A second page beside the open one, editable, for reading a reference while writing. */
export function PeekPanel() {
  const pageId = usePeek((s) => s.pageId);
  const selected = useWorkspace((s) => s.selectedPageId);
  const mainView = useWorkspace((s) => s.view);
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const epoch = useWorkspace((s) => s.dataEpoch);
  const [page, setPage] = useState<Page | null>(null);
  const [width, setWidth] = useState(50);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setError("");
    if (pageId) void ipc.pageGet(pageId).then((p) => {
      if (!alive) return;
      if (!p || p.deletedAt || p.workspaceId !== workspaceId) usePeek.getState().hide();
      else setPage(p);
    }, (e) => { if (alive) setError(toAppError(e).message); });
    return () => { alive = false; };
  }, [pageId, workspaceId, epoch]);
  // Opening the peeked page in the main view takes it out of the peek.
  useEffect(() => { if (pageId && selected === pageId && mainView === "page") usePeek.getState().hide(); }, [pageId, selected, mainView]);
  useEffect(() => {
    if (!pageId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("dialog[open], [data-popover]") && document.activeElement?.closest(".peek-panel")) usePeek.getState().hide(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageId]);
  if (!pageId || (selected === pageId && mainView === "page")) return null;
  return <>
    <div className="pane-resizer" role="separator" tabIndex={0} aria-label="Resize side-by-side panes" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(width)}
      onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setWidth((w) => Math.max(25, Math.min(75, w + (e.key === "ArrowLeft" ? 5 : -5)))); } }}
      onPointerDown={(e) => { if (e.button === 0) e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const r = e.currentTarget.parentElement!.getBoundingClientRect(); setWidth(Math.max(25, Math.min(75, (r.right - e.clientX) / r.width * 100))); }} />
    <aside className="peek-panel" style={{ width: `${width}%` }} aria-label={`Side pane: ${page?.title || "Untitled"}`}>
    <div className="peek-head">
      {page && <PageGlyph page={page} size={18} />}
      <span className="peek-title">{page ? page.title || "Untitled" : "…"}</span>
      <button type="button" className="icon-btn" aria-label="Open in the main view" title="Open in the main view" onClick={() => void useWorkspace.getState().openPage(pageId)}><Icon name="open" size={16} /></button>
      <button type="button" className="icon-btn" aria-label="Close side pane" title="Close side pane" onClick={() => usePeek.getState().hide()}><Icon name="close" size={16} /></button>
    </div>
    <div className="peek-body">
      {error && <p role="alert" className="error-text">{error}</p>}
      {page?.id === pageId && <ErrorBoundary key={pageId} label="This side pane could not be shown."><Suspense fallback={<p role="status">Loading page…</p>}>
        {page.kind === "database" ? <DatabaseView key={pageId} pageId={pageId} />
          : page.kind === "dashboard" ? <DashboardView key={pageId} pageId={pageId} />
          : <>{page.kind === "record" && <RecordProperties pageId={pageId} />}<Editor key={pageId} pageId={pageId} peek /></>}
      </Suspense></ErrorBoundary>}
    </div>
  </aside></>;
}

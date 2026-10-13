import { lazy, Suspense, useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { PageGlyph } from "../pages/PageGlyph";
import type { Page } from "../../types";
import { usePeek } from "./store";
import "./peek.css";

const Editor = lazy(() => import("../editor/Editor").then((m) => ({ default: m.Editor })));

/** A second page beside the open one, editable, for reading a reference while writing. */
export function PeekPanel() {
  const pageId = usePeek((s) => s.pageId);
  const selected = useWorkspace((s) => s.selectedPageId);
  const [page, setPage] = useState<Page | null>(null);
  useEffect(() => { setPage(null); if (pageId) void ipc.pageGet(pageId).then(setPage, () => usePeek.getState().hide()); }, [pageId]);
  // Opening the peeked page in the main view takes it out of the peek.
  useEffect(() => { if (pageId && selected === pageId) usePeek.getState().hide(); }, [pageId, selected]);
  useEffect(() => {
    if (!pageId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("dialog[open], [data-popover]") && document.activeElement?.closest(".peek-panel")) usePeek.getState().hide(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageId]);
  if (!pageId) return null;
  const editable = !page || page.kind === "page" || page.kind === "record";
  return <aside className="peek-panel" aria-label={`Side peek: ${page?.title || "Untitled"}`}>
    <div className="peek-head">
      {page && <PageGlyph page={page} size={18} />}
      <span className="peek-title">{page ? page.title || "Untitled" : "…"}</span>
      <button type="button" className="icon-btn" aria-label="Open in the main view" title="Open in the main view" onClick={() => void useWorkspace.getState().openPage(pageId)}><Icon name="open" size={16} /></button>
      <button type="button" className="icon-btn" aria-label="Close side peek" title="Close side peek" onClick={() => usePeek.getState().hide()}><Icon name="close" size={16} /></button>
    </div>
    <div className="peek-body">
      {editable
        ? <Suspense fallback={null}><Editor key={pageId} pageId={pageId} peek /></Suspense>
        : <p className="picker-muted">Databases and dashboards open in the main view.</p>}
    </div>
  </aside>;
}

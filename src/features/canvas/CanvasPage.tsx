import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { ErrorBoundary } from "../../app/ErrorBoundary";
import { READ_ONLY } from "../../lib/access";
import { thumbUrl } from "../../lib/attachments";
import { toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";
import { registerFlusher } from "../editor/flushRegistry";
import { PageGlyph } from "../pages/PageGlyph";
import { gradientCss, parseCover } from "../pages/pageAppearance";
const Editor = lazy(() => import("../editor/Editor").then(m => ({ default: m.Editor })));
const DatabaseView = lazy(() => import("../database/DatabaseView").then(m => ({ default: m.DatabaseView })));
const DashboardView = lazy(() => import("../dashboard/DashboardView").then(m => ({ default: m.DashboardView })));
const RecordProperties = lazy(() => import("../database/RecordProperties").then(m => ({ default: m.RecordProperties })));

/** A real page editor, with the header left available for moving its canvas panel. */
export function CanvasPage({ page, onOpen }: { page: Page; onOpen: () => void }) {
  const [title, setTitle] = useState(page.title), [error, setError] = useState("");
  const value = useRef(title), saved = useRef(page.title), timer = useRef<number | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve()); value.current = title;
  const body = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(false);
  const cover = parseCover(page.cover);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const next = value.current;
    if (READ_ONLY || next === saved.current) return chain.current;
    chain.current = chain.current.catch(() => {}).then(async () => {
      if (next === saved.current) return;
      try { await useWorkspace.getState().renamePage(page.id, next, { strict: true }); saved.current = next; setError(""); }
      catch (e) { setError(toAppError(e).message); throw e; }
    });
    return chain.current;
  }, [page.id]);
  useEffect(() => registerFlusher(flush), [flush]);
  useEffect(() => () => { void flush().catch(() => {}); }, [flush]);
  useEffect(() => { if (value.current === saved.current) { saved.current = page.title; setTitle(page.title); } }, [page.title]);
  useEffect(() => {
    if (!body.current || !("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: body.current.closest(".canvas-view"), rootMargin: "300px" });
    observer.observe(body.current); return () => observer.disconnect();
  }, []);
  return <>
    <div className="cv-card-head cv-page-head" title="Drag the header to move this page">
      <span className="cv-page-grip" aria-hidden="true"><Icon name="grip" size={14} /></span>
      <span className="cv-page-glyph"><PageGlyph page={page} /></span>
      <input className="cv-page-title" aria-label="Page title" value={title} placeholder="Untitled" readOnly={READ_ONLY} maxLength={200}
        onChange={e => { setTitle(e.target.value); value.current = e.target.value; clearTimeout(timer.current); timer.current = window.setTimeout(() => void flush().catch(() => {}), 500); }}
        onBlur={() => void flush().catch(() => {})} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.closest(".cv-item")?.querySelector<HTMLElement>(".doc")?.focus(); } }} />
      <button type="button" className="icon-btn cv-open" aria-label={`Open ${title || "Untitled"}`} onClick={onOpen}><Icon name="forward" size={14} /></button>
    </div>
    <div ref={body} className="cv-page-body" data-canvas-editor data-context-page={page.id} aria-label={`Page: ${title || "Untitled"}`}>
      {error && <p role="alert" className="error save-error">{error} <button type="button" onClick={() => void flush().catch(() => {})}>Retry</button></p>}
      {cover && <div className="cv-page-cover">{cover.kind === "gradient" ? <div style={{ background: gradientCss(cover.id) }} /> : <img src={thumbUrl(cover.hash, 1280)} alt="" />}</div>}
      {visible ? <ErrorBoundary label="This canvas page could not be shown."><Suspense fallback={<p role="status">Loading page…</p>}>
        {page.kind === "database" ? <DatabaseView pageId={page.id} /> : page.kind === "dashboard" ? <DashboardView pageId={page.id} /> : <>
          {page.kind === "record" && <RecordProperties pageId={page.id} />}<Editor pageId={page.id} peek />
        </>}
      </Suspense></ErrorBoundary> : <p className="cv-page-loading" role="status">Loading page…</p>}
    </div>
  </>;
}

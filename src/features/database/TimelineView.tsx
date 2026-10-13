import { useMemo, useRef, useState } from "react";
import { READ_ONLY } from "../../lib/access";
import { ContextMenu } from "../../components/ContextMenu";
import { recordItems } from "./recordMenu";
import { Icon } from "../../components/Icon";
import { Popover, anchorOf, type Anchor } from "../../components/Popover";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { DbView, RecordRow } from "../../types";
import { addDays, daysBetween, daysOf, resizeSpan, shiftSpan, spanOf, todayIso, ZOOM, type DateSpan, type Zoom } from "./calendar";
import { formatWhen } from "./model";
import type { useDatabase } from "./useDatabase";
import { usePagedRecords } from "./usePagedRecords";

type Db = ReturnType<typeof useDatabase>;
type Drag = { id: string; mode: "move" | "start" | "end"; x0: number; delta: number; moved: boolean };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TITLE_W = 200;

/** Date ranges as bars over a scrollable window of days. Drag a bar to move it, its ends to resize. */
export function TimelineView({ db, view, queryVersion }: { db: Db; view: DbView; queryVersion: number }) {
  const databaseId = db.detail!.database.id;
  const prop = db.byId.get(view.config.datePropertyId ?? "");
  const zoom = (view.config.zoom as Zoom | null | undefined) ?? "month";
  const { px, span: spanDays } = ZOOM[zoom];
  const today = todayIso();
  const [menu, setMenu] = useState<{ x: number; y: number; row: RecordRow } | null>(null);
  const [start, setStart] = useState(() => addDays(today, -Math.round(ZOOM[(view.config.zoom as Zoom) ?? "month"].span / 4)));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pick, setPick] = useState<{ row: RecordRow; anchor: Anchor } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const openPage = useWorkspace((s) => s.openPage);
  const setError = useWorkspace((s) => s.setError);
  const valid = prop?.type === "date";
  const end = addDays(start, spanDays - 1);

  const dated = usePagedRecords({ databaseId, viewId: view.id, queryVersion, range: valid ? { propertyId: prop.id, from: start, to: end } : null, pageSize: 200, loadAll: true, enabled: valid });
  const undated = usePagedRecords({ databaseId, viewId: view.id, queryVersion, range: valid ? { propertyId: prop.id } : null, pageSize: 200, loadAll: true, enabled: valid });

  const ticks = useMemo(() => {
    const out: { day: string; label: string; major: boolean }[] = [];
    for (let i = 0; i < spanDays; i++) {
      const day = addDays(start, i);
      const dom = Number(day.slice(8));
      if (zoom === "week") out.push({ day, label: String(dom), major: dom === 1 });
      else if (zoom === "month") {
        if (new Date(`${day}T00:00:00Z`).getUTCDay() === 1) out.push({ day, label: String(dom), major: dom <= 7 });
      } else if (dom === 1) out.push({ day, label: MONTHS[Number(day.slice(5, 7)) - 1], major: day.slice(5, 7) === "01" });
    }
    return out;
  }, [start, spanDays, zoom]);

  if (!valid) return null;

  const reloadAll = () => {
    dated.reload();
    undated.reload();
  };

  const save = async (row: RecordRow, value: DateSpan) => {
    try {
      await ipc.recordSetValue(row.id, prop.id, value);
      reloadAll();
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  const apply = (span: DateSpan, mode: Drag["mode"], delta: number): DateSpan =>
    mode === "move" ? shiftSpan(span, delta) : resizeSpan(span, mode, delta);

  const begin = (e: React.PointerEvent, row: RecordRow, mode: Drag["mode"]) => {
    if (READ_ONLY) return;
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const d = { id: row.id, mode, x0: e.clientX, delta: 0, moved: false };
    dragRef.current = d;
    setDrag(d);
  };
  const move = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    const next = { ...d, delta: Math.round(dx / px), moved: d.moved || Math.abs(dx) > 3 };
    dragRef.current = next;
    setDrag(next);
  };
  const finish = (row: RecordRow, span: DateSpan) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    if (!d.moved) return void openPage(row.pageId);
    if (d.delta !== 0) void save(row, apply(span, d.mode, d.delta));
  };

  const shiftWindow = (dir: -1 | 1) => setStart(addDays(start, dir * Math.round(spanDays / 2)));
  const width = spanDays * px;
  const todayX = daysBetween(start, today) * px;

  return (
    <div className="timeline">
      <div className="cal-nav" role="group" aria-label="Timeline range">
        <button type="button" className="icon-btn" aria-label="Earlier" onClick={() => shiftWindow(-1)}>
          <Icon name="back" />
        </button>
        <button type="button" className="icon-btn" aria-label="Later" onClick={() => shiftWindow(1)}>
          <Icon name="forward" />
        </button>
        <h2 className="cal-title" aria-live="polite">
          {formatWhen(start)} – {formatWhen(end)}
        </h2>
        <button type="button" className="btn" onClick={() => setStart(addDays(today, -Math.round(spanDays / 4)))}>
          Today
        </button>
        {dated.truncated && <span className="picker-muted">Showing the first 1,000 records in this range.</span>}
      </div>
      {(dated.error || undated.error) && (
        <p className="error-text" role="alert">
          {dated.error ?? undated.error}{" "}
          <button type="button" className="link" onClick={reloadAll}>
            Try again
          </button>
        </p>
      )}
      <div className="tl-scroll" role="region" aria-label="Timeline" tabIndex={0}>
        <div className="tl-inner" style={{ width: TITLE_W + width }}>
          <div className="tl-head">
            <div className="tl-title tl-corner">Record</div>
            <div className="tl-track" style={{ width }}>
              {ticks.map((t) => (
                <span key={t.day} className={`tl-tick${t.major ? " major" : ""}`} style={{ left: daysBetween(start, t.day) * px }}>
                  {t.label}
                </span>
              ))}
            </div>
          </div>
          {dated.rows.length === 0 && dated.done && <p className="picker-muted tl-empty">No records are dated in this range.</p>}
          {dated.rows.map((row) => {
            const span = spanOf(row.values[prop.id]);
            if (!span) return null;
            const live = drag?.id === row.id ? apply(span, drag.mode, drag.delta) : span;
            const { first, last } = daysOf(live);
            const left = daysBetween(start, first) * px;
            const w = (daysBetween(first, last) + 1) * px;
            return (
              <div key={row.id} className="tl-row" onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, row }); }}>
                <div className="tl-title" title={row.title || "Untitled"}>
                  {row.title || <span className="cell-placeholder">Untitled</span>}
                </div>
                <div className="tl-track" style={{ width }}>
                  <div
                    className={`tl-bar${drag?.id === row.id ? " dragging" : ""}`}
                    style={{ left, width: Math.max(w, 10) }}
                    role="button"
                    tabIndex={0}
                    aria-label={`${row.title || "Untitled"}, ${formatWhen(live.start)}${live.end ? ` to ${formatWhen(live.end)}` : ""}. Enter opens. Arrow keys move; Shift with arrows changes the end.`}
                    onPointerDown={(e) => begin(e, row, "move")}
                    onClick={() => { if (READ_ONLY) void openPage(row.pageId); }}
                    onPointerMove={move}
                    onPointerUp={() => finish(row, span)}
                    onPointerCancel={() => (dragRef.current = null, setDrag(null))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") return void openPage(row.pageId);
                      if (READ_ONLY) return;
                      const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
                      if (!dir) return;
                      e.preventDefault();
                      void save(row, apply(span, e.shiftKey ? "end" : "move", dir));
                    }}
                  >
                    <span className="tl-handle start" onPointerDown={(e) => (e.stopPropagation(), begin(e, row, "start"))} onPointerMove={move} onPointerUp={() => finish(row, span)} />
                    <span className="tl-bar-label">{row.title || "Untitled"}</span>
                    <span className="tl-handle end" onPointerDown={(e) => (e.stopPropagation(), begin(e, row, "end"))} onPointerMove={move} onPointerUp={() => finish(row, span)} />
                  </div>
                </div>
              </div>
            );
          })}
          {todayX >= 0 && todayX <= width && <div className="tl-today" style={{ left: TITLE_W + todayX + px / 2 }} aria-hidden="true" />}
        </div>
      </div>
      {undated.rows.length > 0 && (
        <section className="tl-undated" aria-label="Records with no date">
          <h3>No date</h3>
          <ul>
            {undated.rows.map((r) => (
              <li key={r.id} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, row: r }); }}>
                <button type="button" className="link" onClick={() => void openPage(r.pageId)}>
                  {r.title || "Untitled"}
                </button>
                <button type="button" className="btn" onClick={(e) => setPick({ row: r, anchor: anchorOf(e.currentTarget) })}>
                  Add to timeline
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={[...recordItems(menu.row, reloadAll).slice(0, -1), { label: "Change date…", onSelect: () => setPick({ row: menu.row, anchor: { left: menu.x, right: menu.x, top: menu.y, bottom: menu.y } }) }, ...recordItems(menu.row, reloadAll).slice(-1)]} onClose={() => setMenu(null)} />}
      {pick && (
        <Popover anchor={pick.anchor} onClose={() => setPick(null)} label="Start date" className="picker">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget).get("start");
              if (typeof v === "string" && v) {
                void save(pick.row, { start: v });
                setPick(null);
              }
            }}
          >
            <label className="field">
              <span>Start date</span>
              <input name="start" type="date" defaultValue={today} required />
            </label>
            <div className="picker-actions">
              <button type="button" className="btn" onClick={() => setPick(null)}>
                Cancel
              </button>
              <button type="submit" className="btn primary">
                Add
              </button>
            </div>
          </form>
        </Popover>
      )}
    </div>
  );
}

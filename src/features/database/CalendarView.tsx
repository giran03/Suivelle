import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { useMemo, useState } from "react";
import { READ_ONLY } from "../../lib/access";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { Icon } from "../../components/Icon";
import { type Anchor } from "../../components/Popover";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { DbView, RecordRow } from "../../types";
import { addDays, addMonths, daysBetween, daysOf, monthGrid, monthOf, monthTitle, shiftSpan, spanOf, todayIso } from "./calendar";
import { copyPageLink } from "../pages/pageMenu";
import { DateEditor } from "./editors";
import { formatWhen } from "./model";
import type { useDatabase } from "./useDatabase";
import { usePagedRecords } from "./usePagedRecords";

type Db = ReturnType<typeof useDatabase>;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SHOWN = 3;

function Chip({ row, day, onOpen, onMenu }: { row: RecordRow; day: string | null; onOpen: () => void; onMenu: (e: { clientX: number; clientY: number }) => void }) {
  const drag = useDraggable({ id: `chip:${row.id}:${day ?? "none"}`, data: { row, day }, disabled: READ_ONLY });
  return (
    <div ref={drag.setNodeRef} {...drag.listeners} className={`cal-chip${drag.isDragging ? " dragging" : ""}`} onContextMenu={(e) => (e.preventDefault(), onMenu(e))}>
      <button type="button" className="cal-chip-title" onClick={onOpen} title={row.title || "Untitled"}>
        {row.title || <span className="cell-placeholder">Untitled</span>}
      </button>
      <button type="button" className="icon-btn cal-chip-menu" aria-label={`Actions for ${row.title || "Untitled"}`} onPointerDown={(e) => e.stopPropagation()} onClick={onMenu}>
        <Icon name="more" size={12} />
      </button>
    </div>
  );
}

function Day({ day, inMonth, today, onCreate, children }: { day: string; inMonth: boolean; today: boolean; onCreate: () => void; children: React.ReactNode }) {
  const drop = useDroppable({ id: `day:${day}` });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div onContextMenu={(e) => { if (e.defaultPrevented) return; e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }} ref={drop.setNodeRef} role="cell" aria-label={new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(new Date(`${day}T12:00:00`))} className={`cal-day${inMonth ? "" : " outside"}${today ? " today" : ""}${drop.isOver ? " over" : ""}`}>
      <div className="cal-day-head">
        <span className="cal-num" aria-current={today ? "date" : undefined}>
          {Number(day.slice(8))}
        </span>
        <button type="button" className="icon-btn cal-new" aria-label={`New record on ${formatWhen(day)}`} onClick={onCreate}>
          <Icon name="plus" size={12} />
        </button>
      </div>
      {children}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={[{ label: `New record on ${formatWhen(day)}`, onSelect: onCreate }]} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** A month of records placed by a date property. Dragging a chip to another day moves its date. */
export function CalendarView({ db, view, queryVersion }: { db: Db; view: DbView; queryVersion: number }) {
  const databaseId = db.detail!.database.id;
  const prop = db.byId.get(view.config.datePropertyId ?? "");
  const [month, setMonth] = useState(() => monthOf(todayIso()));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: RecordRow } | null>(null);
  const [editing, setEditing] = useState<{ row: RecordRow; anchor: Anchor } | null>(null);
  const [dragging, setDragging] = useState<RecordRow | null>(null);
  const openPage = useWorkspace((s) => s.openPage);
  const setError = useWorkspace((s) => s.setError);
  const notify = useWorkspace((s) => s.notify);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const days = useMemo(() => monthGrid(month), [month]);
  const valid = prop?.type === "date";

  const dated = usePagedRecords({
    databaseId,
    viewId: view.id,
    queryVersion,
    range: valid ? { propertyId: prop.id, from: days[0], to: days[41] } : null,
    pageSize: 200,
    loadAll: true,
    enabled: valid,
  });
  const undated = usePagedRecords({ databaseId, viewId: view.id, queryVersion, range: valid ? { propertyId: prop.id } : null, pageSize: 200, loadAll: true, enabled: valid });

  const byDay = useMemo(() => {
    const map = new Map<string, RecordRow[]>();
    if (!prop) return map;
    for (const row of dated.rows) {
      const span = spanOf(row.values[prop.id]);
      if (!span) continue;
      const { first, last } = daysOf(span);
      for (let d = first < days[0] ? days[0] : first; d <= last && d <= days[41]; d = addDays(d, 1)) {
        map.set(d, [...(map.get(d) ?? []), row]);
      }
    }
    return map;
  }, [dated.rows, prop, days]);

  if (!valid) return null;

  const reloadAll = () => {
    dated.reload();
    undated.reload();
  };

  const save = async (row: RecordRow, value: unknown) => {
    try {
      await ipc.recordSetValue(row.id, prop.id, value);
      reloadAll();
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const row = e.active.data.current?.row as RecordRow | undefined;
    const from = e.active.data.current?.day as string | null | undefined;
    const over = e.over ? String(e.over.id) : "";
    if (!row || !over.startsWith("day:")) return;
    const to = over.slice(4);
    const span = spanOf(row.values[prop.id]);
    if (!span) return void save(row, { start: to });
    const delta = daysBetween(from ?? daysOf(span).first, to);
    if (delta !== 0) void save(row, shiftSpan(span, delta));
  };

  const create = async (day: string) => {
    try {
      const row = await ipc.recordCreate({ databaseId, values: { [prop.id]: { start: day } } });
      await openPage(row.pageId);
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  const items = (row: RecordRow, at: { x: number; y: number }): MenuItem[] => [
    { label: "Open", onSelect: () => void openPage(row.pageId) },
    { label: "Copy link", shortcut: "copy-link", onSelect: () => void copyPageLink(row.pageId) },
    { label: "Duplicate", shortcut: "duplicate", onSelect: async () => { try { await ipc.recordDuplicate(row.id); reloadAll(); } catch (error) { setError(toAppError(error).message); } } },
    { label: "Change date…", onSelect: () => setEditing({ row, anchor: { left: at.x, top: at.y, right: at.x, bottom: at.y + 2 } }) },
    {
      label: "Move to trash",
      danger: true,
      separated: true,
      onSelect: async () => {
        try {
          await ipc.pageDelete(row.pageId);
          reloadAll();
          notify(`Moved “${row.title || "Untitled"}” to trash`, async () => {
            await ipc.pageRestore(row.pageId);
            reloadAll();
          });
        } catch (e) {
          setError(toAppError(e).message);
        }
      },
    },
  ];

  const today = todayIso();
  const chipFor = (row: RecordRow, day: string | null) => (
    <Chip
      key={`${row.id}:${day}`}
      row={row}
      day={day}
      onOpen={() => void openPage(row.pageId)}
      onMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, row })}
    />
  );

  return (
    <div className="calendar">
      <div className="cal-nav" role="group" aria-label="Month">
        <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
          <Icon name="back" />
        </button>
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
          <Icon name="forward" />
        </button>
        <h2 className="cal-title" aria-live="polite">
          {monthTitle(month)}
        </h2>
        <button type="button" className="btn" onClick={() => setMonth(monthOf(today))}>
          Today
        </button>
        {dated.truncated && <span className="picker-muted">Showing the first 1,000 records of this month.</span>}
      </div>
      {(dated.error || undated.error) && (
        <p className="error-text" role="alert">
          {dated.error ?? undated.error}{" "}
          <button type="button" className="link" onClick={reloadAll}>
            Try again
          </button>
        </p>
      )}
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={(e) => setDragging((e.active.data.current?.row as RecordRow) ?? null)} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        <div className="cal-body">
          <div className="cal-grid" role="table" aria-label={monthTitle(month)} aria-busy={dated.loading}>
            <div className="cal-weekdays" role="row">
              {WEEKDAYS.map((d) => (
                <div key={d} role="columnheader">
                  {d}
                </div>
              ))}
            </div>
            <div className="cal-weeks" role="rowgroup">
              {Array.from({ length: 6 }, (_, week) => <div className="cal-week" role="row" key={week}>
              {days.slice(week * 7, week * 7 + 7).map((day) => {
                const rows = byDay.get(day) ?? [];
                const open = expanded === day;
                const shown = open ? rows : rows.slice(0, SHOWN);
                return (
                  <Day key={day} day={day} inMonth={monthOf(day) === month} today={day === today} onCreate={() => void create(day)}>
                    {shown.map((r) => chipFor(r, day))}
                    {rows.length > SHOWN && (
                      <button type="button" className="cal-more" aria-expanded={open} onClick={() => setExpanded(open ? null : day)}>
                        {open ? "Show less" : `+${rows.length - SHOWN} more`}
                      </button>
                    )}
                  </Day>
                );
              })}
              </div>)}
            </div>
          </div>
          <aside className="cal-undated" aria-label="Records with no date">
            <h3>No date</h3>
            {undated.rows.length === 0 ? <p className="picker-muted">Every record has a date.</p> : <p className="picker-muted">Drag onto a day to set its date.</p>}
            {undated.rows.map((r) => chipFor(r, null))}
            {undated.truncated && <p className="picker-muted">Showing the first 1,000.</p>}
          </aside>
        </div>
        <DragOverlay dropAnimation={null}>{dragging && <div className="cal-chip overlay">{dragging.title || "Untitled"}</div>}</DragOverlay>
      </DndContext>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items(menu.row, menu)} onClose={() => setMenu(null)} />}
      {editing && (
        <DateEditor
          current={editing.row.values[prop.id]}
          anchor={editing.anchor}
          onChange={(v) => void save(editing.row, v)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

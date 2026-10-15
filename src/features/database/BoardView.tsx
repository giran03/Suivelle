import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { READ_ONLY } from "../../lib/access";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { copyPageLink } from "../pages/pageMenu";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { DbView, GroupCount, Property, RecordRow } from "../../types";
import { CardProp } from "./cells";
import { GroupLabel } from "./GroupLabel";
import { groupLabel, valueForGroup } from "./groups";
import { isEmptyValue } from "./model";
import type { useDatabase } from "./useDatabase";
import { useExtraFilter, useStable } from "./extraFilter";
import { TaskScheduleHandle } from "../calendar/taskDrag";

const CARD_PAGE = 30;
const MAX_CARD_PROPS = 6;

type Db = ReturnType<typeof useDatabase>;

interface Cell {
  rows: RecordRow[];
  next: string | null;
  loading: boolean;
}

const cellKey = (g: string, s?: string | null) => `${g}|${s ?? ""}`;

/** Group counts plus a paged list of cards per column (and lane). Counts are known up front, so empty cells never fetch. */
export function useBoard(databaseId: string, view: DbView, queryVersion: number) {
  const extraFilter = useStable(useExtraFilter());
  const [groups, setGroups] = useState<GroupCount[] | null>(null);
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const viewId = view.id;
  const grouped = !!view.config.group;

  const fetchCell = useCallback(
    async (g: string, s: string | null, more: boolean, mine: number) => {
      const key = cellKey(g, s);
      const cur = cellsRef.current[key];
      if (cur?.loading || (more && !cur?.next)) return;
      setCells((c) => ({ ...c, [key]: { rows: more ? (c[key]?.rows ?? []) : [], next: more ? (c[key]?.next ?? null) : null, loading: true } }));
      try {
        const res = await ipc.queryRecords({ databaseId, viewId, groupKey: g, subgroupKey: s, cursor: more ? cur?.next : null, limit: CARD_PAGE, skipTotal: true, extraFilter });
        if (mine !== gen.current) return;
        setCells((c) => ({ ...c, [key]: { rows: more ? [...(c[key]?.rows ?? []), ...res.rows] : res.rows, next: res.nextCursor, loading: false } }));
      } catch (e) {
        if (mine !== gen.current) return;
        setError(toAppError(e).message);
        setCells((c) => ({ ...c, [key]: { rows: c[key]?.rows ?? [], next: c[key]?.next ?? null, loading: false } }));
      }
    },
    [databaseId, viewId, extraFilter],
  );

  const reload = useCallback(() => {
    const mine = ++gen.current;
    setCells({});
    setGroups(null);
    setError(null);
    if (!grouped) return;
    ipc
      .groupCounts(databaseId, viewId, extraFilter)
      .then(async (gs) => {
        if (mine !== gen.current) return;
        setGroups(gs);
        const cells: [string, string | null][] = [];
        for (const g of gs) {
          if (g.subgroups.length) g.subgroups.filter((s) => s.count > 0).forEach((s) => cells.push([g.key, s.key]));
          else if (g.count > 0) cells.push([g.key, null]);
        }
        for (let i = 0; i < cells.length; i += 4) {
          if (mine !== gen.current) return;
          await Promise.all(cells.slice(i, i + 4).map(([g, s]) => fetchCell(g, s, false, mine)));
        }
      })
      .catch((e) => mine === gen.current && setError(toAppError(e).message));
  }, [databaseId, viewId, grouped, fetchCell, extraFilter]);

  useEffect(() => {
    reload();
    return () => { gen.current++; };
  }, [reload, queryVersion]);

  const loadMore = useCallback((g: string, s: string | null) => void fetchCell(g, s, true, gen.current), [fetchCell]);

  const adjust = (g: string, s: string | null, by: number) =>
    setGroups((all) =>
      all?.map((x) =>
        x.key !== g ? x : { ...x, count: x.count + by, subgroups: x.subgroups.map((y) => (s !== null && y.key === s ? { ...y, count: y.count + by } : y)) },
      ) ?? null,
    );

  /** Optimistically moves a card between cells; the caller saves the change. */
  const moveCard = (row: RecordRow, from: [string, string | null], to: [string, string | null]) => {
    setCells((c) => {
      const fk = cellKey(...from);
      const tk = cellKey(...to);
      return {
        ...c,
        [fk]: { ...(c[fk] ?? { rows: [], next: null, loading: false }), rows: (c[fk]?.rows ?? []).filter((r) => r.id !== row.id) },
        [tk]: { ...(c[tk] ?? { rows: [], next: null, loading: false }), rows: [row, ...(c[tk]?.rows ?? [])] },
      };
    });
    adjust(from[0], from[1], -1);
    adjust(to[0], to[1], 1);
  };

  const addCard = (g: string, s: string | null, row: RecordRow) => {
    setCells((c) => ({ ...c, [cellKey(g, s)]: { ...(c[cellKey(g, s)] ?? { next: null, loading: false }), rows: [row, ...(c[cellKey(g, s)]?.rows ?? [])] } }));
    adjust(g, s, 1);
  };

  const replaceRow = (row: RecordRow) =>
    setCells((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { ...v, rows: v.rows.map((r) => (r.id === row.id ? row : r)) }])));

  return { groups, cells, error, reload, loadMore, moveCard, addCard, replaceRow };
}

// ---------------------------------------------------------------------------------------------

function Card({
  row,
  props,
  editing,
  draggable,
  onOpen,
  onMenu,
  onTitle,
}: {
  row: RecordRow;
  props: Property[];
  editing: boolean;
  draggable: boolean;
  onOpen: () => void;
  onMenu: (e: { clientX: number; clientY: number }) => void;
  onTitle: (title: string) => void;
}) {
  const drag = useDraggable({ id: `card:${row.id}`, data: { row }, disabled: READ_ONLY || !draggable || editing });
  const shown = props.filter((p) => !isEmptyValue(row.values[p.id]) || ["unique_id", "created_time", "updated_time"].includes(p.type)).slice(0, MAX_CARD_PROPS);
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.listeners}
      className={`card${drag.isDragging ? " dragging" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e);
      }}
    >
      {editing ? (
        <input
          className="card-input"
          autoFocus
          aria-label="Card title"
          defaultValue={row.title}
          placeholder="Untitled"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
          }}
          onBlur={(e) => onTitle(e.currentTarget.value)}
        />
      ) : (
        <button type="button" className="card-title" onClick={onOpen}>
          {row.title || <span className="cell-placeholder">Untitled</span>}
        </button>
      )}
      {!editing && (
        <TaskScheduleHandle row={row} />
      )}
      {!editing && (
        <button type="button" className="icon-btn card-menu" aria-label={`Actions for ${row.title || "Untitled"}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => onMenu(e)}>
          <Icon name="more" />
        </button>
      )}
      {shown.length > 0 && (
        <div className="card-props">
          {shown.map((p) => (
            <div key={p.id} className="card-prop" title={p.name}>
              <CardProp prop={p} row={row} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Column({
  id,
  droppable,
  cell,
  count,
  children,
  onMore,
}: {
  id: string;
  droppable: boolean;
  cell: Cell | undefined;
  count: number;
  children: React.ReactNode;
  onMore: () => void;
}) {
  const drop = useDroppable({ id, disabled: !droppable });
  return (
    <div ref={drop.setNodeRef} className={`col-cards${drop.isOver ? " over" : ""}`}>
      {children}
      {cell?.loading && !cell.rows.length && count > 0 && <div className="card skeleton" aria-hidden="true" />}
      {cell?.next && (
        <button type="button" className="load-more" disabled={cell.loading} onClick={onMore}>
          {cell.loading ? "Loading…" : `Show more (${count - cell.rows.length})`}
        </button>
      )}
    </div>
  );
}

export function BoardView({ db, view, queryVersion }: { db: Db; view: DbView; queryVersion: number }) {
  const databaseId = db.detail!.database.id;
  const board = useBoard(databaseId, view, queryVersion);
  const setError = useWorkspace((s) => s.setError);
  const notify = useWorkspace((s) => s.notify);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragging, setDragging] = useState<RecordRow | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: RecordRow; at: [string, string | null] } | null>(null);
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(new Set());

  const cfg = view.config;
  const groupProp = db.byId.get(cfg.group?.propertyId ?? "");
  const subProp = db.byId.get(cfg.subgroup?.propertyId ?? "");
  const cardProps = db.columns.map((c) => c.property).filter((p) => p.type !== "title" && p.id !== cfg.group?.propertyId && p.id !== cfg.subgroup?.propertyId);
  const canDrag = !!groupProp && !!valueForGroup(groupProp, "x") && (!subProp || !!valueForGroup(subProp, "x"));

  if (!cfg.group || !groupProp) {
    const options = db.detail!.properties.filter((p) => ["status", "select", "checkbox", "date"].includes(p.type));
    return (
      <div className="view-empty">
        <p>A board needs a property to make columns from.</p>
        <select aria-label="Group board by" value="" onChange={(e) => e.target.value && db.updateView({ group: { propertyId: e.target.value, bucket: db.byId.get(e.target.value)?.type === "date" ? "month" : null } }, { rows: true })}>
          <option value="">Choose a property…</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {options.length === 0 && <p className="picker-muted">Add a Status or Select property first.</p>}
      </div>
    );
  }

  const groups = board.groups ?? [];
  const lanes = cfg.subgroup ? (groups[0]?.subgroups ?? []) : [];

  const saveValues = async (row: RecordRow, g: string, s: string | null, from: [string, string | null]) => {
    try {
      let updated = row;
      const gv = valueForGroup(groupProp, g);
      if (gv && g !== from[0]) updated = await ipc.recordSetValue(updated.id, groupProp.id, gv.value);
      const sv = subProp && s !== null ? valueForGroup(subProp, s) : undefined;
      if (sv && subProp && s !== from[1]) updated = await ipc.recordSetValue(updated.id, subProp.id, sv.value);
      board.replaceRow(updated);
    } catch (e) {
      setError(toAppError(e).message);
      board.reload();
    }
  };

  const move = (row: RecordRow, from: [string, string | null], to: [string, string | null]) => {
    if (from[0] === to[0] && from[1] === to[1]) return;
    board.moveCard(row, from, to);
    void saveValues(row, to[0], to[1], from);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const row = e.active.data.current?.row as RecordRow | undefined;
    const fromKey = (e.active.data.current as { at?: [string, string | null] } | undefined)?.at;
    const overId = e.over ? String(e.over.id) : null;
    if (!row || !overId?.startsWith("col:")) return;
    const [g, s] = overId.slice(4).split("|");
    const at = fromKey ?? findCell(row.id);
    if (at) move(row, at, [g, s === "" ? null : s]);
  };

  const findCell = (rowId: string): [string, string | null] | null => {
    for (const [k, c] of Object.entries(board.cells)) {
      if (c.rows.some((r) => r.id === rowId)) {
        const [g, s] = k.split("|");
        return [g, s === "" ? null : s];
      }
    }
    return null;
  };

  const create = async (g: string, s: string | null) => {
    try {
      const values: Record<string, unknown> = {};
      const gv = valueForGroup(groupProp, g);
      if (gv && gv.value !== null) values[groupProp.id] = gv.value;
      const sv = subProp && s !== null ? valueForGroup(subProp, s) : undefined;
      if (sv && subProp && sv.value !== null) values[subProp.id] = sv.value;
      const row = await ipc.recordCreate({ databaseId, values });
      board.addCard(g, s, row);
      setEditingId(row.id);
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  const menuItems = (row: RecordRow, at: [string, string | null]): MenuItem[] => [
    { label: "Open", onSelect: () => void useWorkspace.getState().openPage(row.pageId) },
    { label: "Copy link", shortcut: "copy-link", onSelect: () => void copyPageLink(row.pageId) },
    { label: "Duplicate", shortcut: "duplicate", onSelect: async () => { try { await ipc.recordDuplicate(row.id); board.reload(); } catch (error) { setError(toAppError(error).message); } } },
    ...(canDrag
      ? groups.map((g, i) => ({
          label: `Move to ${groupLabel(groupProp, g.key, cfg.group?.bucket)}`,
          separated: i === 0,
          disabled: g.key === at[0],
          onSelect: () => move(row, at, [g.key, at[1]]),
        }))
      : []),
    {
      label: "Move to trash",
      danger: true,
      separated: true,
      onSelect: async () => {
        try {
          await ipc.pageDelete(row.pageId);
          board.reload();
          notify(`Moved “${row.title || "Untitled"}” to trash`, async () => {
            await ipc.pageRestore(row.pageId);
            board.reload();
          });
        } catch (e) {
          setError(toAppError(e).message);
        }
      },
    },
  ];

  const renderColumn = (g: GroupCount, s: string | null, count: number) => {
    const cell = board.cells[cellKey(g.key, s)];
    return (
      <Column key={cellKey(g.key, s)} id={`col:${cellKey(g.key, s)}`} droppable={canDrag} cell={cell} count={count} onMore={() => board.loadMore(g.key, s)}>
        {(cell?.rows ?? []).map((row) => (
          <Card
            key={row.id}
            row={row}
            props={cardProps}
            editing={editingId === row.id}
            draggable={canDrag}
            onOpen={() => void useWorkspace.getState().openPage(row.pageId)}
            onMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, row, at: [g.key, s] })}
            onTitle={async (title) => {
              setEditingId(null);
              if (title === row.title) return;
              const titleProp = db.detail!.properties.find((p) => p.type === "title");
              if (!titleProp) return;
              try {
                board.replaceRow(await ipc.recordSetValue(row.id, titleProp.id, title));
              } catch (e) {
                setError(toAppError(e).message);
              }
            }}
          />
        ))}
        <button type="button" className="col-new" onClick={() => void create(g.key, s)}>
          <Icon name="plus" size={14} />
          New
        </button>
      </Column>
    );
  };

  return (
    <>
      {board.error && (
        <p className="error-text" role="alert">
          {board.error}{" "}
          <button type="button" className="link" onClick={board.reload}>
            Try again
          </button>
        </p>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={(e) => setDragging((e.active.data.current?.row as RecordRow) ?? null)}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="board" role="region" aria-label={`Board grouped by ${groupProp.name}`}>
          <div className="board-inner">
            <div className="board-heads">
              {groups.map((g) => (
                <div key={g.key} className="col-head">
                  <GroupLabel prop={groupProp} groupKey={g.key} spec={cfg.group} />
                  <span className="group-count">{g.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
            {lanes.length === 0 ? (
              <div className="lane-cols">
                {groups.map((g) => (
                  <div key={g.key} className="board-col">
                    {renderColumn(g, null, g.count)}
                  </div>
                ))}
              </div>
            ) : (
              lanes.map((lane) => {
                const total = groups.reduce((n, g) => n + (g.subgroups.find((x) => x.key === lane.key)?.count ?? 0), 0);
                const collapsed = collapsedLanes.has(lane.key);
                return (
                  <section key={lane.key} className="lane" aria-label={groupLabel(subProp, lane.key, cfg.subgroup?.bucket)}>
                    <button
                      type="button"
                      className="lane-title"
                      aria-expanded={!collapsed}
                      onClick={() => setCollapsedLanes((c) => (c.has(lane.key) ? new Set([...c].filter((k) => k !== lane.key)) : new Set(c).add(lane.key)))}
                    >
                      <Icon name="chevron" size={14} />
                      <GroupLabel prop={subProp} groupKey={lane.key} spec={cfg.subgroup} />
                      <span className="group-count">{total.toLocaleString()}</span>
                    </button>
                    {!collapsed && (
                      <div className="lane-cols">
                        {groups.map((g) => (
                          <div key={g.key} className="board-col">
                            {renderColumn(g, lane.key, g.subgroups.find((x) => x.key === lane.key)?.count ?? 0)}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })
            )}
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging && (
            <div className="card overlay">
              <span className="card-title">{dragging.title || "Untitled"}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row, menu.at)} onClose={() => setMenu(null)} />}
    </>
  );
}

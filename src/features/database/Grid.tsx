import { useShortcutScope } from "../shortcuts/runtime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { READ_ONLY } from "../../lib/access";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { copyText } from "../../components/editingMenu";
import { copyPageLink } from "../pages/pageMenu";
import { Icon } from "../../components/Icon";
import { Popover, anchorOf, type Anchor } from "../../components/Popover";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Property, RecordRow, ViewConfig } from "../../types";
import { BulkBar } from "./BulkBar";
import { CellContent } from "./cells";
import { DateEditor, InlineEditor, OptionPicker, RelationPicker, type Move } from "./editors";
import { isTypingKey, moveCell, type Cell } from "./gridNav";
import { cellText, DEFAULT_WIDTH, isOptionType, isPopoverType, isSortable, linksOf, TITLE_WIDTH, TYPE_META } from "./model";
import { GroupLabel } from "./GroupLabel";
import { useScaled } from "../../stores/preferences";
import type { HeaderSegment } from "./groups";
import { PropertyEditor } from "./PropertyEditor";
import type { Column, useDatabase } from "./useDatabase";
import type { useRecordTable } from "./useRecordTable";
import { IconSwap } from "../../components/Swap";

const BASE_ROW_HEIGHT = 34;
const ADD_COL = 44;

type Db = ReturnType<typeof useDatabase>;
type Table = ReturnType<typeof useRecordTable>;

interface Editing {
  row: number;
  col: number;
  mode: "inline" | "popover";
  seed?: string;
}

interface Props {
  columns: Column[];
  view: ViewConfig;
  db: Db;
  table: Table;
  /** Ask the grid to move to a row and start editing its title (after "New record"). */
  focusRequest: { row: number; nonce: number } | null;
  onCreate: () => void;
  onAddProperty: (anchor: Anchor) => void;
  /** Expand or collapse a group (or subgroup) header. */
  onToggleGroup: (h: HeaderSegment) => void;
}

const widthOf = (c: Column) => c.column.width ?? (c.property.type === "title" ? TITLE_WIDTH : DEFAULT_WIDTH);

export function Grid({ columns, view, db, table, focusRequest, onCreate, onAddProperty, onToggleGroup }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Cell>({ row: 0, col: 0 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: RecordRow; cell?: Cell } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; prop: Property } | null>(null);
  const [propEditor, setPropEditor] = useState<{ prop: Property; anchor: Anchor } | null>(null);
  const [deleting, setDeleting] = useState<{ prop: Property; anchor: Anchor } | null>(null);
  const [resizing, setResizing] = useState<{ id: string; width: number } | null>(null);
  const setError = useWorkspace((s) => s.setError);
  const notify = useWorkspace((s) => s.notify);
  // Rows ticked for a bulk edit, kept by id so they stay selected while scrolling or paging.
  const [selected, setSelected] = useState<ReadonlyMap<string, RecordRow>>(new Map());
  const lastTicked = useRef<number | null>(null);
  const viewKey = db.view?.id;
  useEffect(() => {
    setSelected(new Map());
    lastTicked.current = null;
  }, [viewKey]);

  const loadedRows = table.loadedRows;

  /** Ticks or unticks one row; with Shift, everything between it and the last tick follows. */
  const tick = (row: RecordRow, index: number, on: boolean, range: boolean) => {
    if (READ_ONLY) return;
    // Read and move the anchor here, not inside the updater: React may run an updater twice.
    const anchor = range ? lastTicked.current : null;
    lastTicked.current = index;
    setSelected((prev) => {
      const next = new Map(prev);
      const from = anchor !== null ? Math.min(anchor, index) : index;
      const to = anchor !== null ? Math.max(anchor, index) : index;
      for (let i = from; i <= to; i++) {
        const r = i === index ? row : table.rowAt(i);
        if (!r) continue;
        if (on) next.set(r.id, r);
        else next.delete(r.id);
      }
      return next;
    });
  };

  const allLoaded = loadedRows();
  const everyTicked = allLoaded.length > 0 && allLoaded.every(({ row }) => selected.has(row.id));
  const setAllTicked = (on: boolean) => setSelected(on ? new Map(loadedRows().map(({ row }) => [row.id, row])) : new Map());

  const widths = useMemo(() => columns.map((c) => (resizing?.id === c.property.id ? resizing.width : widthOf(c))), [columns, resizing]);
  const template = `${widths.map((w) => `${w}px`).join(" ")} ${ADD_COL}px`;
  const totalWidth = widths.reduce((a, b) => a + b, 0) + ADD_COL;

  const ROW_HEIGHT = useScaled(BASE_ROW_HEIGHT, 28);
  const virtualizer = useVirtualizer({ count: table.rowCount, getScrollElement: () => scroller.current, estimateSize: () => ROW_HEIGHT, overscan: 12 });
  useEffect(() => virtualizer.measure(), [ROW_HEIGHT]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;

  // Fetch the pages around what is on screen.
  useEffect(() => {
    if (table.rowCount > 0) table.ensureRange(Math.max(0, first - 20), last + 20, editing ? [editing.row] : []);
  }, [first, last, table, editing]);

  const focusGrid = useCallback(() => scroller.current?.focus({ preventScroll: true }), []);
  const cellEl = (row: number, col: number) => document.getElementById(`cell-${row}-${col}`);

  const go = useCallback(
    (cell: Cell) => {
      setActive(cell);
      virtualizer.scrollToIndex(cell.row, { align: "auto" });
      requestAnimationFrame(() => cellEl(cell.row, cell.col)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
    },
    [virtualizer],
  );

  const commit = useCallback(
    async (row: RecordRow, prop: Property, value: unknown) => {
      try {
        table.replaceRow(await ipc.recordSetValue(row.id, prop.id, value));
        if (view.group?.propertyId === prop.id || view.subgroup?.propertyId === prop.id) table.reload();
      } catch (e) {
        setError(toAppError(e).message);
      }
    },
    [table, setError, view.group, view.subgroup],
  );

  const start = useCallback(
    (cell: Cell, seed?: string) => {
      if (READ_ONLY) return;
      const row = table.rowAt(cell.row);
      const prop = columns[cell.col]?.property;
      if (!row || !prop || !TYPE_META[prop.type].editable) return;
      if (prop.type === "checkbox") {
        void commit(row, prop, row.values[prop.id] !== true);
        return;
      }
      if (isPopoverType(prop.type)) {
        const el = cellEl(cell.row, cell.col);
        if (el) setAnchor(anchorOf(el));
        setEditing({ ...cell, mode: "popover" });
      } else {
        setEditing({ ...cell, mode: "inline", seed });
      }
    },
    [table, columns, commit],
  );

  // "New record": jump to the new row and edit its title once that row has actually been drawn.
  useEffect(() => {
    if (!focusRequest) return;
    const titleCol = Math.max(0, columns.findIndex((c) => c.property.type === "title"));
    go({ row: focusRequest.row, col: titleCol });
    let frames = 0;
    let raf = 0;
    const wait = () => {
      if (cellEl(focusRequest.row, titleCol)) setEditing({ row: focusRequest.row, col: titleCol, mode: "inline" });
      else if (frames++ < 90) raf = requestAnimationFrame(wait);
    };
    raf = requestAnimationFrame(wait);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  const stop = () => {
    setEditing(null);
    setAnchor(null);
    focusGrid();
  };

  const openRecord = (row: RecordRow) => void useWorkspace.getState().openPage(row.pageId);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && selected.size && !editing) {
      e.preventDefault();
      setSelected(new Map());
      return;
    }
    if (editing || e.target !== scroller.current) return;
    const item = table.itemAt(active.row);
    if (item.type === "header" && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      return onToggleGroup(item.header);
    }
    const row = table.rowAt(active.row);
    const prop = columns[active.col]?.property;
    const next = moveCell(active, e.key, { rows: table.rowCount, cols: columns.length }, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    if (next) {
      e.preventDefault();
      return go(next);
    }
    if (!row || !prop) return;
    if (e.key === " " && (prop.type === "checkbox" || isPopoverType(prop.type))) {
      e.preventDefault(); start(active);
    } else if (isTypingKey(e) && ["title", "text", "number", "url", "email", "phone"].includes(prop.type)) {
      e.preventDefault();
      start(active, e.key);

    }
  };

  const gridCommand = (run: (cell: Cell) => boolean | void) => (target: Element, event: KeyboardEvent | MouseEvent) => {
    if (editing || target.closest("input, textarea, select, button")) return false;
    const element = target.closest<HTMLElement>('[role="gridcell"][data-row-index]');
    const cell = "key" in event ? active : element ? { row: Number(element.dataset.rowIndex), col: Number(element.dataset.columnIndex) } : null;
    if (!cell || ("key" in event && target !== scroller.current)) return false;
    const result = run(cell);
    if (result !== false && !("key" in event)) { setActive(cell); scroller.current?.focus(); }
    return result;
  };
  useShortcutScope(scroller, "grid", {
    "grid-select-row": gridCommand(cell => { const row = table.rowAt(cell.row); if (!row) return false; tick(row, cell.row, !selected.has(row.id), false); }),
    "grid-select-range": gridCommand(cell => { const row = table.rowAt(cell.row); if (!row) return false; tick(row, cell.row, !selected.has(row.id), true); }),
    "grid-select-all": gridCommand(() => setAllTicked(true)),
    "grid-open": gridCommand(cell => { const row = table.rowAt(cell.row); if (!row) return false; openRecord(row); }),
    "grid-edit": gridCommand(cell => { if (READ_ONLY || table.itemAt(cell.row).type === "header") return false; start(cell); }),
    "grid-clear": gridCommand(cell => { const row = table.rowAt(cell.row), prop = columns[cell.col]?.property; if (READ_ONLY || !row || !prop || !TYPE_META[prop.type].editable) return false; void commit(row, prop, prop.type === "title" ? "" : prop.type === "checkbox" ? false : null); }),
    "grid-menu": gridCommand(cell => { const row = table.rowAt(cell.row); if (!row) return false; const rect = cellEl(cell.row, cell.col)?.getBoundingClientRect(); setMenu({ x: rect?.left ?? 0, y: rect?.bottom ?? 0, row, cell }); }),
  });

  const finishInline = (row: RecordRow, prop: Property, cell: Cell, result: { value: unknown } | null, move: Move) => {
    setEditing(null);
    if (result) void commit(row, prop, result.value);
    const target =
      move === "down" ? { row: Math.min(table.rowCount - 1, cell.row + 1), col: cell.col } : move === "right" ? moveCell(cell, "Tab", { rows: table.rowCount, cols: columns.length }) : move === "left" ? moveCell(cell, "Tab", { rows: table.rowCount, cols: columns.length }, { shift: true }) : cell;
    if (target) go(target);
    focusGrid();
  };

  const trash = async (row: RecordRow) => {
    try {
      await ipc.pageDelete(row.pageId);
      table.reload();
      notify(`Moved “${row.title || "Untitled"}” to trash`, async () => {
        await ipc.pageRestore(row.pageId);
        table.reload();
      });
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  const duplicate = async (row: RecordRow) => {
    try {
      table.addExtra(await ipc.recordDuplicate(row.id));
      notify("Record duplicated. It is added at the end of the list.");
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  const menuItems = (row: RecordRow, cell: Cell): MenuItem[] => [
    ...(columns[cell.col] ? [
      { label: "Copy cell value", disabled: !cellText(columns[cell.col].property, row), onSelect: () => void copyText(cellText(columns[cell.col].property, row)) },
      ...(TYPE_META[columns[cell.col].property.type].editable ? [{ label: columns[cell.col].property.type === "checkbox" ? "Toggle checkbox" : "Edit cell…", shortcut: "grid-edit", onSelect: () => start(cell) }] : []),
    ] : []),
    { label: "Open", shortcut: "grid-open", onSelect: () => openRecord(row) },
    { label: "Copy link", shortcut: "copy-link", onSelect: () => void copyPageLink(row.pageId) },
    { label: "Duplicate", shortcut: "duplicate", onSelect: () => void duplicate(row) },
    { label: "Move to trash", danger: true, separated: true, onSelect: () => void trash(row) },
  ];

  const sortOf = (id: string) => view.sorts.find((s) => s.propertyId === id)?.direction;
  const setSort = (id: string, direction: "asc" | "desc" | null) =>
    db.updateView({ sorts: direction ? [{ propertyId: id, direction }, ...view.sorts.filter((s) => s.propertyId !== id)] : view.sorts.filter((s) => s.propertyId !== id) }, { rows: true });

  const headerItems = (prop: Property, anchorEl: Anchor): MenuItem[] => {
    const dir = sortOf(prop.id);
    return [
      { label: isOptionType(prop.type) || prop.type === "unique_id" ? "Rename and edit options" : prop.type === "formula" ? "Rename and edit formula" : "Rename", onSelect: () => setPropEditor({ prop, anchor: anchorEl }) },
      ...(isSortable(prop)
        ? [
            { label: "Sort ascending", separated: true, disabled: dir === "asc", onSelect: () => setSort(prop.id, "asc") },
            { label: "Sort descending", disabled: dir === "desc", onSelect: () => setSort(prop.id, "desc") },
            ...(dir ? [{ label: "Remove sort", onSelect: () => setSort(prop.id, null) }] : []),
          ]
        : []),
      { label: "Move left", separated: true, onSelect: () => db.moveColumn(prop.id, -1) },
      { label: "Move right", onSelect: () => db.moveColumn(prop.id, 1) },
      ...(prop.type !== "title" ? [{ label: "Hide in view", onSelect: () => db.patchColumn(prop.id, { hidden: true }) }, { label: "Delete property", danger: true, separated: true, onSelect: () => setDeleting({ prop, anchor: anchorEl }) }] : []),
    ];
  };

  const startResize = (e: React.PointerEvent, c: Column, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[i];
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.max(60, Math.min(800, Math.round(startW + ev.clientX - startX)));
      setResizing({ id: c.property.id, width: w });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResizing(null);
      if (w !== startW) db.patchColumn(c.property.id, { width: w });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const activeId = columns.length && table.rowCount ? `cell-${active.row}-${active.col}` : undefined;
  const editRow = editing ? table.rowAt(editing.row) : null;
  const editProp = editing ? columns[editing.col]?.property : undefined;
  const empty = table.loaded && table.rowCount === 0;
  const filtered = view.filter !== null;

  return (
    <div
      ref={scroller}
      className={`grid-scroll${selected.size ? " selecting" : ""}`}
      role="grid"
      aria-label="Records"
      aria-rowcount={table.rowCount + 1}
      aria-colcount={columns.length}
      aria-activedescendant={activeId}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if (e.target === scroller.current) {
          e.preventDefault();
          const row = table.rowAt(active.row);
          if (row) setMenu({ x: e.clientX, y: e.clientY, row });
        }
      }}
    >
      <div className="grid-inner" style={{ width: totalWidth }}>
        <div className="grid-header" role="row" style={{ gridTemplateColumns: template }}>
          {columns.map((c, i) => {
            const dir = sortOf(c.property.id);
            return (
              <div
                key={c.property.id}
                role="columnheader"
                aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
                className={`hcell${i === 0 ? " sticky" : ""}`}
              >
                {i === 0 && (
                  <input
                    type="checkbox"
                    className="row-check"
                    aria-label="Select all loaded records"
                    title="Select all loaded records"
                    checked={everyTicked}
                    ref={(el) => {
                      if (el) el.indeterminate = !everyTicked && selected.size > 0;
                    }}
                    onChange={(e) => setAllTicked(e.target.checked)}
                  />
                )}
                <button
                  type="button"
                  className="hbtn"
                  aria-haspopup="menu"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setHeaderMenu({ x: r.left, y: r.bottom + 2, prop: c.property });
                  }}
                >
                  <Icon name={TYPE_META[c.property.type].icon} size={14} />
                  <span className="hname">{c.property.name}</span>
                  {dir && <IconSwap name={dir === "asc" ? "arrowUp" : "arrowDown"} size={12} />}
                </button>
                <span className="resizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={`Resize ${c.property.name}`} aria-valuemin={60} aria-valuemax={800} aria-valuenow={widths[i]} onPointerDown={(e) => startResize(e, c, i)} onKeyDown={(e) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const step = e.shiftKey ? 50 : 10;
                  const width = e.key === "Home" ? 60 : e.key === "End" ? 800 : Math.max(60, Math.min(800, widths[i] + (e.key === "ArrowRight" ? step : -step)));
                  db.patchColumn(c.property.id, { width });
                }} />
              </div>
            );
          })}
          <div className="hcell add" role="columnheader" aria-label="Add a property">
            <button type="button" className="icon-btn" aria-label="Add a property" title="Add a property" onClick={(e) => onAddProperty(anchorOf(e.currentTarget))}>
              <Icon name="plus" />
            </button>
          </div>
        </div>

        <div className="grid-body" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((v) => {
            const item = table.itemAt(v.index);
            if (item.type === "header") {
              const h = item.header;
              const prop = db.byId.get((h.level === 0 ? view.group : view.subgroup)?.propertyId ?? "");
              return (
                <div
                  key={v.key}
                  role="row"
                  aria-rowindex={v.index + 2}
                  className={`row group-row level-${h.level}${active.row === v.index ? " current" : ""}`}
                  style={{ transform: `translateY(${v.start}px)`, height: ROW_HEIGHT }}
                >
                  <div
                    id={`cell-${v.index}-0`}
                    role="gridcell"
                    aria-selected={active.row === v.index}
                    className={`gcell${active.row === v.index ? " active" : ""}`}
                    onMouseDown={() => {
                      setActive({ row: v.index, col: 0 });
                      window.setTimeout(focusGrid, 0);
                    }}
                  >
                    <button type="button" className="group-toggle" aria-expanded={!h.collapsed} tabIndex={-1} onClick={() => onToggleGroup(h)}>
                      <Icon name="chevron" size={14} />
                      <GroupLabel prop={prop} groupKey={h.key} spec={h.level === 0 ? view.group : view.subgroup} />
                      <span className="group-count">{h.count.toLocaleString()}</span>
                    </button>
                  </div>
                </div>
              );
            }
            const row = item.row;
            return (
              <div
                key={v.key}
                role="row"
                aria-rowindex={v.index + 2}
                aria-selected={row ? selected.has(row.id) : undefined}
                className={`row${row ? "" : " skeleton"}${active.row === v.index ? " current" : ""}${row && selected.has(row.id) ? " ticked" : ""}`}
                style={{ transform: `translateY(${v.start}px)`, height: ROW_HEIGHT, gridTemplateColumns: template }}
                onContextMenu={(e) => {
                  if (!row) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const target = (e.target as Element).closest<HTMLElement>("[data-column-index]");
                  const cell = { row: v.index, col: target ? Number(target.dataset.columnIndex) : active.col };
                  setActive(cell);
                  setMenu({ x: e.clientX, y: e.clientY, row, cell });
                }}
              >
                {columns.map((c, ci) => {
                  const isActive = active.row === v.index && active.col === ci;
                  const isEditing = editing?.mode === "inline" && editing.row === v.index && editing.col === ci;
                  const meta = TYPE_META[c.property.type];
                  return (
                    <div
                      key={c.property.id}
                      id={`cell-${v.index}-${ci}`}
                      data-column-index={ci}
                      data-row-index={v.index}
                      role="gridcell"
                      aria-selected={isActive}
                      aria-readonly={READ_ONLY || !meta.editable}
                      aria-label={row ? `${c.property.name}: ${cellText(c.property, row) || "empty"}` : undefined}
                      className={`cell${ci === 0 ? " sticky" : ""}${isActive ? " active" : ""}${isEditing ? " editing" : ""}${c.property.type === "number" ? " num" : ""}${meta.editable ? "" : " readonly"}`}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        if (editing && !(editing.row === v.index && editing.col === ci)) setEditing(null);
                        setActive({ row: v.index, col: ci });
                        // Keep keyboard focus on the grid unless the cell opens its own editor.
                        window.setTimeout(() => !editing && focusGrid(), 0);
                      }}
                      onClick={() => {
                        if (!row || !meta.editable || isEditing) return;
                        if (c.property.type === "checkbox" || isPopoverType(c.property.type)) start({ row: v.index, col: ci });
                      }}
                      onDoubleClick={() => row && !isEditing && start({ row: v.index, col: ci })}
                    >
                      {row ? (
                        isEditing ? (
                          <InlineEditor
                            initial={editing.seed ?? (c.property.type === "title" ? row.title : typeof row.values[c.property.id] === "string" ? (row.values[c.property.id] as string) : typeof row.values[c.property.id] === "number" ? String(row.values[c.property.id]) : "")}
                            type={c.property.type}
                            seeded={editing.seed !== undefined}
                            onDone={(result, move) => finishInline(row, c.property, { row: v.index, col: ci }, result, move)}
                          />
                        ) : (
                          <>
                            {ci === 0 && (
                              <input
                                type="checkbox"
                                className="row-check"
                                aria-label={`Select ${row.title || "Untitled"}`}
                                checked={selected.has(row.id)}
                                tabIndex={-1}
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => tick(row, v.index, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey === true)}
                              />
                            )}
                            <CellContent prop={c.property} row={row} />
                            {c.property.type === "title" && (
                              <button
                                type="button"
                                className="open-btn"
                                tabIndex={-1}
                                aria-label={`Open ${row.title || "Untitled"}`}
                                title="Open as page (Shift+Enter)"
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openRecord(row);
                                }}
                              >
                                <Icon name="open" size={14} />
                                Open
                              </button>
                            )}
                          </>
                        )
                      ) : (
                        <span className="skel" aria-hidden="true" />
                      )}
                    </div>
                  );
                })}
                <div className="cell filler" role="presentation" />
              </div>
            );
          })}
        </div>

        {empty && (
          <div className="grid-empty">
            {filtered ? (
              <>
                <p>No records match these filters.</p>
                <button type="button" className="btn" onClick={() => db.updateView({ filter: null }, { rows: true })}>
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <p>No records yet. Each row is a page, so it can hold notes of its own.</p>
                <button type="button" className="btn primary" onClick={onCreate}>
                  New record
                </button>
              </>
            )}
          </div>
        )}
        {!empty && table.loaded && (
          <button type="button" className="new-row" onClick={onCreate}>
            <Icon name="plus" size={14} />
            New record
          </button>
        )}
      </div>

      {selected.size > 0 && (
        <BulkBar
          rows={[...selected.values()]}
          view={view}
          db={db}
          table={table}
          onClear={() => setSelected(new Map())}
          onRowUpdated={(row) => setSelected((prev) => (prev.has(row.id) ? new Map(prev).set(row.id, row) : prev))}
        />
      )}

      {editing?.mode === "popover" && editRow && editProp && anchor && (isOptionType(editProp.type) ? (
        <OptionPicker
          prop={editProp}
          current={editRow.values[editProp.id]}
          multi={editProp.type === "multi_select"}
          anchor={anchor}
          onChange={(v) => void commit(editRow, editProp, v)}
          onCreate={async (name) => {
            const opts = (editProp.config.options ?? []).map((o) => ({ ...o }));
            const updated = await db.updateProperty(editProp.id, { config: { options: [...opts, { name, color: "gray", group: "todo" }] } });
            return updated?.config.options?.find((o) => o.name === name) ?? null;
          }}
          onClose={stop}
        />
      ) : editProp.type === "relation" ? (
        <RelationPicker
          prop={editProp}
          current={linksOf(editRow.values[editProp.id])}
          anchor={anchor}
          excludeId={editRow.id}
          onChange={(ids) => void commit(editRow, editProp, ids)}
          onClose={stop}
        />
      ) : (
        <DateEditor current={editRow.values[editProp.id]} anchor={anchor} onChange={(v) => void commit(editRow, editProp, v)} onClose={stop} />
      ))}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row, menu.cell ?? active)} onClose={() => { setMenu(null); focusGrid(); }} />}
      {headerMenu && (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          items={headerItems(headerMenu.prop, { left: headerMenu.x, top: headerMenu.y - 2, right: headerMenu.x, bottom: headerMenu.y + 2 })}
          onClose={() => setHeaderMenu(null)}
        />
      )}
      {propEditor && (
        <PropertyEditor
          prop={propEditor.prop}
          anchor={propEditor.anchor}
          onSave={(patch) => db.updateProperty(propEditor.prop.id, patch)}
          onClose={() => setPropEditor(null)}
        />
      )}
      {deleting && (
        <Popover anchor={deleting.anchor} onClose={() => setDeleting(null)} label="Delete property" className="picker">
          <p className="confirm-text">
            Delete “{deleting.prop.name}”? Its values are removed from every record. This cannot be undone.
          </p>
          <div className="picker-actions">
            <button type="button" className="btn" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                const p = deleting.prop;
                setDeleting(null);
                void db.deleteProperty(p.id);
              }}
            >
              Delete property
            </button>
          </div>
        </Popover>
      )}
      <span className="sr-only" aria-live="polite">
        {selected.size ? `${selected.size} selected` : table.loaded ? `${table.total.toLocaleString()} records` : "Loading records"}
      </span>
    </div>
  );
}

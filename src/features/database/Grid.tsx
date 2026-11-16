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
import type { Aggregates, AggregateKind, Property, RecordRow, ViewConfig } from "../../types";
import { BulkBar } from "./BulkBar";
import { CellContent } from "./cells";
import { DateEditor, InlineEditor, OptionPicker, RelationPicker, type Move } from "./editors";
import { isTypingKey, moveCell, type Cell } from "./gridNav";
import { cellPlain, cellText, DEFAULT_WIDTH, isFilterable, isOptionType, isPopoverType, isSortable, linksOf, rawValue, TITLE_WIDTH, TYPE_META } from "./model";
import { continueSeries } from "./fill";
import { parseCellText, parseTsv, planPaste, toHtmlTable, toTsv, type ParseContext } from "./paste";
import { coversAll, extendRange, fillTarget, fullRange, inRect, isSingle, rectCols, rectOf, rectRows, type Range, type Rect } from "./range";
import { afterRedo, afterUndo, emptyHistory, planReplay, record, sameValue, type CellEdit, type History } from "./undo";
import { GroupLabel } from "./GroupLabel";
import { cellValue, evaluateRules } from "./conditional";
import { TotalsFooter } from "./TotalsFooter";
import { formatAggregate, summarizeSelection } from "./totals";
import { formatNumberWith } from "./numberFormat";
import { useScaled } from "../../stores/preferences";
import type { HeaderSegment } from "./groups";
import { PropertyEditor } from "./PropertyEditor";
import type { Column, useDatabase } from "./useDatabase";
import type { useRecordTable } from "./useRecordTable";
import { IconSwap } from "../../components/Swap";
import { TaskScheduleHandle } from "../calendar/taskDrag";
import { frozenCount, ROW_HEIGHTS, stickyOffsets, toggleWrap } from "./columnOps";
import { andCondition, quickCondition } from "./quickFilter";
import { useUniqueFlags } from "./useUniqueFlags";
import { checkCell } from "./validation";

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
  /** Makes a record; resolves to it when it was added to this table, so it can be undone. */
  onCreate: () => Promise<RecordRow | void> | void;
  onAddProperty: (anchor: Anchor) => void;
  /** Expand or collapse a group (or subgroup) header. */
  onToggleGroup: (h: HeaderSegment) => void;
  /** Summaries over the whole filtered set (and per group) for the totals row; null until loaded. */
  totals: Aggregates | null;
  /** Open the in-view search field (Ctrl+F while the grid is focused). */
  onFind?: () => void;
  /** Open the filter panel with a new condition on this property. */
  onFilterColumn?: (prop: Property, anchor: Anchor) => void;
  /** Show the totals row. Off for dashboard widgets, which have no room for it. */
  showTotals: boolean;
}

const NAV_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
const MAX_NEW_RECORDS = 500;

interface CellWrite {
  row: RecordRow;
  prop: Property;
  value: unknown;
}

/** Types that can be grouped by (the backend's can_group). */
const groupable = (t: string) => ["select", "status", "checkbox", "date", "created_time", "updated_time"].includes(t);
/** Types whose text can wrap in a cell. */
const textual = (p: Property) => ["title", "text", "url", "email", "phone", "formula"].includes(p.type);

const widthOf = (c: Column) => c.column.width ?? (c.property.type === "title" ? TITLE_WIDTH : DEFAULT_WIDTH);

export function Grid({ columns, view, db, table, focusRequest, onCreate: makeRecord, onAddProperty, onToggleGroup, totals, showTotals, onFind, onFilterColumn }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Cell>({ row: 0, col: 0 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: RecordRow; cell?: Cell; rows: RecordRow[] } | null>(null);
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
  // The block of cells picked with Shift+arrows, Shift+click or a drag; null means just the active cell.
  const [range, setRange] = useState<Range | null>(null);
  const [fillPreview, setFillPreview] = useState<Rect | null>(null);
  const histories = useRef(new Map<string, History>());
  const structure = columns.map((c) => `${c.property.id}:${c.property.type}`).join("|");
  useEffect(() => {
    setSelected(new Map());
    lastTicked.current = null;
    setRange(null);
  }, [viewKey]);
  useEffect(() => setRange(null), [structure]);

  /** This view's undo history; a changed set of columns starts it afresh. */
  const history = () => {
    const key = viewKey ?? "";
    let h = histories.current.get(key);
    if (!h || h.structure !== structure) {
      h = emptyHistory(structure);
      histories.current.set(key, h);
    }
    return h;
  };
  const setHistory = (h: History) => void histories.current.set(viewKey ?? "", h);

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

  const baseHeight = ROW_HEIGHTS[view.rowHeight ?? "medium"] ?? ROW_HEIGHTS.medium;
  const ROW_HEIGHT = useScaled(baseHeight, Math.min(28, baseHeight));
  const frozen = frozenCount(view.frozenColumns, columns.length);
  const offsets = stickyOffsets(widths, frozen);
  const wrapped = new Set(view.wrapColumns ?? []);
  const uniqueFlags = useUniqueFlags(db.detail?.database.id, columns.map((c) => c.property), table.edits + db.queryVersion);
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
        const before = rawValue(prop, row);
        const updated = await ipc.recordSetValue(row.id, prop.id, value);
        table.replaceRow(updated);
        const after = rawValue(prop, updated);
        if (!sameValue(before, after)) setHistory(record(history(), { edits: [{ recordId: row.id, propertyId: prop.id, before, after }] }));
        if (view.group?.propertyId === prop.id || view.subgroup?.propertyId === prop.id) table.reload();
      } catch (e) {
        setError(toAppError(e).message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table, setError, view.group, view.subgroup, viewKey, structure],
  );

  const regroups = (propertyIds: Iterable<string>) => {
    for (const id of propertyIds) if (view.group?.propertyId === id || view.subgroup?.propertyId === id) return true;
    return false;
  };

  /** Writes many cells in one go (paste, fill, clear) and records them as a single undo step. */
  const applyCells = async (writes: CellWrite[]): Promise<boolean> => {
    const changes = writes.filter((w) => !sameValue(rawValue(w.prop, w.row), w.value));
    if (changes.length === 0) return true;
    try {
      const rows = await ipc.recordSetCells(changes.map((w) => ({ recordId: w.row.id, propertyId: w.prop.id, value: w.value })));
      table.replaceRows(rows);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const edits: CellEdit[] = changes.map((w) => ({ recordId: w.row.id, propertyId: w.prop.id, before: rawValue(w.prop, w.row), after: rawValue(w.prop, byId.get(w.row.id) ?? w.row) }));
      setHistory(record(history(), { edits }));
      if (regroups(changes.map((w) => w.prop.id))) table.reload();
      return true;
    } catch (e) {
      setError(toAppError(e).message);
      return false;
    }
  };

  /** Makes a record and remembers it, so Ctrl+Z can take it back. */
  const onCreate = async () => {
    const row = await makeRecord();
    if (row) setHistory(record(history(), { edits: [], created: [{ id: row.id, pageId: row.pageId, title: row.title }] }));
  };

  /** The rows a right-click acts on: every ticked row when the clicked one is ticked, the picked block when the click
   *  lands inside it, otherwise just the clicked row. */
  const openMenu = (x: number, y: number, row: RecordRow, cell?: Cell) => {
    let rows = [row];
    if (selected.size > 1 && selected.has(row.id)) rows = [...selected.values()];
    else if (range && cell) {
      const r = rectOf(range);
      if (r.r1 > r.r0 && cell.row >= r.r0 && cell.row <= r.r1) {
        const picked: RecordRow[] = [];
        for (let i = r.r0; i <= r.r1; i++) { const found = table.rowAt(i); if (found) picked.push(found); }
        if (picked.some((p) => p.id === row.id)) rows = picked;
      }
    }
    setMenu({ x, y, row, cell, rows });
  };

  const replay = async (direction: "undo" | "redo") => {
    const h = history();
    const step = direction === "undo" ? h.undo[h.undo.length - 1] : h.redo[h.redo.length - 1];
    if (!step) return notify(direction === "undo" ? "Nothing to undo." : "Nothing to redo.");
    if (step.created?.length) {
      try {
        for (const r of step.created) {
          if (direction === "undo") { await ipc.pageDelete(r.pageId); table.removeExtra(r.id); }
          else await ipc.pageRestore(r.pageId);
        }
        table.reload();
        setHistory(direction === "undo" ? afterUndo(h, step) : afterRedo(h, step));
        const n = step.created.length;
        notify(`${direction === "undo" ? "Removed" : "Restored"} ${n} new ${n === 1 ? "record" : "records"}.`);
      } catch (e) {
        setError(toAppError(e).message);
      }
      return;
    }
    const props = new Map(columns.map((c) => [c.property.id, c.property]));
    const plan = planReplay(step, direction, (recordId, propertyId) => {
      const row = table.findRow(recordId);
      const prop = props.get(propertyId);
      return row && prop ? { value: rawValue(prop, row) } : undefined;
    });
    try {
      if (plan.cells.length) {
        table.replaceRows(await ipc.recordSetCells(plan.cells));
        if (regroups(plan.cells.map((c) => c.propertyId))) table.reload();
      }
      setHistory(direction === "undo" ? afterUndo(h, plan.step) : afterRedo(h, plan.step));
      const n = plan.cells.length;
      const skipped = plan.skipped ? ` ${plan.skipped} skipped because ${plan.skipped === 1 ? "it was" : "they were"} changed since.` : "";
      notify(`${direction === "undo" ? "Undid" : "Redid"} ${n} cell${n === 1 ? "" : "s"}.${skipped}`);
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  /** The picked block, or just the active cell. */
  const pickedRect = (): Rect => rectOf(range ?? { anchor: active, focus: active });
  const editable = (prop: Property | undefined): prop is Property => !!prop && !READ_ONLY && TYPE_META[prop.type].editable;
  /** Records in display order for rows r0..r1, leaving out group headers. Unloaded rows come back as null. */
  const rowsBetween = (r0: number, r1: number): { index: number; row: RecordRow | null }[] => {
    const out: { index: number; row: RecordRow | null }[] = [];
    for (let i = Math.max(0, r0); i <= Math.min(r1, table.rowCount - 1); i++) {
      const item = table.itemAt(i);
      if (item.type === "row") out.push({ index: i, row: item.row });
    }
    return out;
  };

  const copyRange = async () => {
    const rect = pickedRect();
    const cells = rowsBetween(rect.r0, rect.r1).map(({ row }) => {
      const out: string[] = [];
      for (let c = rect.c0; c <= rect.c1; c++) out.push(row && columns[c] ? cellPlain(columns[c].property, row) : "");
      return out;
    });
    if (cells.length === 0) return;
    const text = toTsv(cells);
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([toHtmlTable(cells)], { type: "text/html" }) })]);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return setError("Could not access the clipboard. Try the keyboard shortcut.");
      }
    }
    const n = cells.length * (rect.c1 - rect.c0 + 1);
    notify(`Copied ${n} cell${n === 1 ? "" : "s"}.`);
  };

  /** Looks up related records by title for every relation column a paste reaches. */
  const relationLookup = async (data: string[][], col: number): Promise<ParseContext> => {
    const found = new Map<string, string>();
    const jobs: Promise<void>[] = [];
    const width = Math.max(0, ...data.map((r) => r.length));
    for (let k = 0; k < width; k++) {
      const prop = columns[col + k]?.property;
      const target = prop?.config.targetDatabaseId;
      if (prop?.type !== "relation" || !target) continue;
      const titles = new Set(data.flatMap((r) => (r[k] ?? "").split(",").map((t) => t.trim()).filter(Boolean)));
      for (const title of titles) {
        jobs.push(
          ipc.recordLookup(target, title, 8).then((links) => {
            const hit = links.find((l) => l.title.trim().toLowerCase() === title.toLowerCase());
            if (hit) found.set(`${prop.id}|${title.toLowerCase()}`, hit.id);
          }),
        );
      }
    }
    await Promise.all(jobs);
    return { relation: (p, title) => found.get(`${p.id}|${title.toLowerCase()}`) };
  };

  const pasteClipboard = async () => {
    if (READ_ONLY) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return setError("Could not paste from the clipboard. Use Ctrl+V (or Command+V).");
    }
    const data = parseTsv(text);
    if (data.length === 0) return;
    const databaseId = db.detail?.database.id;
    const rect = pickedRect();
    try {
      const ctx = await relationLookup(data, rect.c0);
      const fill = data.length === 1 && data[0].length === 1 && !isSingle(range) ? { rows: rectRows(rect), cols: rectCols(rect) } : undefined;
      const plan = planPaste(data, rect.c0, columns.map((c) => c.property), ctx, fill);
      const startCount = table.rowCount;
      const targets = rowsBetween(rect.r0, startCount - 1).slice(0, plan.rows);
      let created = 0;
      const need = plan.rows - targets.length;
      if (need > 0 && databaseId) {
        const make = Math.min(need, MAX_NEW_RECORDS);
        for (let i = 0; i < make; i++) {
          const row = await ipc.recordCreate({ databaseId });
          table.addExtra(row);
          targets.push({ index: startCount + i, row });
          created++;
        }
      }
      let skipped = plan.skipped;
      const writes: CellWrite[] = [];
      for (const cell of plan.cells) {
        const target = targets[cell.r]?.row;
        const prop = columns[cell.c]?.property;
        if (target && prop) writes.push({ row: target, prop, value: cell.value });
        else skipped++;
      }
      if (!(await applyCells(writes))) return;
      const last = targets[targets.length - 1];
      const width = fill ? fill.cols : Math.max(1, ...data.map((r) => r.length));
      if (last) {
        const block = { anchor: { row: rect.r0, col: rect.c0 }, focus: { row: last.index, col: Math.min(columns.length - 1, rect.c0 + width - 1) } };
        setRange(isSingle(block) ? null : block);
        setActive(block.focus);
      }
      const parts = [`Pasted ${writes.length} cell${writes.length === 1 ? "" : "s"}`];
      if (created) parts.push(`added ${created} new record${created === 1 ? "" : "s"}`);
      if (need > created) parts.push(`${need - created} rows did not fit`);
      if (skipped) parts.push(`skipped ${skipped} (calculated columns, unknown options or unreadable values)`);
      if (plan.partial) parts.push(`${plan.partial} had options that do not exist`);
      notify(`${parts.join(", ")}.`);
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  /**
   * Copies the source block into the target area, down or right. Numbers and whole days keep
   * counting when two or more are given; other values repeat.
   */
  const fillBlock = async (src: Rect, target: Rect, dir: "down" | "right", series: boolean) => {
    const writes: CellWrite[] = [];
    let skipped = 0;
    const ctx: ParseContext = {};
    const convert = (from: Property, row: RecordRow, to: Property): { value: unknown } | null => {
      if (from.id === to.id || (from.type === to.type && !isOptionType(from.type) && from.type !== "relation")) return { value: rawValue(from, row) };
      const parsed = parseCellText(to, cellPlain(from, row), ctx);
      return "skip" in parsed ? null : { value: parsed.value };
    };
    if (dir === "down") {
      const source = rowsBetween(src.r0, src.r1);
      const dest = rowsBetween(src.r1 + 1, target.r1);
      if (source.length === 0 || dest.length === 0) return;
      for (let c = src.c0; c <= src.c1; c++) {
        const prop = columns[c]?.property;
        if (!prop) continue;
        if (!editable(prop)) {
          skipped += dest.length;
          continue;
        }
        const values = source.map((s) => (s.row ? rawValue(prop, s.row) : null));
        const next = series ? continueSeries(values, dest.length, prop.type) : dest.map((_, i) => values[i % values.length]);
        dest.forEach((d, i) => (d.row ? writes.push({ row: d.row, prop, value: next[i] }) : skipped++));
      }
    } else {
      const srcProps = columns.slice(src.c0, src.c1 + 1).map((c) => c.property);
      const destProps = columns.slice(src.c1 + 1, target.c1 + 1).map((c) => c.property);
      if (srcProps.length === 0 || destProps.length === 0) return;
      const type = srcProps[0].type;
      const uniform = series && srcProps.every((p) => p.type === type) && destProps.every((p) => p.type === type);
      for (const { row } of rowsBetween(src.r0, src.r1)) {
        if (!row) continue;
        const seq = uniform ? continueSeries(srcProps.map((p) => rawValue(p, row)), destProps.length, type) : null;
        destProps.forEach((to, i) => {
          if (!editable(to)) return void skipped++;
          if (seq) return void writes.push({ row, prop: to, value: seq[i] });
          const hit = convert(srcProps[i % srcProps.length], row, to);
          if (hit) writes.push({ row, prop: to, value: hit.value });
          else skipped++;
        });
      }
    }
    if (!(await applyCells(writes))) return;
    const n = writes.length;
    notify(`Filled ${n} cell${n === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} that cannot be filled` : ""}.`);
  };

  /** Ctrl+D and Ctrl+R: copy the first row or column of the block across the rest; one cell copies its neighbour. */
  const fillFromEdge = async (dir: "down" | "right") => {
    if (READ_ONLY) return;
    const rect = pickedRect();
    const single = isSingle(range);
    if (dir === "down") {
      if (single ? rect.r0 === 0 : rect.r0 === rect.r1) return;
      const row = single ? rect.r0 - 1 : rect.r0;
      await fillBlock({ ...rect, r0: row, r1: row }, rect, "down", false);
    } else {
      if (single ? rect.c0 === 0 : rect.c0 === rect.c1) return;
      const col = single ? rect.c0 - 1 : rect.c0;
      await fillBlock({ ...rect, c0: col, c1: col }, rect, "right", false);
    }
  };

  const clearRange = async () => {
    const rect = pickedRect();
    const writes: CellWrite[] = [];
    for (const { row } of rowsBetween(rect.r0, rect.r1)) {
      if (!row) continue;
      for (let c = rect.c0; c <= rect.c1; c++) {
        const prop = columns[c]?.property;
        if (editable(prop)) writes.push({ row, prop, value: prop.type === "title" ? "" : prop.type === "checkbox" ? false : prop.type === "relation" ? [] : null });
      }
    }
    await applyCells(writes);
  };

  const start = useCallback(
    (cell: Cell, seed?: string) => {
      if (READ_ONLY) return;
      const row = table.rowAt(cell.row);
      const prop = columns[cell.col]?.property;
      if (!row || !prop || !TYPE_META[prop.type].editable) return;
      setRange(null);
      if (prop.type === "checkbox") {
        void commit(row, prop, row.values[prop.id] !== true);
        return;
      }
      if (isPopoverType(prop.type)) {
        const el = cellEl(cell.row, cell.col);
        if (el) setAnchor(anchorOf(el));
        setEditing({ ...cell, mode: "popover", seed });
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
    if (e.key === "Escape" && !editing && range) {
      e.preventDefault();
      setRange(null);
      return;
    }
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
    const bounds = { rows: table.rowCount, cols: columns.length };
    if (e.shiftKey && NAV_KEYS.includes(e.key)) {
      e.preventDefault();
      const extended = extendRange(range, active, e.key, bounds, e.ctrlKey || e.metaKey);
      if (extended) {
        setRange(isSingle(extended) ? null : extended);
        go(extended.focus);
      }
      return;
    }
    const next = moveCell(active, e.key, bounds, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    if (next) {
      e.preventDefault();
      setRange(null);
      return go(next);
    }
    if (!row || !prop) return;
    if (e.key === " " && (prop.type === "checkbox" || isPopoverType(prop.type))) {
      e.preventDefault(); start(active);
    } else if (isTypingKey(e) && ["title", "text", "number", "url", "email", "phone", "select", "status", "multi_select"].includes(prop.type)) {
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
    // The first Ctrl+A picks every loaded cell; with rows ticked, or pressed again, it ticks every loaded row.
    "grid-select-all": gridCommand(() => {
      const all = fullRange(table.rowCount, columns.length);
      if (all && selected.size === 0 && !coversAll(range, table.rowCount, columns.length)) return void setRange(all);
      setAllTicked(true);
    }),
    "grid-copy": gridCommand(() => void copyRange()),
    "grid-paste": gridCommand(() => { if (READ_ONLY) return false; void pasteClipboard(); }),
    "grid-fill-down": gridCommand(() => { if (READ_ONLY) return false; void fillFromEdge("down"); }),
    "grid-fill-right": gridCommand(() => { if (READ_ONLY) return false; void fillFromEdge("right"); }),
    "grid-find": gridCommand(() => { if (!onFind) return false; onFind(); }),
    "grid-undo": gridCommand(() => void replay("undo")),
    "grid-redo": gridCommand(() => void replay("redo")),
    "grid-open": gridCommand(cell => { const row = table.rowAt(cell.row); if (!row) return false; openRecord(row); }),
    "grid-edit": gridCommand(cell => { if (READ_ONLY || table.itemAt(cell.row).type === "header") return false; start(cell); }),
    "grid-clear": gridCommand(cell => { if (!isSingle(range)) { if (READ_ONLY) return false; void clearRange(); return; } const row = table.rowAt(cell.row), prop = columns[cell.col]?.property; if (READ_ONLY || !row || !prop || !TYPE_META[prop.type].editable) return false; void commit(row, prop, prop.type === "title" ? "" : prop.type === "checkbox" ? false : null); }),
    "grid-menu": gridCommand(cell => { const row = table.rowAt(cell.row); if (!row) return false; const rect = cellEl(cell.row, cell.col)?.getBoundingClientRect(); openMenu(rect?.left ?? 0, rect?.bottom ?? 0, row, cell); }),
  });

  const finishInline = (row: RecordRow, prop: Property, cell: Cell, result: { value: unknown } | null, move: Move) => {
    setEditing(null);
    if (result) void commit(row, prop, result.value);
    if (move === "down" && !READ_ONLY && cell.row >= table.rowCount - 1) {
      // Enter on the last row starts a new record, like the end of a spreadsheet list.
      onCreate();
      return;
    }
    const target =
      move === "down" ? { row: Math.min(table.rowCount - 1, cell.row + 1), col: cell.col } : move === "right" ? moveCell(cell, "Tab", { rows: table.rowCount, cols: columns.length }) : move === "left" ? moveCell(cell, "Tab", { rows: table.rowCount, cols: columns.length }, { shift: true }) : cell;
    if (target) go(target);
    focusGrid();
  };

  const trash = async (rows: RecordRow[]) => {
    const done: RecordRow[] = [];
    try {
      for (const row of rows) {
        await ipc.pageDelete(row.pageId);
        done.push(row);
      }
    } catch (e) {
      setError(`${done.length} of ${rows.length} moved to trash. ${toAppError(e).message}`);
    }
    if (!done.length) return;
    setSelected(new Map());
    setRange(null);
    table.reload();
    notify(done.length === 1 ? `Moved “${done[0].title || "Untitled"}” to trash` : `Moved ${done.length} records to trash`, async () => {
      for (const row of done) await ipc.pageRestore(row.pageId).catch((e) => setError(toAppError(e).message));
      table.reload();
    });
  };

  const duplicate = async (rows: RecordRow[]) => {
    const made: RecordRow[] = [];
    try {
      for (const row of rows) {
        const copy = await ipc.recordDuplicate(row.id);
        table.addExtra(copy);
        made.push(copy);
      }
    } catch (e) {
      setError(toAppError(e).message);
    }
    if (!made.length) return;
    setHistory(record(history(), { edits: [], created: made.map((r) => ({ id: r.id, pageId: r.pageId, title: r.title })) }));
    notify(made.length === 1 ? "Record duplicated. It is added at the end of the list." : `Duplicated ${made.length} records. They are added at the end of the list.`);
  };

  /** "Filter by this value" and "Exclude this value": adds a condition to the view's filter. */
  const valueFilterItems = (prop: Property, row: RecordRow): MenuItem[] => {
    const add = (exclude: boolean) => {
      const node = quickCondition(prop, row, exclude);
      if (node) db.updateView({ filter: andCondition(view.filter, node) }, { rows: true });
    };
    return [
      { label: "Filter by this value", separated: true, disabled: !quickCondition(prop, row, false), onSelect: () => add(false) },
      { label: "Exclude this value", disabled: !quickCondition(prop, row, true), onSelect: () => add(true) },
    ];
  };

  const menuItems = (row: RecordRow, cell: Cell, rows: RecordRow[]): MenuItem[] => rows.length > 1 ? [
    { label: `Open ${rows.length} records`, onSelect: () => rows.forEach(openRecord), disabled: rows.length > 5 },
    { label: `Duplicate ${rows.length} records`, onSelect: () => void duplicate(rows), separated: true },
    { label: `Move ${rows.length} records to trash`, danger: true, separated: true, onSelect: () => void trash(rows) },
  ] : [
    ...(columns[cell.col] ? [
      { label: "Copy cell value", disabled: !cellPlain(columns[cell.col].property, row), onSelect: () => void copyText(cellPlain(columns[cell.col].property, row)) },
      ...(TYPE_META[columns[cell.col].property.type].editable ? [{ label: columns[cell.col].property.type === "checkbox" ? "Toggle checkbox" : "Edit cell…", shortcut: "grid-edit", onSelect: () => start(cell) }] : []),
    ] : []),
    ...(columns[cell.col] ? valueFilterItems(columns[cell.col].property, row) : []),
    { label: "Open", shortcut: "grid-open", onSelect: () => openRecord(row), separated: true },
    { label: "Copy link", shortcut: "copy-link", onSelect: () => void copyPageLink(row.pageId) },
    { label: "Duplicate", shortcut: "duplicate", onSelect: () => void duplicate([row]) },
    { label: "Move to trash", danger: true, separated: true, onSelect: () => void trash([row]) },
  ];

  const sortOf = (id: string) => view.sorts.find((s) => s.propertyId === id)?.direction;
  const setSort = (id: string, direction: "asc" | "desc" | null) =>
    db.updateView({ sorts: direction ? [{ propertyId: id, direction }, ...view.sorts.filter((s) => s.propertyId !== id)] : view.sorts.filter((s) => s.propertyId !== id) }, { rows: true });

  const columnIndex = (prop: Property) => columns.findIndex((c) => c.property.id === prop.id);
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
      ...(onFilterColumn && isFilterable(prop) ? [{ label: "Filter…", separated: !isSortable(prop), onSelect: () => onFilterColumn(prop, anchorEl) }] : []),
      ...(groupable(prop.type)
        ? [
            view.group?.propertyId === prop.id
              ? { label: "Remove grouping", onSelect: () => db.updateView({ group: null, subgroup: null }, { rows: true }) }
              : { label: "Group by this property", onSelect: () => db.updateView({ group: { propertyId: prop.id }, subgroup: view.subgroup?.propertyId === prop.id ? null : view.subgroup }, { rows: true }) },
          ]
        : []),
      { label: "Move left", separated: true, onSelect: () => db.moveColumn(prop.id, -1) },
      { label: "Move right", onSelect: () => db.moveColumn(prop.id, 1) },
      ...(READ_ONLY
        ? []
        : [
            { label: "Insert left", onSelect: () => void db.insertProperty(prop.id, "left"), disabled: prop.type === "title" },
            { label: "Insert right", onSelect: () => void db.insertProperty(prop.id, "right") },
          ]),
      ...(prop.type !== "title" && prop.type !== "relation" && !READ_ONLY ? [{ label: "Duplicate property", onSelect: () => void db.duplicateProperty(prop.id) }] : []),
      ...(textual(prop)
        ? [{ label: "Wrap text", separated: true, checked: wrapped.has(prop.id), onSelect: () => db.updateView({ wrapColumns: toggleWrap(view.wrapColumns, prop.id, !wrapped.has(prop.id)) }) }]
        : []),
      ...(columnIndex(prop) > 0 && columnIndex(prop) <= 3
        ? [{ label: frozen === columnIndex(prop) ? "Unfreeze columns" : "Freeze columns up to here", separated: !textual(prop), onSelect: () => db.updateView({ frozenColumns: frozen === columnIndex(prop) ? 0 : Math.min(columnIndex(prop), 3) }) }]
        : []),
      ...(prop.type !== "title" ? [{ label: "Hide in view", separated: true, onSelect: () => db.patchColumn(prop.id, { hidden: true }) }, { label: "Delete property", danger: true, onSelect: () => setDeleting({ prop, anchor: anchorEl }) }] : []),
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

  const cellAtPoint = (x: number, y: number): Cell | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-row-index][data-column-index]");
    return el ? { row: Number(el.dataset.rowIndex), col: Number(el.dataset.columnIndex) } : null;
  };

  /** Follows the pointer across cells until the button is released, scrolling when it nears an edge. */
  const trackPointer = (onMove: (cell: Cell) => void, onEnd: () => void) => {
    const move = (ev: MouseEvent) => {
      const box = scroller.current?.getBoundingClientRect();
      const el = scroller.current;
      if (box && el) {
        if (ev.clientY > box.bottom - 24) el.scrollTop += 24;
        else if (ev.clientY < box.top + 60) el.scrollTop -= 24;
        if (ev.clientX > box.right - 24) el.scrollLeft += 24;
        else if (ev.clientX < box.left + 24) el.scrollLeft -= 24;
      }
      const cell = cellAtPoint(ev.clientX, ev.clientY);
      if (cell) onMove(cell);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      onEnd();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const startFill = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const src = pickedRect();
    let latest: ReturnType<typeof fillTarget> = null;
    trackPointer(
      (cell) => {
        latest = fillTarget(src, cell);
        setFillPreview(latest ? latest.rect : null);
      },
      () => {
        setFillPreview(null);
        const plan = latest;
        if (!plan) return;
        setRange({ anchor: { row: plan.rect.r0, col: plan.rect.c0 }, focus: { row: plan.rect.r1, col: plan.rect.c1 } });
        void fillBlock(src, plan.rect, plan.dir, true);
      },
    );
  };

  /** Double-click on a column edge: widen or narrow it to its longest loaded value. */
  const fitColumn = (c: Column, i: number) => {
    const el = scroller.current;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!el || !ctx) return;
    const style = getComputedStyle(el);
    ctx.font = style.font || `${style.fontSize} ${style.fontFamily}`;
    const measure = (t: string) => ctx.measureText(t).width;
    const pad = 22 + (i === 0 ? 28 : 0);
    let widest = measure(c.property.name) + 14 + 6 + 28;
    for (const { row } of allLoaded.slice(0, 1000)) {
      const text = c.property.type === "checkbox" ? "" : cellText(c.property, row);
      if (!text) continue;
      const tags = c.property.type === "multi_select" ? (Array.isArray(row.values[c.property.id]) ? (row.values[c.property.id] as unknown[]).length : 0) * 16 : isOptionType(c.property.type) ? 16 : 0;
      widest = Math.max(widest, measure(text) + pad + tags);
    }
    const width = Math.max(60, Math.min(800, Math.ceil(widest)));
    if (width !== widths[i]) db.patchColumn(c.property.id, { width });
  };

  const picked = range ? rectOf(range) : null;

  // Count, sum and average of the picked block (loaded rows only).
  const selection = useMemo(() => {
    if (!range || isSingle(range)) return null;
    const rect = rectOf(range);
    const cells: { prop: Property; value: unknown }[] = [];
    let unloaded = 0;
    for (let r = rect.r0; r <= Math.min(rect.r1, table.rowCount - 1); r++) {
      const item = table.itemAt(r);
      if (item.type !== "row") continue;
      if (!item.row) {
        unloaded++;
        continue;
      }
      for (let c = rect.c0; c <= rect.c1; c++) if (columns[c]) cells.push({ prop: columns[c].property, value: cellValue(columns[c].property, item.row) });
    }
    return { ...summarizeSelection(cells), unloaded };
  }, [range, table, columns]);
  const rules = view.formats ?? [];
  const showFooter = showTotals && !READ_ONLY ? columns.length > 0 : showTotals && columns.some((c) => c.column.aggregate);
  const groupTotals = useMemo(() => new Map((totals?.groups ?? []).map((g) => [g.key, g])), [totals]);
  const handleAt: Cell | null = READ_ONLY || editing ? null : picked ? { row: picked.r1, col: picked.c1 } : active;

  const activeId = columns.length && table.rowCount ? `cell-${active.row}-${active.col}` : undefined;
  const editRow = editing ? table.rowAt(editing.row) : null;
  const editProp = editing ? columns[editing.col]?.property : undefined;
  const empty = table.loaded && table.rowCount === 0;
  const filtered = view.filter !== null;

  return (
    <div
      ref={scroller}
      className={`grid-scroll${selected.size ? " selecting" : ""}`}
      style={{ ...(showFooter ? { "--foot": `${ROW_HEIGHT}px` } : null), "--wrap-lines": Math.max(1, Math.floor((ROW_HEIGHT - 10) / 18)) } as React.CSSProperties}
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
          if (row) openMenu(e.clientX, e.clientY, row);
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
                className={`hcell${i <= frozen ? " sticky" : ""}${frozen > 0 && i === frozen ? " edge" : ""}`}
                style={i > 0 && i <= frozen ? { left: offsets[i] } : undefined}
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
                <span className="resizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={`Resize ${c.property.name}`} aria-valuemin={60} aria-valuemax={800} aria-valuenow={widths[i]} onPointerDown={(e) => startResize(e, c, i)} onDoubleClick={(e) => {
                  e.stopPropagation();
                  fitColumn(c, i);
                }} onKeyDown={(e) => {
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
                  {h.level === 0 && groupTotals.has(h.key) && (
                    <div className="group-sums" aria-hidden="true" style={{ gridTemplateColumns: template }}>
                      {columns.map((c, ci) => {
                        const kind = c.column.aggregate;
                        const value = ci > 0 && kind ? groupTotals.get(h.key)?.values.find((x) => x.propertyId === c.property.id) : undefined;
                        const text = kind && value ? formatAggregate(kind, value.value, c.property) : "";
                        return <span key={c.property.id} className="group-sum">{text}</span>;
                      })}
                    </div>
                  )}
                </div>
              );
            }
            const row = item.row;
            const tones = row ? evaluateRules(rules, row, db.byId) : null;
            return (
              <div
                key={v.key}
                role="row"
                aria-rowindex={v.index + 2}
                aria-selected={row ? selected.has(row.id) : undefined}
                data-tone={tones?.row ?? undefined}
                className={`row${view.rowHeight === "tall" ? " tall" : ""}${row ? "" : " skeleton"}${active.row === v.index ? " current" : ""}${row && selected.has(row.id) ? " ticked" : ""}`}
                style={{ transform: `translateY(${v.start}px)`, height: ROW_HEIGHT, gridTemplateColumns: template }}
                onContextMenu={(e) => {
                  if (!row) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const target = (e.target as Element).closest<HTMLElement>("[data-column-index]");
                  const cell = { row: v.index, col: target ? Number(target.dataset.columnIndex) : active.col };
                  openMenu(e.clientX, e.clientY, row, cell);
                  setActive(cell);
                }}
              >
                {columns.map((c, ci) => {
                  const isActive = active.row === v.index && active.col === ci;
                  const isEditing = editing?.mode === "inline" && editing.row === v.index && editing.col === ci;
                  const meta = TYPE_META[c.property.type];
                  const inPick = !!picked && inRect(picked, v.index, ci);
                  const inFill = !!fillPreview && inRect(fillPreview, v.index, ci) && !(picked && inPick);
                  const issue = row ? checkCell(c.property, row, uniqueFlags.get(c.property.id)?.has(row.id) ?? false) : null;
                  const edges = inPick && picked ? `${v.index === picked.r0 ? " rt" : ""}${v.index === picked.r1 ? " rb" : ""}${ci === picked.c0 ? " rl" : ""}${ci === picked.c1 ? " rr" : ""}` : "";
                  return (
                    <div
                      key={c.property.id}
                      id={`cell-${v.index}-${ci}`}
                      data-column-index={ci}
                      data-row-index={v.index}
                      data-tone={tones?.cells.get(c.property.id)}
                      role="gridcell"
                      aria-selected={isActive || inPick}
                      aria-readonly={READ_ONLY || !meta.editable}
                      aria-label={row ? `${c.property.name}: ${cellText(c.property, row) || "empty"}${issue ? `. Problem: ${issue}` : ""}` : undefined}
                      aria-invalid={issue ? true : undefined}
                      title={issue ?? undefined}
                      style={ci > 0 && ci <= frozen ? { left: offsets[ci] } : undefined}
                      className={`cell${ci <= frozen ? " sticky" : ""}${frozen > 0 && ci === frozen ? " edge" : ""}${issue ? " invalid" : ""}${wrapped.has(c.property.id) ? " wrap" : ""}${isActive ? " active" : ""}${isEditing ? " editing" : ""}${inPick ? " in-range" : ""}${edges}${inFill ? " in-fill" : ""}${c.property.type === "number" ? " num" : ""}${meta.editable ? "" : " readonly"}`}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        if (editing && !(editing.row === v.index && editing.col === ci)) setEditing(null);
                        const here = { row: v.index, col: ci };
                        // Shift+click stretches the block from the active cell.
                        if (e.shiftKey && !editing) {
                          e.preventDefault();
                          const block = { anchor: range?.anchor ?? active, focus: here };
                          setRange(isSingle(block) ? null : block);
                          setActive(here);
                          window.setTimeout(focusGrid, 0);
                          return;
                        }
                        setActive(here);
                        setRange(null);
                        // Keep keyboard focus on the grid unless the cell opens its own editor.
                        window.setTimeout(() => !editing && focusGrid(), 0);
                        // Dragging from a cell picks a block.
                        if (!editing && row) {
                          trackPointer(
                            (cell) => {
                              const block = { anchor: here, focus: cell };
                              setRange(isSingle(block) ? null : block);
                              setActive(cell);
                            },
                            () => {},
                          );
                        }
                      }}
                      onClick={(e) => {
                        if (!row || !meta.editable || isEditing || e.shiftKey) return;
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
                            {handleAt && row && handleAt.row === v.index && handleAt.col === ci && (
                              <span className="fill-handle" aria-hidden="true" title="Drag to fill" onMouseDown={startFill} />
                            )}
                            {c.property.type === "title" && <TaskScheduleHandle row={row} />}
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
        {selection && selected.size === 0 && (
          <div className="sel-strip-wrap">
            <div className="sel-strip" role="status" title={selection.unloaded ? "Rows that are not loaded yet are left out." : undefined}>
              <span>
                Count <b>{selection.count.toLocaleString()}</b>
              </span>
              {selection.average !== null && (
                <>
                  <span>
                    Sum <b>{formatNumberWith(selection.sum, selection.format ?? null)}</b>
                  </span>
                  <span>
                    Average <b>{formatNumberWith(selection.format?.decimals === undefined ? Math.round(selection.average * 100) / 100 : selection.average, selection.format ?? null)}</b>
                  </span>
                </>
              )}
              {selection.unloaded > 0 && <span className="sel-note">loaded rows only</span>}
            </div>
          </div>
        )}
        {showFooter && table.loaded && (
          <TotalsFooter
            columns={columns}
            template={template}
            height={ROW_HEIGHT}
            totals={totals}
            locked={READ_ONLY}
            onPick={(id, kind: AggregateKind | null) => db.patchColumn(id, { aggregate: kind })}
          />
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
          initialQuery={editing?.seed}
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

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row, menu.cell ?? active, menu.rows)} onClose={() => { setMenu(null); focusGrid(); }} />}
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

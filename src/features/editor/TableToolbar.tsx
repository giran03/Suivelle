import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { Icon } from "../../components/Icon";
import { effective, format } from "../shortcuts/bindings";
import { useShortcuts } from "../shortcuts/store";

interface Span { start: number; size: number }
interface Layout {
  cols: Span[];
  rows: Span[];
  top: number;
  left: number;
  right: number;
  bottom: number;
  activeCol: number;
  activeRow: number;
  pickedCols: Set<number>;
  pickedRows: Set<number>;
  whole: boolean;
}

const GRIP = 14;
const isCell = (name: string) => name === "tableCell" || name === "tableHeader";

/** Reads the caret's table from the document and the cell boxes from the DOM, in viewport coordinates. */
function measure(editor: Editor): Layout | null {
  if (editor.isDestroyed || !editor.isEditable) return null;
  const { selection } = editor.state;
  const $from = selection.$from;
  let cellDepth = -1;
  for (let d = $from.depth; d >= 1; d--) if (isCell($from.node(d).type.name)) { cellDepth = d; break; }
  if (cellDepth < 2) return null;
  const tableDom = editor.view.nodeDOM($from.before(cellDepth - 2)) as HTMLElement | null;
  const table = tableDom?.matches("table") ? tableDom : tableDom?.querySelector("table");
  if (!table || !(table instanceof HTMLTableElement) || table.rows.length === 0) return null;

  const box = table.getBoundingClientRect();
  const rows: Span[] = Array.from(table.rows, (row) => {
    const r = row.getBoundingClientRect();
    return { start: r.top, size: r.height };
  });
  const cols: Span[] = Array.from(table.rows[0].cells, (cell) => {
    const r = cell.getBoundingClientRect();
    return { start: r.left, size: r.width };
  });

  const pickedCols = new Set<number>();
  const pickedRows = new Set<number>();
  let whole = false;
  if (selection instanceof CellSelection) {
    selection.forEachCell((_node, pos) => {
      const dom = editor.view.nodeDOM(pos);
      if (dom instanceof HTMLTableCellElement) {
        pickedCols.add(dom.cellIndex);
        pickedRows.add((dom.parentElement as HTMLTableRowElement).rowIndex);
      }
    });
    whole = pickedCols.size === cols.length && pickedRows.size === rows.length;
  }
  return {
    cols, rows, whole, pickedCols, pickedRows,
    top: box.top, left: box.left, right: box.right, bottom: box.bottom,
    activeCol: $from.index(cellDepth - 1),
    activeRow: $from.index(cellDepth - 2),
  };
}

/**
 * Spreadsheet-style table controls. Header strips sit on the table's top and left edges while the caret is
 * inside it; clicking one selects that column or row and opens its menu. The two "+" ends append a column or row.
 */
export function TableToolbar({ editor }: { editor: Editor }) {
  const overrides = useShortcuts((s) => s.overrides);
  const [layout, setLayout] = useState<Layout | null>(() => measure(editor));
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const refresh = useCallback(() => setLayout(measure(editor)), [editor]);
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refresh);
    };
    editor.on("transaction", schedule);
    editor.on("selectionUpdate", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      editor.off("transaction", schedule);
      editor.off("selectionUpdate", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [editor, refresh]);

  if (!layout) return null;

  const keep = (e: React.MouseEvent) => e.preventDefault(); // pressing a strip must not move the caret
  const run = (fn: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => () => void fn(editor.chain().focus()).run();

  /** Selects through the document so the highlight and the menu commands agree on what is affected. */
  const select = (kind: "col" | "row" | "table", index: number) => {
    const table = editor.view.nodeDOM(editor.state.selection.$from.before(findCellDepth(editor) - 2)) as HTMLElement | null;
    const dom = table?.matches("table") ? table : table?.querySelector("table");
    if (!(dom instanceof HTMLTableElement)) return;
    const at = (row: number, col: number) => {
      const cell = dom.rows[row]?.cells[col];
      return cell ? editor.state.doc.resolve(editor.view.posAtDOM(cell, 0) - 1) : null;
    };
    const lastRow = dom.rows.length - 1;
    const lastCol = dom.rows[0].cells.length - 1;
    let selection: CellSelection | null = null;
    if (kind === "col") {
      const head = at(0, index);
      if (head) selection = CellSelection.colSelection(head);
    } else if (kind === "row") {
      const head = at(index, 0);
      if (head) selection = CellSelection.rowSelection(head);
    } else {
      const first = at(0, 0), last = at(lastRow, lastCol);
      if (first && last) selection = new CellSelection(first, last);
    }
    if (selection) editor.view.dispatch(editor.state.tr.setSelection(selection));
  };

  const open = (e: React.MouseEvent, kind: "col" | "row" | "table", index: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    select(kind, index);
    const items: MenuItem[] =
      kind === "col"
        ? [
            { label: "Insert column left", onSelect: run((c) => c.addColumnBefore()) },
            { label: "Insert column right", onSelect: run((c) => c.addColumnAfter()) },
            { label: "Delete column", danger: true, separated: true, onSelect: run((c) => c.deleteColumn()) },
          ]
        : kind === "row"
          ? [
              { label: "Insert row above", onSelect: run((c) => c.addRowBefore()) },
              { label: "Insert row below", onSelect: run((c) => c.addRowAfter()) },
              { label: "Delete row", danger: true, separated: true, onSelect: run((c) => c.deleteRow()) },
            ]
          : [{ label: "Delete table", danger: true, onSelect: run((c) => c.deleteTable()) }];
    setMenu(kind === "row" ? { x: rect.right + 4, y: rect.top, items } : { x: rect.left, y: rect.bottom + 4, items });
  };

  const stateOf = (picked: Set<number>, index: number, active: number) =>
    picked.has(index) ? " is-picked" : picked.size === 0 && index === active ? " is-active" : "";

  const last = layout.cols.length - 1;
  const lastRow = layout.rows.length - 1;
  const columnAddLeft = layout.cols[last].start + layout.cols[last].size + 4;
  const rowAddTop = layout.rows[lastRow].start + layout.rows[lastRow].size + 4;
  const shortcut = (id: string) => effective(id, overrides).map(format).join(" or ") || "Unassigned";
  const shortcutTip = `Insert row below: ${shortcut("insert-above")}. Insert column right: ${shortcut("table-column-right")}. The cursor moves into the new cell.`;
  return createPortal(
    <>
    <div className="tbl-controls" role="toolbar" aria-label="Table">
      <button type="button" className="tbl-add tbl-info"
        style={{ left: columnAddLeft - (20 - GRIP) / 2, top: rowAddTop - (20 - GRIP) / 2 }}
        aria-label="Table shortcuts" data-tooltip={shortcutTip} onMouseDown={keep}>
        <Icon name="note" size={14} />
      </button>
      <button type="button" className={`tbl-grip tbl-corner${layout.whole ? " is-picked" : ""}`} style={{ left: layout.left - GRIP - 2, top: layout.top - GRIP - 2 }} aria-label="Table options" title="Select table" onMouseDown={keep} onClick={(e) => open(e, "table", 0)} />
      {layout.cols.map((c, i) => (
        <button key={`c${i}`} type="button" className={`tbl-grip tbl-col${stateOf(layout.pickedCols, i, layout.activeCol)}`} style={{ left: c.start, width: c.size, top: layout.top - GRIP - 2 }} aria-label={`Column ${i + 1}`} title="Select column" onMouseDown={keep} onClick={(e) => open(e, "col", i)} />
      ))}
      {layout.rows.map((r, i) => (
        <button key={`r${i}`} type="button" className={`tbl-grip tbl-row${stateOf(layout.pickedRows, i, layout.activeRow)}`} style={{ top: r.start, height: r.size, left: layout.left - GRIP - 2 }} aria-label={`Row ${i + 1}`} title="Select row" onMouseDown={keep} onClick={(e) => open(e, "row", i)} />
      ))}
      <button type="button" className="tbl-add" style={{ left: columnAddLeft, top: layout.top - GRIP - 2 }} aria-label="Add column" title="Add column" onMouseDown={keep} onClick={() => { editor.chain().focus().setTextSelection(lastCellPos(editor, "col")).addColumnAfter().run(); }}>
        <Icon name="plus" size={12} />
      </button>
      <button type="button" className="tbl-add" style={{ left: layout.left - GRIP - 2, top: rowAddTop }} aria-label="Add row" title="Add row" onMouseDown={keep} onClick={() => { editor.chain().focus().setTextSelection(lastCellPos(editor, "row")).addRowAfter().run(); }}>
        <Icon name="plus" size={12} />
      </button>
    </div>
    {/* Outside the click-through layer: the menu would otherwise inherit pointer-events: none. */}
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>,
    document.body,
  );
}

function findCellDepth(editor: Editor): number {
  const $from = editor.state.selection.$from;
  for (let d = $from.depth; d >= 1; d--) if (isCell($from.node(d).type.name)) return d;
  return 0;
}

/** A text position inside the table's last column or last row, so "add after" appends at the far edge. */
function lastCellPos(editor: Editor, edge: "col" | "row"): number {
  const $from = editor.state.selection.$from;
  const depth = findCellDepth(editor);
  const table = $from.node(depth - 2);
  const rowIndex = edge === "row" ? table.childCount - 1 : $from.index(depth - 2);
  const row = table.child(rowIndex);
  const colIndex = edge === "col" ? row.childCount - 1 : $from.index(depth - 1);
  let pos = $from.start(depth - 2);
  for (let r = 0; r < rowIndex; r++) pos += table.child(r).nodeSize;
  pos += 1; // into the row
  for (let c = 0; c < Math.min(colIndex, row.childCount - 1); c++) pos += row.child(c).nodeSize;
  return pos + 2; // into the cell's first paragraph
}

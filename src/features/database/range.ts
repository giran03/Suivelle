import { moveCell, type Bounds, type Cell } from "./gridNav";

/** A rectangular block of cells: where it started and where the pointer or caret is now. */
export interface Range {
  anchor: Cell;
  focus: Cell;
}

/** The block as inclusive row and column limits, whichever way it was dragged. */
export interface Rect {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export const rectOf = (r: Range): Rect => ({
  r0: Math.min(r.anchor.row, r.focus.row),
  r1: Math.max(r.anchor.row, r.focus.row),
  c0: Math.min(r.anchor.col, r.focus.col),
  c1: Math.max(r.anchor.col, r.focus.col),
});

export const inRect = (rect: Rect, row: number, col: number) => row >= rect.r0 && row <= rect.r1 && col >= rect.c0 && col <= rect.c1;
export const rectRows = (rect: Rect) => rect.r1 - rect.r0 + 1;
export const rectCols = (rect: Rect) => rect.c1 - rect.c0 + 1;
export const isSingle = (r: Range | null) => !r || (r.anchor.row === r.focus.row && r.anchor.col === r.focus.col);

/** Moves the focus end of a range one navigation step, keeping the anchor. */
export function extendRange(range: Range | null, active: Cell, key: string, b: Bounds, ctrl = false): Range | null {
  const from = range?.focus ?? active;
  const next = moveCell(from, key, b, { ctrl });
  if (!next || key === "Tab") return null;
  return { anchor: range?.anchor ?? active, focus: next };
}

/** A range over every cell of a table of the given size, or null when it is empty. */
export function fullRange(rows: number, cols: number): Range | null {
  return rows > 0 && cols > 0 ? { anchor: { row: 0, col: 0 }, focus: { row: rows - 1, col: cols - 1 } } : null;
}

export function coversAll(range: Range | null, rows: number, cols: number): boolean {
  if (!range) return false;
  const r = rectOf(range);
  return r.r0 === 0 && r.c0 === 0 && r.r1 === rows - 1 && r.c1 === cols - 1;
}

/** The rectangle a fill handle drag covers: the source block grown toward the pointer, down or right. */
export function fillTarget(source: Rect, pointer: Cell): { dir: "down" | "right"; rect: Rect } | null {
  const down = pointer.row - source.r1;
  const right = pointer.col - source.c1;
  if (down <= 0 && right <= 0) return null;
  if (down >= right) return { dir: "down", rect: { ...source, r1: pointer.row } };
  return { dir: "right", rect: { ...source, c1: pointer.col } };
}

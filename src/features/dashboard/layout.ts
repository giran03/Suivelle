import type { Widget } from "../../types";

/** A dashboard is a twelve-column grid; a row is a fixed height. Sizes are in grid cells. */
export const COLS = 12;
export const MIN_W = 2;
export const MIN_H = 1;
export const MAX_H = 40;
export const MAX_Y = 400;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function clampRect(r: Rect): Rect {
  const w = Math.min(COLS, Math.max(MIN_W, Math.round(r.w)));
  const h = Math.min(MAX_H, Math.max(MIN_H, Math.round(r.h)));
  return { w, h, x: Math.min(COLS - w, Math.max(0, Math.round(r.x))), y: Math.min(MAX_Y, Math.max(0, Math.round(r.y))) };
}

/**
 * Lets every widget settle as high as it can without overlapping another, the pinned one staying
 * where it is. Widgets keep their order in the list; only their positions change.
 */
export function settle(widgets: Widget[], pinned?: string): Widget[] {
  const placed: Widget[] = [];
  const pin = widgets.find((w) => w.id === pinned);
  if (pin) placed.push(pin);
  const moved = new Map<string, Widget>();
  if (pin) moved.set(pin.id, pin);
  const rest = widgets.filter((w) => w.id !== pinned).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const w of rest) {
    let y = 0;
    for (;;) {
      const hits = placed.filter((p) => overlaps({ ...w, y }, p));
      if (hits.length === 0) break;
      y = Math.max(...hits.map((p) => p.y + p.h));
    }
    const next = { ...w, y };
    placed.push(next);
    moved.set(w.id, next);
  }
  return widgets.map((w) => moved.get(w.id) ?? w);
}

/** Moves or resizes one widget; the others make room. */
export function place(widgets: Widget[], id: string, to: Rect): Widget[] {
  const r = clampRect(to);
  return settle(
    widgets.map((w) => (w.id === id ? { ...w, ...r } : w)),
    id,
  );
}

/** Where a new widget of this size goes: the left edge, below everything. */
export function slotFor(widgets: Widget[], w: number, h: number): Rect {
  return clampRect({ x: 0, y: Math.max(0, ...widgets.map((x) => x.y + x.h)), w, h });
}

/** Rows the grid needs to show every widget. */
export const rowsOf = (widgets: Widget[]) => Math.max(0, ...widgets.map((w) => w.y + w.h));

/** The pixel box of a rect in a grid `width` pixels wide. */
export function boxOf(r: Rect, width: number, rowHeight: number, gap: number) {
  const col = (width - gap * (COLS - 1)) / COLS;
  return {
    left: r.x * (col + gap),
    top: r.y * (rowHeight + gap),
    width: r.w * col + (r.w - 1) * gap,
    height: r.h * rowHeight + (r.h - 1) * gap,
  };
}

/** The grid cell a pixel offset falls in (used while dragging). */
export function cellsFor(dx: number, dy: number, width: number, rowHeight: number, gap: number) {
  const col = (width - gap * (COLS - 1)) / COLS;
  return { dx: Math.round(dx / (col + gap)), dy: Math.round(dy / (rowHeight + gap)) };
}

/** Pure geometry for the canvas view: no DOM, so it can be tested on its own. */

export interface Viewport {
  /** Screen offset of the world origin, in pixels. */
  x: number;
  y: number;
  /** Zoom factor. */
  k: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
export const DEFAULT_VIEWPORT: Viewport = { x: 40, y: 40, k: 1 };

export const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

export const toWorld = (v: Viewport, sx: number, sy: number) => ({ x: (sx - v.x) / v.k, y: (sy - v.y) / v.k });
export const toScreen = (v: Viewport, wx: number, wy: number) => ({ x: wx * v.k + v.x, y: wy * v.k + v.y });

/** Zooms by `factor` while keeping the world point under the screen point (sx, sy) where it is. */
export function zoomAt(v: Viewport, sx: number, sy: number, factor: number): Viewport {
  const k = clampZoom(v.k * factor);
  if (k === v.k) return v;
  const w = toWorld(v, sx, sy);
  return { k, x: sx - w.x * k, y: sy - w.y * k };
}

export function bounds(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** A viewport that shows `content` centered inside a `width` x `height` screen, with a margin. */
export function fitViewport(content: Box | null, width: number, height: number, margin = 48): Viewport {
  if (!content || width <= 0 || height <= 0) return DEFAULT_VIEWPORT;
  const k = clampZoom(Math.min((width - margin * 2) / Math.max(content.w, 1), (height - margin * 2) / Math.max(content.h, 1), 1.5));
  return { k, x: (width - content.w * k) / 2 - content.x * k, y: (height - content.h * k) / 2 - content.y * k };
}

const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Where the line from `b`'s center toward `toward` leaves the box edge. */
export function edgePoint(b: Box, toward: { x: number; y: number }) {
  const c = center(b);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const t = Math.min(dx === 0 ? Infinity : b.w / 2 / Math.abs(dx), dy === 0 ? Infinity : b.h / 2 / Math.abs(dy));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** The arrow between two boxes: edge to edge along the line through their centers, plus its midpoint. */
export function arrowBetween(from: Box, to: Box) {
  const a = edgePoint(from, center(to));
  const b = edgePoint(to, center(from));
  return { a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

/** Free spots in a grid, left to right then down, starting at `origin`, skipping nothing: callers offset `origin` below existing items. */
export function gridSlots(count: number, origin: { x: number; y: number }, cell = { w: 260, h: 150 }, gap = 24, perRow = 5) {
  return Array.from({ length: count }, (_, i) => ({
    x: origin.x + (i % perRow) * (cell.w + gap),
    y: origin.y + Math.floor(i / perRow) * (cell.h + gap),
  }));
}

export const snap = (v: number, grid = 8) => Math.round(v / grid) * grid;

// ---- motion ----

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** Between two viewports: zoom moves geometrically (so 50% to 100% feels like 100% to 200%), position linearly. */
export function lerpViewport(a: Viewport, b: Viewport, t: number): Viewport {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, k: a.k * (b.k / a.k) ** t };
}

/** A viewport showing `box` with a margin, never zoomed past `maxK` (a lone small item is not blown up). */
export function zoomToBox(box: Box, width: number, height: number, margin = 80, maxK = 1.5): Viewport {
  const k = clampZoom(Math.min((width - margin * 2) / Math.max(box.w, 1), (height - margin * 2) / Math.max(box.h, 1), maxK));
  return { k, x: (width - box.w * k) / 2 - box.x * k, y: (height - box.h * k) / 2 - box.y * k };
}

/** The viewport after zooming to `k` around the screen point (sx, sy). */
export const zoomTo = (v: Viewport, sx: number, sy: number, k: number): Viewport => zoomAt(v, sx, sy, clampZoom(k) / v.k);

/** Zoom steps for the +/- buttons and keys: the next preset above or below the current zoom. */
const STEPS = [0.1, 0.125, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export function stepZoom(k: number, dir: 1 | -1): number {
  const eps = 0.005;
  return dir > 0 ? (STEPS.find((s) => s > k + eps) ?? MAX_ZOOM) : ([...STEPS].reverse().find((s) => s < k - eps) ?? MIN_ZOOM);
}

// ---- selection ----

export const intersects = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export function normalizeBox(x1: number, y1: number, x2: number, y2: number): Box {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

// ---- snapping ----

export interface Guide {
  axis: "x" | "y";
  /** World coordinate of the line. */
  at: number;
  from: number;
  to: number;
}

/**
 * Nudges a moving box so its edges or center line up with another box's, within `threshold` (world
 * units). Returns the correction to add and the guide lines to draw.
 */
export function snapMove(moving: Box, others: Box[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
  const ys = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
  let bestX: { d: number; at: number; other: Box } | null = null;
  let bestY: { d: number; at: number; other: Box } | null = null;
  for (const o of others) {
    const ox = [o.x, o.x + o.w / 2, o.x + o.w];
    const oy = [o.y, o.y + o.h / 2, o.y + o.h];
    for (const a of xs) for (const b of ox) if (Math.abs(b - a) <= threshold && (!bestX || Math.abs(b - a) < Math.abs(bestX.d))) bestX = { d: b - a, at: b, other: o };
    for (const a of ys) for (const b of oy) if (Math.abs(b - a) <= threshold && (!bestY || Math.abs(b - a) < Math.abs(bestY.d))) bestY = { d: b - a, at: b, other: o };
  }
  const dx = bestX?.d ?? 0;
  const dy = bestY?.d ?? 0;
  const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: Guide[] = [];
  if (bestX) guides.push({ axis: "x", at: bestX.at, from: Math.min(snapped.y, bestX.other.y), to: Math.max(snapped.y + snapped.h, bestX.other.y + bestX.other.h) });
  if (bestY) guides.push({ axis: "y", at: bestY.at, from: Math.min(snapped.x, bestY.other.x), to: Math.max(snapped.x + snapped.w, bestY.other.x + bestY.other.w) });
  return { dx, dy, guides };
}

// ---- arranging ----

export type Align = "left" | "center" | "right" | "top" | "middle" | "bottom";

/** New x/y per box id so the boxes line up on `how`, relative to their combined bounds. */
export function alignBoxes<T extends Box & { id: string }>(boxes: T[], how: Align): Map<string, { x: number; y: number }> {
  const b = bounds(boxes);
  const out = new Map<string, { x: number; y: number }>();
  if (!b) return out;
  for (const i of boxes) {
    out.set(i.id, {
      x: how === "left" ? b.x : how === "right" ? b.x + b.w - i.w : how === "center" ? b.x + (b.w - i.w) / 2 : i.x,
      y: how === "top" ? b.y : how === "bottom" ? b.y + b.h - i.h : how === "middle" ? b.y + (b.h - i.h) / 2 : i.y,
    });
  }
  return out;
}

/** Evenly spaces three or more boxes along an axis, keeping the outermost two where they are. */
export function distributeBoxes<T extends Box & { id: string }>(boxes: T[], axis: "x" | "y"): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (boxes.length < 3) return out;
  const size = axis === "x" ? "w" : "h";
  const sorted = [...boxes].sort((p, q) => p[axis] - q[axis]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const total = last[axis] + last[size] - first[axis];
  const gap = (total - sorted.reduce((s, i) => s + i[size], 0)) / (sorted.length - 1);
  let cursor = first[axis];
  for (const i of sorted) {
    out.set(i.id, axis === "x" ? { x: cursor, y: i.y } : { x: i.x, y: cursor });
    cursor += i[size] + gap;
  }
  return out;
}

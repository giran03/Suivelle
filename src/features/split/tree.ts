/**
 * Split-view geometry as a tree. A leaf is a pane (0 is the main view); a split lays its children
 * side by side ("x") or stacked ("y") with shares that add up to 1. Everything here is pure so the
 * shapes, docking and resize maths can be tested.
 */
export type Axis = "x" | "y";
export type Edge = "left" | "right" | "top" | "bottom";

export interface Leaf { leaf: number }
export interface Split { axis: Axis; sizes: number[]; kids: Tree[] }
export type Tree = Leaf | Split;

export interface Rect { x: number; y: number; w: number; h: number }

/** Smallest share a track may shrink to, so a pane never collapses out of reach. */
export const MIN_SHARE = 0.14;
export const ROOT: Rect = { x: 0, y: 0, w: 1, h: 1 };

export const isLeaf = (t: Tree): t is Leaf => "leaf" in t;
export const leaf = (id: number): Leaf => ({ leaf: id });

export const normalize = (sizes: number[]): number[] => {
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return sizes.map((s) => s / total);
};

export const split = (axis: Axis, kids: Tree[], sizes?: number[]): Split => ({
  axis,
  kids,
  sizes: normalize(sizes ?? kids.map(() => 1)),
});

export function leaves(t: Tree): number[] {
  return isLeaf(t) ? [t.leaf] : t.kids.flatMap(leaves);
}

/** Collapses single-child splits and merges nested splits that run the same way. */
export function tidy(t: Tree): Tree {
  if (isLeaf(t)) return t;
  const kids: Tree[] = [];
  const sizes: number[] = [];
  t.kids.forEach((k, i) => {
    const c = tidy(k);
    if (!isLeaf(c) && c.axis === t.axis) c.kids.forEach((g, j) => { kids.push(g); sizes.push(t.sizes[i] * c.sizes[j]); });
    else { kids.push(c); sizes.push(t.sizes[i]); }
  });
  return kids.length === 1 ? kids[0] : { axis: t.axis, kids, sizes: normalize(sizes) };
}

function drop(t: Tree, id: number): Tree | null {
  if (isLeaf(t)) return t.leaf === id ? null : t;
  const kids: Tree[] = [];
  const sizes: number[] = [];
  t.kids.forEach((k, i) => {
    const r = drop(k, id);
    if (r) { kids.push(r); sizes.push(t.sizes[i]); }
  });
  return kids.length ? { axis: t.axis, kids, sizes: normalize(sizes) } : null;
}

/** Removes a pane; its neighbours take over the freed space in proportion. */
export function removeLeaf(t: Tree, id: number): Tree | null {
  const r = drop(t, id);
  return r && tidy(r);
}

/** Puts a new pane against one edge of `target`, taking half of its space. */
export function insertLeaf(t: Tree, id: number, target: number, edge: Edge): Tree {
  const axis: Axis = edge === "left" || edge === "right" ? "x" : "y";
  const before = edge === "left" || edge === "top";
  const put = (node: Tree): Tree => {
    if (isLeaf(node)) return node.leaf === target ? split(axis, before ? [leaf(id), node] : [node, leaf(id)]) : node;
    const at = node.kids.findIndex((k) => isLeaf(k) && k.leaf === target);
    if (at >= 0 && node.axis === axis) {
      const kids = [...node.kids];
      const sizes = [...node.sizes];
      const half = sizes[at] / 2;
      sizes[at] = half;
      const idx = before ? at : at + 1;
      kids.splice(idx, 0, leaf(id));
      sizes.splice(idx, 0, half);
      return { axis, kids, sizes: normalize(sizes) };
    }
    return { ...node, kids: node.kids.map(put) };
  };
  return tidy(put(t));
}

/** Moves an existing pane next to another one without renumbering anything. */
export function moveLeaf(t: Tree, id: number, target: number, edge: Edge): Tree {
  if (id === target) return t;
  const rest = removeLeaf(t, id);
  return rest ? insertLeaf(rest, id, target, edge) : t;
}

export function relabel(t: Tree, fn: (id: number) => number): Tree {
  return isLeaf(t) ? leaf(fn(t.leaf)) : { ...t, kids: t.kids.map((k) => relabel(k, fn)) };
}

export function rects(t: Tree, r: Rect = ROOT, out = new Map<number, Rect>()): Map<number, Rect> {
  if (isLeaf(t)) {
    out.set(t.leaf, r);
    return out;
  }
  let off = 0;
  t.kids.forEach((k, i) => {
    const s = t.sizes[i];
    rects(k, t.axis === "x" ? { x: r.x + off * r.w, y: r.y, w: s * r.w, h: r.h } : { x: r.x, y: r.y + off * r.h, w: r.w, h: s * r.h }, out);
    off += s;
  });
  return out;
}

export interface Divider {
  axis: Axis;
  /** Child indexes from the root down to the split this divider belongs to. */
  path: number[];
  /** The divider sits between kid `index` and `index + 1`. */
  index: number;
  /** The split's own area, which the pointer position is measured against. */
  node: Rect;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function dividers(t: Tree, r: Rect = ROOT, path: number[] = [], out: Divider[] = []): Divider[] {
  if (isLeaf(t)) return out;
  let off = 0;
  t.kids.forEach((k, i) => {
    const s = t.sizes[i];
    off += s;
    const x = t.axis === "x";
    if (i < t.kids.length - 1) {
      out.push({ axis: t.axis, path, index: i, node: r, x: x ? r.x + off * r.w : r.x, y: x ? r.y : r.y + off * r.h, w: x ? 0 : r.w, h: x ? r.h : 0 });
    }
    const start = off - s;
    dividers(k, x ? { x: r.x + start * r.w, y: r.y, w: s * r.w, h: r.h } : { x: r.x, y: r.y + start * r.h, w: r.w, h: s * r.h }, [...path, i], out);
  });
  return out;
}

/** Moves the divider after track `index` by `delta` (a share), keeping both neighbours above the minimum. */
export function resize(sizes: number[], index: number, delta: number): number[] {
  const next = normalize(sizes);
  if (index < 0 || index >= next.length - 1) return next;
  const pair = next[index] + next[index + 1];
  const min = Math.min(MIN_SHARE, pair / 2);
  const a = Math.max(min, Math.min(pair - min, next[index] + delta));
  next[index] = a;
  next[index + 1] = pair - a;
  return next;
}

export function resizeAt(t: Tree, path: number[], index: number, delta: number): Tree {
  if (isLeaf(t)) return t;
  if (!path.length) return { ...t, sizes: resize(t.sizes, index, delta) };
  const [head, ...rest] = path;
  return { ...t, kids: t.kids.map((k, i) => (i === head ? resizeAt(k, rest, index, delta) : k)) };
}

/** Every split in the tree gets equal shares. */
export function evenTree(t: Tree): Tree {
  return isLeaf(t) ? t : split(t.axis, t.kids.map(evenTree));
}

export type DockZone = Edge | "center";

/** Which part of a pane a point falls in: the middle swaps, the rim docks against that edge. */
export function zoneOf(rx: number, ry: number, mx = 0.26, my = 0.26): DockZone {
  if (rx > mx && rx < 1 - mx && ry > my && ry < 1 - my) return "center";
  const dx = Math.min(rx, 1 - rx);
  const dy = Math.min(ry, 1 - ry);
  return dx < dy ? (rx < 0.5 ? "left" : "right") : ry < 0.5 ? "top" : "bottom";
}

/**
 * Split-view presets. Each one is a tree of numbered panes (0 is the main view); dragging a page
 * onto a pane's edge builds layouts that are not presets, which the store calls "custom".
 */
import { leaf, split, type Tree } from "./tree";

export type LayoutId = "single" | "columns" | "rows" | "quad" | "master-detail" | "tiled";
export type Layout = LayoutId | "custom";

export interface LayoutDef {
  id: LayoutId;
  label: string;
  hint: string;
}

export const LAYOUTS: LayoutDef[] = [
  { id: "single", label: "Single page", hint: "One page, no split" },
  { id: "columns", label: "Side by side", hint: "Two pages, half and half" },
  { id: "rows", label: "Stacked", hint: "One page above the other" },
  { id: "quad", label: "Four corners", hint: "Four pages in a grid" },
  { id: "master-detail", label: "Master and detail", hint: "One tall page, two beside it" },
  { id: "tiled", label: "Tiles", hint: "Fits the pages you have open, up to six" },
];

export const MIN_TILES = 3;
export const MAX_TILES = 6;

export const isLayout = (v: unknown): v is LayoutId => LAYOUTS.some((l) => l.id === v);

/** How many panes a preset wants; tiles adapt to however many pages are open. */
export function paneCount(id: LayoutId): number {
  switch (id) {
    case "single": return 1;
    case "columns":
    case "rows": return 2;
    case "quad": return 4;
    case "master-detail": return 3;
    case "tiled": return MIN_TILES;
  }
}

const run = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => leaf(from + i));

/** The tree for a preset holding `n` panes, numbered 0..n-1 in reading order. */
export function presetTree(id: LayoutId, n = paneCount(id)): Tree {
  switch (id) {
    case "single": return leaf(0);
    case "columns": return split("x", run(0, 2));
    case "rows": return split("y", run(0, 2));
    case "quad": return split("y", [split("x", run(0, 2)), split("x", run(2, 4))]);
    case "master-detail": return split("x", [leaf(0), split("y", run(1, 3))], [0.58, 0.42]);
    case "tiled": {
      if (n <= 1) return leaf(0);
      if (n <= 3) return split("x", run(0, n));
      const top = Math.ceil(n / 2);
      return split("y", [split("x", run(0, top)), split("x", run(top, n))]);
    }
  }
}

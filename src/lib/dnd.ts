import type { Page } from "../types";

export type DropZone = "before" | "inside" | "after";

/** Splits a tree row into top quarter (before), middle half (inside) and bottom quarter (after). */
export function dropZone(pointerY: number, top: number, height: number): DropZone {
  const rel = (pointerY - top) / Math.max(height, 1);
  if (rel < 0.25) return "before";
  if (rel > 0.75) return "after";
  return "inside";
}

export interface MoveTarget {
  parentPageId: string | null;
  beforePageId: string | null;
}

/**
 * Translates "drop `dragId` on row `over` in `zone`" into a move command.
 * `siblingsOf(parentId)` returns the loaded live children of a parent (null = top level).
 */
export function resolveDrop(
  dragId: string,
  over: Page,
  zone: DropZone,
  siblingsOf: (parentId: string | null) => Page[],
): MoveTarget {
  if (zone === "inside") return { parentPageId: over.id, beforePageId: null };
  if (zone === "before") return { parentPageId: over.parentPageId, beforePageId: over.id };
  const siblings = siblingsOf(over.parentPageId).filter((p) => p.id !== dragId);
  const idx = siblings.findIndex((p) => p.id === over.id);
  return { parentPageId: over.parentPageId, beforePageId: siblings[idx + 1]?.id ?? null };
}

/** True when `candidateId` is `rootId` or one of its descendants, using the loaded page lookup. */
export function isInSubtree(rootId: string, candidateId: string, lookup: (id: string) => Page | undefined): boolean {
  let cursor: string | null = candidateId;
  for (let guard = 0; cursor && guard < 1000; guard++) {
    if (cursor === rootId) return true;
    cursor = lookup(cursor)?.parentPageId ?? null;
  }
  return false;
}

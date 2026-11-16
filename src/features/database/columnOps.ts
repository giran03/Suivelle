import type { ViewColumn } from "../../types";

export const MAX_FROZEN = 3;

/** Moves one column to sit right before or after another; hidden columns keep their places. */
export function moveBeside(columns: ViewColumn[], id: string, besideId: string, side: "left" | "right"): ViewColumn[] {
  const moving = columns.find((c) => c.propertyId === id);
  if (!moving || id === besideId || !columns.some((c) => c.propertyId === besideId)) return columns;
  const rest = columns.filter((c) => c.propertyId !== id);
  const at = rest.findIndex((c) => c.propertyId === besideId);
  rest.splice(side === "left" ? at : at + 1, 0, moving);
  return rest;
}

/** The set of wrapped columns after turning wrapping on or off for one property. */
export function toggleWrap(wrapped: readonly string[] | undefined, id: string, on: boolean): string[] {
  const rest = (wrapped ?? []).filter((x) => x !== id);
  return on ? [...rest, id] : rest;
}

/** How many columns after the title are frozen, clamped to what the table has room for. */
export function frozenCount(requested: number | undefined, columnCount: number): number {
  const n = Math.floor(requested ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_FROZEN, Math.max(0, columnCount - 1));
}

/** Left offsets (px) of the frozen columns: the title, then the ones frozen after it. */
export function stickyOffsets(widths: readonly number[], frozen: number): number[] {
  const out: number[] = [];
  let left = 0;
  for (let i = 0; i <= frozen && i < widths.length; i++) {
    out.push(left);
    left += widths[i];
  }
  return out;
}

export const ROW_HEIGHTS = { compact: 28, medium: 34, tall: 64 } as const;

/** A tooltip's text split into its words and, when it ends in one, a keyboard shortcut: "Bold (Ctrl+B)". */
export interface TipParts {
  text: string;
  keys: string | null;
}

const SHORTCUT = /^(.*?)\s*\(((?:Ctrl|Cmd|Alt|Shift|Control|Meta|⌘|Esc|F\d+)[^()]*)\)$/;

export function parseTip(raw: string): TipParts {
  const m = SHORTCUT.exec(raw.trim());
  return m && m[1] ? { text: m[1], keys: m[2] } : { text: raw.trim(), keys: null };
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const GAP = 8;
export const EDGE = 6;

/**
 * Where a tooltip of `tip` size goes for a trigger: centred above it, or below when there is no room above,
 * kept inside the viewport horizontally. Returns the top-left corner and which side it landed on.
 */
export function placeTip(trigger: Box, tip: { width: number; height: number }, viewport: { width: number; height: number }): { x: number; y: number; side: "above" | "below" } {
  const above = trigger.top - GAP - tip.height;
  const below = trigger.top + trigger.height + GAP;
  const fitsAbove = above >= EDGE;
  const fitsBelow = below + tip.height <= viewport.height - EDGE;
  const side = fitsAbove || !fitsBelow ? "above" : "below";
  const y = side === "above" ? Math.max(EDGE, above) : below;
  const centred = trigger.left + trigger.width / 2 - tip.width / 2;
  const x = Math.min(Math.max(EDGE, centred), Math.max(EDGE, viewport.width - EDGE - tip.width));
  return { x, y, side };
}

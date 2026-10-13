import type { KeyboardEvent } from "react";
import { trashPages } from "./pageBatch";
import { clearSelection, pickedRoots, usePageSelection } from "./pageSelection";

/** The row to move to for Up, Down, Home and End among `count` rows; null for any other key. */
export function nextRow(key: string, at: number, count: number): number | null {
  if (count === 0 || at < 0) return null;
  if (key === "ArrowDown") return Math.min(count - 1, at + 1);
  if (key === "ArrowUp") return Math.max(0, at - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * The row a type-ahead search lands on: the first label that starts with `typed`, looking forward from
 * the focused row and wrapping round. Typing one letter again steps to the next row with that letter.
 */
export function matchRow(labels: string[], at: number, typed: string): number | null {
  const want = typed.toLowerCase();
  const repeated = want.length > 1 && [...want].every((c) => c === want[0]);
  const prefix = repeated ? want[0] : want;
  // A growing prefix may keep the current row; a single or repeated letter moves on.
  const from = prefix.length > 1 ? at : at + 1;
  for (let i = 0; i < labels.length; i++) {
    const idx = (from + i) % labels.length;
    if (labels[idx].trim().toLowerCase().startsWith(prefix)) return idx;
  }
  return null;
}

/** The row a Left key steps out to: the nearest row above with a shallower level, or -1 for a top-level row. */
export function parentRow(levels: number[], at: number): number {
  for (let i = at - 1; i >= 0; i--) if (levels[i] < levels[at]) return i;
  return -1;
}

let typed = "";
let typedAt = 0;

const HANDLED = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]);

/** A mouse event aimed at `target`, carrying the modifier keys of the key press that stands in for it. */
function pointer(type: string, e: KeyboardEvent<HTMLElement>, target: HTMLElement): void {
  const r = target.getBoundingClientRect();
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, clientX: r.left + 24, clientY: r.bottom }),
  );
}

/**
 * Keyboard handling for a tree of pages (role="tree"), used on the tree's list. It acts only while a row
 * (role="treeitem") itself has focus, so typing in other controls is never affected.
 *   Up, Down, Home, End   move between visible rows
 *   Right                 opens a folder, then steps into its first child
 *   Left                  closes a folder, then steps out to the parent
 *   Enter, Space          open the page; with Ctrl or Shift, pick it as a click would
 *   Ctrl+A                picks every page in the list
 *   Delete                moves the picked pages to the trash
 *   Escape                clears the picked pages
 *   Menu key, Shift+F10   the row's context menu
 *   letters               jump to the next page whose title starts with them
 */
export function handleTreeKeys(e: KeyboardEvent<HTMLElement>): void {
  if (e.key === "Escape") clearSelection();
  const row = e.target as HTMLElement;
  if (!row.matches?.('[role="treeitem"]')) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const at = rows.indexOf(row);
  if (at < 0) return;
  const levels = rows.map((r) => Number(r.getAttribute("aria-level")) || 1);
  const go = (to: number | null) => {
    if (to === null || to === at) return;
    e.preventDefault();
    rows[to].focus();
  };

  if (e.key === "Enter" || e.key === " ") {
    const title = row.querySelector<HTMLElement>(".title");
    if (!title) return;
    e.preventDefault();
    pointer("click", e, title);
    return;
  }
  if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
    e.preventDefault();
    pointer("contextmenu", e, row);
    return;
  }

  // Ctrl/Cmd+A picks every row of this list; Delete trashes the picked pages (Undo is in the toast).
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
    e.preventDefault();
    const keys = rows.map((r) => r.dataset.key ?? "").filter(Boolean);
    usePageSelection.setState({ ids: keys, anchor: keys[0] ?? null });
    return;
  }
  if (e.key === "Delete" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const picked = pickedRoots();
    if (!picked.length) return;
    e.preventDefault();
    const tree = e.currentTarget;
    void trashPages(picked).then(() =>
      // The rows are gone: keep keyboard focus in the list, on the row that took the place of the first one.
      requestAnimationFrame(() => {
        const left = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
        left[Math.min(at, left.length - 1)]?.focus();
      }),
    );
    return;
  }

  // Type-ahead: a printable character jumps to the next page whose title starts with what was typed.
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const now = Date.now();
    typed = now - typedAt > 800 ? e.key : typed + e.key;
    typedAt = now;
    go(matchRow(rows.map((r) => r.getAttribute("aria-label") ?? ""), at, typed));
    return;
  }

  if (!HANDLED.has(e.key) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const chevron = row.querySelector<HTMLElement>(".chevron");
  const open = row.getAttribute("aria-expanded") === "true";
  if (e.key === "ArrowRight") {
    if (chevron && !open) {
      e.preventDefault();
      chevron.click();
    } else go(open ? Math.min(rows.length - 1, at + 1) : null);
  } else if (e.key === "ArrowLeft") {
    if (chevron && open) {
      e.preventDefault();
      chevron.click();
    } else {
      const parent = parentRow(levels, at);
      go(parent >= 0 ? parent : null);
    }
  } else go(nextRow(e.key, at, rows.length));
}

import { create } from "zustand";
import { useTabs } from "../tabs/tabs";
import { useWorkspace } from "../../stores/workspace";
import { useSplit } from "./store";
import { zoneOf, type DockZone } from "./tree";

/** Marks the document while a page or tab is being dragged, which is when the drop targets show. */
export const DRAG_CLASS = "split-drag";

export interface DockTarget {
  slot: number;
  zone: DockZone;
  /** Where the dragged page would land, in viewport pixels. */
  rect: { left: number; top: number; width: number; height: number };
}

/** The drop the pointer is currently aiming at, shown as a live outline. */
export const useDockHint = create<{ target: DockTarget | null }>(() => ({ target: null }));

const SLOT = "[data-split-slot]";

/** The pane under a point (the middle counts only when `allowCenter` is set, for swapping panes) and which part of it the point is in, with the area that part would take. */
export function dockTargetAt(x: number, y: number, allowCenter = false): DockTarget | null {
  const hits = document.elementsFromPoint(x, y);
  // The tab strip has its own meaning (reorder, or open in a new tab).
  if (hits.some((el) => el.closest(".tabbar"))) return null;
  for (const el of hits) {
    const cell = el.closest<HTMLElement>(SLOT);
    if (!cell) continue;
    const b = cell.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    // Only the rim of a pane docks, so the middle stays free for dropping a page onto text to link it.
    const rim = Math.max(40, Math.min(96, Math.min(b.width, b.height) * 0.2));
    const zone = zoneOf((x - b.left) / b.width, (y - b.top) / b.height, rim / b.width, rim / b.height);
    if (zone === "center" && !allowCenter) return null;
    const half = { left: b.left, top: b.top, width: b.width, height: b.height };
    if (zone === "left") half.width /= 2;
    else if (zone === "right") { half.left += b.width / 2; half.width /= 2; }
    else if (zone === "top") half.height /= 2;
    else if (zone === "bottom") { half.top += b.height / 2; half.height /= 2; }
    return { slot: Number(cell.dataset.splitSlot), zone, rect: half };
  }
  return null;
}

/** Drops a dragged page where the pointer is aiming. Returns whether the drop was taken. */
export function dropOnSplit(pageId: string, x: number, y: number): boolean {
  const t = dockTargetAt(x, y);
  useDockHint.setState({ target: null });
  if (!t) return false;
  // The open page already fills the main pane, so docking it against that pane would change nothing:
  // bring in its neighbouring tab instead, which is what splitting "this tab" means.
  let page = pageId;
  if (t.slot === 0 && t.zone !== "center" && pageId === useWorkspace.getState().selectedPageId) {
    const ids = useTabs.getState().ids;
    const other = ids[ids.indexOf(pageId) + 1] ?? ids[ids.indexOf(pageId) - 1];
    if (!other || other === pageId) return false;
    page = other;
  }
  useSplit.getState().dock(page, t.slot, t.zone);
  return true;
}

/** Whether a pane lies under the pointer, without dropping anything. */
export function overSplitTarget(x: number, y: number): boolean {
  return dockTargetAt(x, y) !== null;
}

const same = (a: DockTarget | null, b: DockTarget | null) =>
  a === b || (!!a && !!b && a.slot === b.slot && a.zone === b.zone && a.rect.left === b.rect.left && a.rect.top === b.rect.top && a.rect.width === b.rect.width && a.rect.height === b.rect.height);

/**
 * While a page or tab is dragged (the body carries a drag class), follows the pointer and keeps
 * the hint on the part of the pane it would dock to. Returns an uninstall function.
 */
export function installDockHint(): () => void {
  const dragging = () => document.body.classList.contains(DRAG_CLASS) || document.body.classList.contains("page-drag");
  const move = (e: PointerEvent) => {
    if (!dragging()) return;
    const next = dockTargetAt(e.clientX, e.clientY, document.body.classList.contains("split-moving"));
    if (!same(useDockHint.getState().target, next)) useDockHint.setState({ target: next });
  };
  const watch = new MutationObserver(() => {
    if (!dragging() && useDockHint.getState().target) useDockHint.setState({ target: null });
  });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("pointermove", move, true);
  return () => {
    watch.disconnect();
    window.removeEventListener("pointermove", move, true);
    useDockHint.setState({ target: null });
  };
}

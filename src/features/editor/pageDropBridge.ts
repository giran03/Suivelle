type DropHandler = (pageIds: string[], x: number, y: number) => boolean;
let handler: DropHandler = () => false;

/** The sidebar stays light; the editor extension installs its handler when it loads. */
export function registerPageDrop(handlerForEditors: DropHandler) { handler = handlerForEditors; }
export function dropPagesOnEditor(pageIds: string[], x: number, y: number) { return handler(pageIds, x, y); }

/**
 * Where the pointer really is. A drag reports its start plus a travelled distance, which drifts when the sidebar
 * scrolls mid-drag, so drops and previews read the live position instead.
 */
const pointer = { x: NaN, y: NaN };
if (typeof window !== "undefined") {
  const track = (e: PointerEvent) => { pointer.x = e.clientX; pointer.y = e.clientY; };
  window.addEventListener("pointermove", track, true);
  window.addEventListener("pointerup", track, true);
}
export const lastPointer = (): { x: number; y: number } | null => (Number.isFinite(pointer.x) ? { x: pointer.x, y: pointer.y } : null);

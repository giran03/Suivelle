// Ported from Octopolis. Drag-to-scroll: hold the left mouse button on empty space and drag vertically to scroll the
// nearest scrollable area. Interactive controls (buttons, sliders, inputs, draggable items,
// the title bar, switches and segmented controls, key-recording fields) are left alone, so they keep working exactly as before.
//
// Motion: the scroll position eases toward the pointer-driven target (damping), and on release
// the last drag velocity carries on and decays (momentum). Both are frame-rate independent.

const DRAG_THRESHOLD_PX = 3;
/** Time constant of the follow-the-pointer smoothing. Lower = snappier, higher = floatier. */
const FOLLOW_TAU_MS = 45;
/** Time constant of the momentum decay after release. */
const MOMENTUM_TAU_MS = 260;
/** How quickly the measured drag velocity adapts (time constant). */
const VELOCITY_TAU_MS = 70;
const MIN_COAST_SPEED = 0.03; // px per ms
const MAX_FRAME_MS = 50;

const calm = () => document.documentElement.dataset.motion === "reduced" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const SKIP_SELECTOR =
  'a, button, input, select, textarea, label, canvas, video, audio, summary, [contenteditable="true"], ' +
  '[draggable="true"], [role="slider"], [role="button"], [role="switch"], [role="menuitem"], ' +
  '[role="checkbox"], [role="tab"], [role="option"], [role="radio"], [role="application"], [role="separator"], ' +
  '.switch, .seg, .theme-swatch, .shortcut-capture, progress, details[open] > :not(summary), ' +
  '[data-tauri-drag-region]:not([data-tauri-drag-region="false"]), [data-no-dragscroll], ' +
  'pre, code, .error, [data-selectable]';

// A cursor other than these means the element handles its own mouse interaction.
const PLAIN_CURSORS = new Set(["auto", "default"]);

function scrollableAncestor(start: Element | null, boundary?: HTMLElement, horizontal = false): HTMLElement | null {
  for (let el: Element | null = start; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el);
    const overflow = horizontal ? style.overflowX : style.overflowY;
    const room = horizontal ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1;
    if ((overflow === "auto" || overflow === "scroll") && room) return el as HTMLElement;
    if (el === boundary) break;
  }
  if (boundary) return null;
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

/** Things a middle-button drag must leave alone: text fields, sliders, media and the window's own drag region. */
const MIDDLE_SKIP = 'input, textarea, select, canvas, video, audio, [role="slider"], [data-tauri-drag-region]:not([data-tauri-drag-region="false"]), [data-no-dragscroll]';

function isDragStartAllowed(event: MouseEvent, button: 0 | 1, accept?: (target: Element) => boolean): boolean {
  // The app may already have cancelled a middle press to keep the browser's auto-scroll away; that is not a refusal.
  if (event.button !== button || (button === 0 && event.defaultPrevented)) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || (accept && !accept(target))) return false;
  if (button === 1) return !target.closest(MIDDLE_SKIP);
  if (event.detail > 1 || target.closest(SKIP_SELECTOR)) return false;
  return PLAIN_CURSORS.has(getComputedStyle(target).cursor);
}

/**
 * Enables drag-to-scroll (both directions) with damping and momentum inside `root`
 * (or globally if omitted). Returns a cleanup function that removes all listeners.
 */
export interface DragScrollOptions {
  /** Which mouse button drags: 0 is the left button on empty space (the default), 1 is the middle button anywhere. */
  button?: 0 | 1;
  /** Limits where a drag may start, for example to the editor. */
  accept?: (target: Element) => boolean;
}

export function installDragScroll(root?: HTMLElement, { button = 0, accept }: DragScrollOptions = {}): () => void {
  // Each axis scrolls its own nearest scrollable ancestor, so a board that scrolls sideways inside a page
  // that scrolls up and down moves both ways with one drag.
  interface Axis { el: HTMLElement | null; start: number; startScroll: number; last: number; velocity: number; position: number; target: number }
  const axis = (): Axis => ({ el: null, start: 0, startScroll: 0, last: 0, velocity: 0, position: 0, target: 0 });
  const X = axis();
  const Y = axis();
  const axes = [Y, X];
  let pressed = false; // button held after a valid mousedown
  let dragging = false; // moved past the threshold
  let lastMoveAt = 0;
  let frame = 0;
  let lastFrameAt = 0;

  const maxScroll = (a: Axis) => (a.el ? Math.max(0, a === X ? a.el.scrollWidth - a.el.clientWidth : a.el.scrollHeight - a.el.clientHeight) : 0);
  const clamp = (a: Axis, v: number) => Math.min(Math.max(v, 0), maxScroll(a));
  const active = () => axes.some((a) => a.el);

  const cancelMotion = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const a of axes) a.velocity = 0;
  };

  const tick = (now: number) => {
    frame = 0;
    if (!active()) return;
    const dt = Math.min(now - lastFrameAt, MAX_FRAME_MS);
    lastFrameAt = now;
    let settled = true;
    for (const a of axes) {
      if (!a.el) continue;
      if (!dragging && !pressed) {
        // Coasting after release.
        if (calm()) a.velocity = 0;
        a.target = clamp(a, a.target + a.velocity * dt);
        a.velocity *= Math.exp(-dt / MOMENTUM_TAU_MS);
        if (a.target <= 0 || a.target >= maxScroll(a)) a.velocity = 0;
      }
      a.position += (a.target - a.position) * (calm() ? 1 : 1 - Math.exp(-dt / FOLLOW_TAU_MS));
      if (Math.abs(a.target - a.position) < 0.25) a.position = a.target;
      a.el.scrollTo(a === X ? { left: a.position, behavior: "instant" } : { top: a.position, behavior: "instant" });
      if (a.position !== a.target || Math.abs(a.velocity) >= MIN_COAST_SPEED) settled = false;
    }
    if (pressed || dragging || !settled) {
      frame = requestAnimationFrame(tick);
    } else {
      X.el = Y.el = null;
    }
  };

  const startLoop = () => {
    if (frame) return;
    lastFrameAt = performance.now();
    frame = requestAnimationFrame(tick);
  };

  const release = () => {
    if (dragging) {
      // Swallow the click that would otherwise fire when the button is released.
      const swallow = (e: Event) => e.stopPropagation();
      const kind = button === 0 ? "click" : "auxclick";
      window.addEventListener(kind, swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener(kind, swallow, true), 0);
      // A pause before letting go means no momentum.
      if (performance.now() - lastMoveAt > 80) for (const a of axes) a.velocity = 0;
    } else {
      X.el = Y.el = null;
    }
    pressed = false;
    dragging = false;
    document.body.style.removeProperty("user-select");
    document.documentElement.style.removeProperty("cursor");
    if (active()) startLoop();
  };

  const onMouseDown = (event: MouseEvent) => {
    cancelMotion();
    if (pressed) release();
    X.el = Y.el = null;
    if (!isDragStartAllowed(event, button, accept)) return;
    // The middle button must never reach the browser's own auto-scroll (the circle with arrows), even when this
    // page has nothing to scroll: it is a hand here, as on the canvas.
    if (button === 1) event.preventDefault();
    const target = event.target as Element;
    let foundY = scrollableAncestor(target, root);
    let foundX = scrollableAncestor(target, root, true);
    if (!root) {
      const modal = document.querySelector('[aria-modal="true"]');
      if (modal) {
        if (foundY && !modal.contains(foundY)) foundY = null;
        if (foundX && !modal.contains(foundX)) foundX = null;
      }
    }
    if (foundY && foundY.scrollHeight <= foundY.clientHeight + 1) foundY = null;
    if (foundX && foundX.scrollWidth <= foundX.clientWidth + 1) foundX = null;
    if (!foundY && !foundX) return;
    Y.el = foundY;
    X.el = foundX;
    pressed = true;
    // The hand shows the moment the button goes down, not only once the pointer has moved.
    if (button === 1) document.documentElement.style.setProperty("cursor", "grab");
    dragging = false;
    Y.start = Y.last = event.clientY;
    X.start = X.last = event.clientX;
    if (Y.el) Y.startScroll = Y.position = Y.target = Y.el.scrollTop;
    if (X.el) X.startScroll = X.position = X.target = X.el.scrollLeft;
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!pressed || !active()) return;
    if (event.buttons !== (button === 0 ? 1 : 4)) {
      release();
      return;
    }
    if (!dragging) {
      if (Math.hypot(event.clientX - X.start, event.clientY - Y.start) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      lastMoveAt = performance.now();
      document.body.style.setProperty("user-select", "none");
      document.documentElement.style.setProperty("cursor", "grabbing");
      window.getSelection()?.removeAllRanges();
      startLoop();
    }
    const now = performance.now();
    const dt = Math.max(now - lastMoveAt, 1);
    const blend = 1 - Math.exp(-dt / VELOCITY_TAU_MS);
    for (const a of axes) {
      if (!a.el) continue;
      const pointer = a === X ? event.clientX : event.clientY;
      a.velocity += (-(pointer - a.last) / dt - a.velocity) * blend;
      a.last = pointer;
      a.target = clamp(a, a.startScroll - (pointer - a.start));
    }
    lastMoveAt = now;
  };

  const onMouseUp = (event: MouseEvent) => {
    if (button === 1 && event.button === 1 && pressed) event.preventDefault();
    if (pressed) release();
  };
  const onBlur = () => {
    if (pressed) {
      for (const a of axes) a.velocity = 0;
      release();
    }
  };
  const onWheel = () => {
    if (!pressed) {
      cancelMotion();
      X.el = Y.el = null;
    }
  };

  const downTarget: EventTarget = root ?? window;
  downTarget.addEventListener("mousedown", onMouseDown as EventListener, true);
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("wheel", onWheel, { passive: true, capture: true });

  return () => {
    cancelMotion();
    if (pressed) release();
    downTarget.removeEventListener("mousedown", onMouseDown as EventListener, true);
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("wheel", onWheel, true);
  };
}

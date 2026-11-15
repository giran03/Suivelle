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

const calm = () => document.documentElement.dataset.motion === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SKIP_SELECTOR =
  'a, button, input, select, textarea, label, canvas, video, audio, summary, [contenteditable="true"], ' +
  '[draggable="true"], [role="slider"], [role="button"], [role="switch"], [role="menuitem"], ' +
  '[role="checkbox"], [role="tab"], [role="option"], [role="radio"], [role="application"], [role="separator"], ' +
  '.switch, .seg, .theme-swatch, .shortcut-capture, progress, details[open] > :not(summary), ' +
  '[data-tauri-drag-region]:not([data-tauri-drag-region="false"]), [data-no-dragscroll], ' +
  'pre, code, .error, [data-selectable]';

// A cursor other than these means the element handles its own mouse interaction.
const PLAIN_CURSORS = new Set(["auto", "default"]);

function scrollableAncestor(start: Element | null, boundary?: HTMLElement): HTMLElement | null {
  for (let el: Element | null = start; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1) {
      return el as HTMLElement;
    }
    if (el === boundary) break;
  }
  if (boundary) return null;
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

function isDragStartAllowed(event: MouseEvent): boolean {
  if (event.button !== 0 || event.defaultPrevented || event.detail > 1) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest(SKIP_SELECTOR)) return false;
  return PLAIN_CURSORS.has(getComputedStyle(target).cursor);
}

/**
 * Enables vertical drag-to-scroll with damping and momentum inside `root`
 * (or globally if omitted). Returns a cleanup function that removes all listeners.
 */
export function installDragScroll(root?: HTMLElement): () => void {
  let container: HTMLElement | null = null;
  let pressed = false; // button held after a valid mousedown
  let dragging = false; // moved past the threshold
  let startY = 0;
  let startScroll = 0;
  let lastY = 0;
  let lastMoveAt = 0;
  let velocity = 0; // target px per ms
  let position = 0; // smoothed scrollTop (float)
  let target = 0;
  let frame = 0;
  let lastFrameAt = 0;

  const maxScroll = () => (container ? Math.max(0, container.scrollHeight - container.clientHeight) : 0);
  const clamp = (v: number) => Math.min(Math.max(v, 0), maxScroll());

  const cancelMotion = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    velocity = 0;
  };

  const tick = (now: number) => {
    frame = 0;
    if (!container) return;
    const dt = Math.min(now - lastFrameAt, MAX_FRAME_MS);
    lastFrameAt = now;

    if (!dragging && !pressed) {
      // Coasting after release.
      if (calm()) velocity = 0;
      target = clamp(target + velocity * dt);
      velocity *= Math.exp(-dt / MOMENTUM_TAU_MS);
      if (target <= 0 || target >= maxScroll()) velocity = 0;
    }
    position += (target - position) * (calm() ? 1 : 1 - Math.exp(-dt / FOLLOW_TAU_MS));
    if (Math.abs(target - position) < 0.25) position = target;
    container.scrollTo({ top: position, behavior: "instant" });

    const settled = position === target && Math.abs(velocity) < MIN_COAST_SPEED;
    if (pressed || dragging || !settled) {
      frame = requestAnimationFrame(tick);
    } else {
      container = null;
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
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      // A pause before letting go means no momentum.
      if (performance.now() - lastMoveAt > 80) velocity = 0;
    } else {
      container = null;
    }
    pressed = false;
    dragging = false;
    document.body.style.removeProperty("user-select");
    document.documentElement.style.removeProperty("cursor");
    if (container) startLoop();
  };

  const onMouseDown = (event: MouseEvent) => {
    cancelMotion();
    if (pressed) release();
    container = null;
    if (!isDragStartAllowed(event)) return;
    const found = scrollableAncestor(event.target as Element, root);
    if (!found) return;
    if (!root) {
      const modal = document.querySelector('[aria-modal="true"]');
      if (modal && !modal.contains(found)) return;
    }
    if (found.scrollHeight <= found.clientHeight + 1) return;
    container = found;
    pressed = true;
    dragging = false;
    startY = lastY = event.clientY;
    startScroll = position = target = container.scrollTop;
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!pressed || !container) return;
    if (event.buttons !== 1) {
      release();
      return;
    }
    const delta = event.clientY - startY;
    if (!dragging) {
      if (Math.abs(delta) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      lastMoveAt = performance.now();
      document.body.style.setProperty("user-select", "none");
      document.documentElement.style.setProperty("cursor", "grabbing");
      window.getSelection()?.removeAllRanges();
      startLoop();
    }
    const now = performance.now();
    const dt = Math.max(now - lastMoveAt, 1);
    const instant = -(event.clientY - lastY) / dt;
    const blend = 1 - Math.exp(-dt / VELOCITY_TAU_MS);
    velocity += (instant - velocity) * blend;
    lastY = event.clientY;
    lastMoveAt = now;
    target = clamp(startScroll - delta);
  };

  const onMouseUp = () => {
    if (pressed) release();
  };
  const onBlur = () => {
    if (pressed) {
      velocity = 0;
      release();
    }
  };
  const onWheel = () => {
    if (!pressed) {
      cancelMotion();
      container = null;
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

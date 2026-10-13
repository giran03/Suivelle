import { parseTip, placeTip } from "./tipText";

/** How long the pointer must rest on something before its tooltip appears; keyboard focus shows it at once. */
const INTENT_MS = 350;
/** Grace period when the pointer crosses the gap between two triggers, so the bubble travels instead of reappearing. */
const LEAVE_MS = 80;
const MAX_WIDTH = 280;

const SELECTOR = "[data-tooltip],[title]";

/** What a trigger says. `data-tooltip` stays; a native `title` is borrowed while the tooltip is in play. */
interface Held {
  el: HTMLElement;
  text: string;
  restore: () => void;
}

function hold(el: HTMLElement): Held | null {
  const own = el.getAttribute("data-tooltip");
  if (own) return { el, text: own, restore: () => {} };
  const title = el.getAttribute("title");
  if (!title || !title.trim()) return null;
  // Take the title away so the browser's own tooltip does not also appear, and keep the element named for assistive technology.
  el.removeAttribute("title");
  const unnamed = !el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !(el.textContent ?? "").trim();
  if (unnamed) el.setAttribute("aria-label", title);
  return {
    el,
    text: title,
    restore: () => {
      // If the app wrote a new title while it was away, that one wins.
      if (!el.hasAttribute("title")) el.setAttribute("title", title);
      if (unnamed && el.getAttribute("aria-label") === title) el.removeAttribute("aria-label");
    },
  };
}

/**
 * One tooltip for the whole app (the transitions.dev "Tooltip open/close" motion): it fades in after a short
 * appear delay, leaves at once, and when the pointer moves to a neighbouring trigger the same bubble travels
 * there. Anything with a `title` or `data-tooltip` attribute gets it, so new controls need no setup.
 * Returns a function that removes it again.
 */
export function installTooltips(): () => void {
  const tip = document.createElement("div") as HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void };
  tip.className = "t-tt";
  tip.id = "app-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("aria-hidden", "true");
  tip.setAttribute("data-show", "false");
  tip.setAttribute("popover", "manual");
  const text = document.createElement("span");
  text.className = "t-tt-text";
  const keys = document.createElement("kbd");
  keys.className = "t-tt-keys";
  tip.append(text, keys);
  document.body.append(tip);
  try {
    tip.showPopover?.();
  } catch {
    /* A browser without the popover API still shows it, just beneath any open dialog. */
  }

  let held: Held | null = null;
  let armTimer = 0;
  let leaveTimer = 0;

  const showing = () => tip.getAttribute("data-show") === "true";

  function release(): void {
    if (!held) return;
    held.el.removeAttribute("aria-describedby");
    held.restore();
    held = null;
  }

  function hide(): void {
    window.clearTimeout(armTimer);
    window.clearTimeout(leaveTimer);
    release();
    tip.setAttribute("data-show", "false");
    tip.setAttribute("aria-hidden", "true");
  }

  function show(next: Held): void {
    if (!next.el.isConnected) {
      next.restore();
      return;
    }
    const wasShowing = showing();
    if (!wasShowing && document.querySelector("dialog[open]")) {
      // A modal dialog lives in the top layer; hiding and showing the popover again puts the bubble above it.
      try {
        tip.hidePopover?.();
        tip.showPopover?.();
      } catch {
        /* see above */
      }
    }
    const parts = parseTip(next.text);
    text.textContent = parts.text;
    keys.textContent = parts.keys ?? "";
    keys.hidden = !parts.keys;

    // Measure at natural size without animating, then restore the previous width so a move can tween.
    const previous = tip.style.width;
    tip.style.transition = "none";
    tip.removeAttribute("data-wrap");
    tip.style.width = "max-content";
    let width = Math.ceil(tip.getBoundingClientRect().width);
    if (width > MAX_WIDTH) {
      tip.setAttribute("data-wrap", "true");
      width = MAX_WIDTH;
      tip.style.width = `${width}px`;
    }
    const height = Math.ceil(tip.getBoundingClientRect().height);
    tip.style.width = previous || "0px";
    void tip.offsetWidth;
    tip.style.transition = wasShowing ? "" : "none";

    const r = next.el.getBoundingClientRect();
    const spot = placeTip({ left: r.left, top: r.top, width: r.width, height: r.height }, { width, height }, { width: window.innerWidth, height: window.innerHeight });
    tip.setAttribute("data-side", spot.side);
    tip.style.width = `${width}px`;
    tip.style.setProperty("--tt-x", `${spot.x}px`);
    tip.style.setProperty("--tt-y", `${spot.y}px`);
    if (!wasShowing) {
      // Snap the geometry while hidden so only the appear plays.
      void tip.offsetWidth;
      tip.style.transition = "";
    }

    if (held && held.el !== next.el) release();
    held = next;
    next.el.setAttribute("aria-describedby", tip.id);
    tip.setAttribute("data-show", "true");
    tip.setAttribute("aria-hidden", "false");
  }

  const triggerOf = (target: EventTarget | null): HTMLElement | null => {
    const el = target instanceof Element ? target.closest<HTMLElement>(SELECTOR) : null;
    return el && !tip.contains(el) ? el : null;
  };

  function arm(el: HTMLElement, immediate: boolean): void {
    window.clearTimeout(armTimer);
    window.clearTimeout(leaveTimer);
    if (held?.el === el) return;
    const next = hold(el);
    if (!next) return;
    if (immediate || showing()) {
      show(next);
      return;
    }
    // Keep the title borrowed while we wait, so the native tooltip cannot slip in first.
    release();
    held = next;
    armTimer = window.setTimeout(() => show(next), INTENT_MS);
  }

  const onOver = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const el = triggerOf(e.target);
    if (el) arm(el, false);
    else if (held && e.target instanceof Node && held.el.contains(e.target)) {
      // Still over the trigger (its title is borrowed, so it no longer matches the selector).
      window.clearTimeout(leaveTimer);
    } else if (held || showing()) {
      window.clearTimeout(leaveTimer);
      leaveTimer = window.setTimeout(hide, LEAVE_MS);
    }
  };
  const onOut = (e: PointerEvent) => {
    if (!e.relatedTarget) hide();
  };
  const onFocus = (e: FocusEvent) => {
    const el = triggerOf(e.target);
    if (el && (e.target as HTMLElement).matches?.(":focus-visible")) arm(el, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || showing() || held) hide();
  };

  document.addEventListener("pointerover", onOver, true);
  document.addEventListener("pointerout", onOut, true);
  document.addEventListener("focusin", onFocus, true);
  document.addEventListener("focusout", hide, true);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
  window.addEventListener("resize", hide);
  return () => {
    hide();
    document.removeEventListener("pointerover", onOver, true);
    document.removeEventListener("pointerout", onOut, true);
    document.removeEventListener("focusin", onFocus, true);
    document.removeEventListener("focusout", hide, true);
    document.removeEventListener("pointerdown", hide, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("scroll", hide, true);
    window.removeEventListener("blur", hide);
    window.removeEventListener("resize", hide);
    tip.remove();
  };
}

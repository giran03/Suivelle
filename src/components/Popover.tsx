import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { readProfile } from "../lib/motion";

export interface Anchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const anchorOf = (el: Element): Anchor => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/**
 * A floating panel next to an anchor: fixed-position so no scroll container clips it, flips above
 * when there is no room below, closes on Esc or an outside press, and gives focus back on close.
 */
export function Popover({
  anchor,
  onClose,
  label,
  className = "",
  children,
}: {
  anchor: Anchor;
  onClose: () => void;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin?: string }>({ left: anchor.left, top: anchor.bottom + 4 });
  const opener = useRef<HTMLElement | null>(null);
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /** Plays the exit, then closes. Focus goes back at once, so a keyboard user is never left in a fading panel. */
  const dismiss = useCallback(() => {
    if (leaveTimer.current) return;
    setLeaving(true);
    if (opener.current?.isConnected) opener.current.focus();
    leaveTimer.current = window.setTimeout(() => closeRef.current(), Math.round(150 * readProfile().time));
  }, []);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Entrance scale affects the visual rect; placement needs the final layout size.
    const width = el.offsetWidth, height = el.offsetHeight;
    const below = anchor.bottom + 4;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    const flip = below + height > window.innerHeight - 8;
    // Grow out of the trigger: from its edge, at the horizontal middle of the anchor.
    const fromX = Math.max(0, Math.min((anchor.left + anchor.right) / 2 - left, width));
    setPos({ left, top: flip ? Math.max(8, anchor.top - height - 4) : below, origin: `${fromX}px ${flip ? "100%" : "0"}` });
  }, [anchor, children]);

  // Remember what had focus so closing the panel puts it back (the grid, a toolbar button, ...).
  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not(:disabled)");
    first?.focus();
    return () => {
      if (opener.current && document.contains(opener.current)) opener.current.focus();
    };
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      // A press inside another popover (a nested picker) must not close this one.
      if ((target as HTMLElement).closest?.("[data-popover]")) return;
      dismiss();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, dismiss]);

  return (
    <div
      ref={ref}
      data-popover=""
      role="dialog"
      aria-label={label}
      className={`popover ${className}${leaving ? " is-closing" : ""}`}
      style={{ left: pos.left, top: pos.top, transformOrigin: pos.origin }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          dismiss();
        }
      }}
    >
      {children}
    </div>
  );
}

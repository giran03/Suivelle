import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { readProfile } from "../lib/motion";
import { READ_ONLY, readingAction } from "../lib/access";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Draws a divider above this item. */
  separated?: boolean;
}

/** A top-layer menu: above dialogs, sticky headers and transformed scroll containers. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const cancelled = useRef(false);
  const [pos, setPos] = useState<React.CSSProperties>({ left: x, top: y });
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef(0);

  /** Dismissal plays the exit, then closes. Focus goes back to the opener at once so a keyboard user is never stranded. */
  const dismiss = useCallback(() => {
    if (leaveTimer.current) return;
    setLeaving(true);
    if (cancelled.current && opener.current?.isConnected) opener.current.focus();
    leaveTimer.current = window.setTimeout(() => close.current(), Math.round(150 * readProfile().time));
  }, []);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
    el.showPopover?.();
    // Entrance motion transforms the visual rect; layout dimensions stay accurate.
    const width = el.offsetWidth, height = el.offsetHeight;
    const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
    // Grow from the point that was clicked.
    setPos({ left, top, transformOrigin: `${Math.max(0, Math.min(x - left, width))}px ${Math.max(0, Math.min(y - top, height))}px` });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [x, y]);

  useEffect(() => () => {
    if (cancelled.current && opener.current?.isConnected) opener.current.focus();
  }, []);

  useLayoutEffect(() => {
    const opened = (event: Event) => { if ((event as CustomEvent).detail !== ref.current) close.current(); };
    window.dispatchEvent(new CustomEvent("tako-context-menu", { detail: ref.current }));
    window.addEventListener("tako-context-menu", opened);
    return () => window.removeEventListener("tako-context-menu", opened);
  }, []);

  useEffect(() => {
    const onScroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) dismiss();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, dismiss]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelled.current = true;
      dismiss();
      return;
    }
    if (e.key === "Tab") { e.preventDefault(); e.stopPropagation(); cancelled.current = true; dismiss(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && !(e.key.trim().length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)) return;
    e.preventDefault();
    e.stopPropagation();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (!buttons.length) return;
    const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : e.key === "ArrowDown" ? (i + 1) % buttons.length : e.key === "ArrowUp" ? (i - 1 + buttons.length) % buttons.length : buttons.findIndex((b, j) => j > i && b.textContent?.toLowerCase().startsWith(e.key.toLowerCase()));
    if (next < 0) { buttons.find((b) => b.textContent?.toLowerCase().startsWith(e.key.toLowerCase()))?.focus(); return; }
    buttons[next]?.focus();
  };

  return (
    <div ref={ref} popover={typeof HTMLElement.prototype.showPopover === "function" ? "manual" : undefined} data-popover="" className={`menu${leaving ? " is-closing" : ""}`} role="menu" aria-label="Context actions" style={pos} onKeyDown={onKeyDown} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {items.filter((item) => !READ_ONLY || readingAction(item.label)).map((item) => (
        <button
          key={item.label}
          type="button"
          tabIndex={-1}
          role="menuitem"
          className={`menu-item${item.danger ? " danger" : ""}${item.separated ? " separated" : ""}`}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

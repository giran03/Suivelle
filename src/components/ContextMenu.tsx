import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ShortcutKeys } from "./ShortcutKeys";
import { Icon } from "./Icon";
import { effective, format, matches, resolvedModifiers, type Binding } from "../features/shortcuts/bindings";
import { useShortcuts } from "../features/shortcuts/store";
import { readProfile } from "../lib/motion";
import { READ_ONLY, readingAction } from "../lib/access";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** An action ID for live rebindable hints, or native text-editing bindings. */
  shortcut?: string | Binding[];
  disabled?: boolean;
  danger?: boolean;
  /** Draws a divider above this item. */
  separated?: boolean;
  /** Optional selection state for a checkable menu action. */
  checked?: boolean;
}

/** A top-layer menu: above dialogs, sticky headers and transformed scroll containers. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  // WebView zoom adjusts viewport coordinates; the browser fallback uses CSS zoom instead.
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const bounds = { minWidth: Math.min(220, (window.innerWidth - 16) / zoom), maxWidth: Math.min(360, (window.innerWidth - 16) / zoom), maxHeight: Math.min(480, (window.innerHeight - 16) / zoom) };
  const overrides = useShortcuts(s => s.overrides);
  const visibleItems = items.filter(item => !READ_ONLY || readingAction(item.label));
  const bindings = (item: MenuItem) => typeof item.shortcut === "string" ? effective(item.shortcut, overrides) : item.shortcut ?? [];
  const hint = (item: MenuItem) => bindings(item).find(b => b.kind === "key") ?? bindings(item)[0];
  const activate = (item: MenuItem) => { onClose(); item.onSelect(); };
  const shortcut = (event: React.KeyboardEvent | React.MouseEvent) => {
    if (event.defaultPrevented || useShortcuts.getState().recording || ("key" in event && event.repeat)) return;
    // Preserve native menu activation and navigation even if a context action uses those keys.
    if ("key" in event && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ["Enter", " ", "Tab", "Escape", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const candidates = visibleItems.filter(item => !item.disabled && bindings(item).some(b => matches(b, event.nativeEvent)));
    const focusedLabel = (event.target as Element).closest('[role="menuitem"]')?.getAttribute("aria-label");
    const item = candidates.find(item => item.label === focusedLabel) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (item) { event.preventDefault(); event.stopPropagation(); activate(item); }
  };
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
    const left = Math.max(8 / zoom, Math.min(x / zoom, (window.innerWidth - 8) / zoom - width));
    const top = Math.max(8 / zoom, Math.min(y / zoom, (window.innerHeight - 8) / zoom - height));
    // Grow from the point that was clicked.
    setPos({ left, top, transformOrigin: `${Math.max(0, Math.min(x / zoom - left, width))}px ${Math.max(0, Math.min(y / zoom - top, height))}px` });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [x, y, zoom]);

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
    <div ref={ref} popover={typeof HTMLElement.prototype.showPopover === "function" ? "manual" : undefined} data-popover="" className={`menu${leaving ? " is-closing" : ""}`} role="menu" aria-label="Context actions" style={{ ...bounds, ...pos }} onKeyDownCapture={shortcut} onMouseDown={e => { if (e.button !== 0 || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) shortcut(e); }} onKeyDown={onKeyDown} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {visibleItems.map((item) => (
        <button
          key={item.label}
          type="button"
          tabIndex={-1}
          role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={item.checked}
          className={`menu-item${item.danger ? " danger" : ""}${item.separated ? " separated" : ""}`}
          disabled={item.disabled}
          aria-label={item.label}
          aria-keyshortcuts={bindings(item).filter(b => b.kind === "key" && b.mode !== "physical").map(b => b.kind === "key" ? [...resolvedModifiers(b.modifiers), b.key === " " ? "Space" : b.key === "+" ? "Plus" : b.key].join("+") : "").join(" ") || undefined}
          onClick={() => activate(item)}
        >
          <span className="menu-item-label">{item.label}</span>
          {item.checked && <Icon name="check" size={14} />}
          {hint(item) && <span className="menu-item-shortcuts" title={bindings(item).map(format).join(" / ")}><ShortcutKeys binding={hint(item)!} /></span>}
        </button>
      ))}
    </div>
  );
}

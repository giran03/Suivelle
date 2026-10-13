import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { DateTime } from "luxon";
import { Icon } from "./Icon";
import "./date-field.css";

/** Keeps native typing and validation, with a themed calendar in the top layer. */
export function DateField({ value, onChange, label, type = "date", required = false, disabled = false, min, max }: {
  value: string; onChange: (value: string) => void; label: string; type?: "date" | "datetime-local"; required?: boolean; disabled?: boolean;
  /** Earliest and latest choice, in the field's own format; days outside are disabled in the picker. */
  min?: string; max?: string;
}) {
  const minDay = min?.slice(0, 10), maxDay = max?.slice(0, 10);
  const id = useId();
  const field = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const selected = value?.slice(0, 10) ?? "";
  const initial = DateTime.fromISO(selected).isValid ? DateTime.fromISO(selected) : DateTime.local();
  const [month, setMonth] = useState<DateTime>(() => initial.startOf("month"));
  const [cursor, setCursor] = useState(() => initial.toISODate()!);
  const [open, setOpen] = useState(false);
  const today = DateTime.local().toISODate();
  const first = month.startOf("week");
  const days = Array.from({ length: 42 }, (_, i) => first.plus({ days: i }));

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!picker.current?.contains(e.target as Node)) picker.current?.hidePopover(); };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !field.current || !picker.current) return;
    const el = picker.current, anchor = field.current.getBoundingClientRect();
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const width = el.offsetWidth, height = el.offsetHeight;
    const below = anchor.bottom / zoom + 4;
    const flip = below + height > (window.innerHeight - 8) / zoom;
    el.style.left = `${Math.max(8 / zoom, Math.min(anchor.left / zoom, (window.innerWidth - 8) / zoom - width))}px`;
    el.style.top = `${flip ? Math.max(8 / zoom, anchor.top / zoom - height - 4) : below}px`;
    el.style.transformOrigin = flip ? "bottom left" : "top left";
    el.querySelector<HTMLButtonElement>(`[data-date="${cursor}"]`)?.focus({ preventScroll: true });
  }, [open, month, cursor]);

  const choose = (date: string) => {
    if (date && minDay && date < minDay) date = minDay;
    if (date && maxDay && date > maxDay) date = maxDay;
    onChange(date && type === "datetime-local" ? `${date}T${value?.split("T")[1] || "09:00"}` : date);
    picker.current?.hidePopover();
  };
  return <div ref={field} className="date-field">
    <input type={type} aria-label={label} value={value ?? ""} required={required} disabled={disabled} min={min || undefined} max={max || undefined}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); field.current?.querySelector<HTMLButtonElement>(".date-field-toggle")?.click(); }
      }} />
    <button type="button" className="date-field-toggle" disabled={disabled} popoverTarget={id} popoverTargetAction="toggle"
      aria-label={`${open ? "Close" : "Open"} date picker for ${label}`} aria-expanded={open} aria-controls={id}
      onClick={() => { if (!open) { setMonth(initial.startOf("month")); setCursor(initial.toISODate()!); } }}>
      <Icon key={open ? "close" : "calendar"} name={open ? "close" : "calendar"} size={16} />
    </button>
    <div ref={picker} id={id} popover="auto" className="popover date-picker" role="dialog" aria-label="Choose date"
      onToggle={(e) => setOpen(e.newState === "open")}>
      <div className="date-picker-head">
        <strong aria-live="polite">{month.toFormat("MMMM yyyy")}</strong>
        <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => { const m = month.minus({ months: 1 }); setMonth(m); setCursor(m.toISODate()!); }}><Icon name="back" /></button>
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => { const m = month.plus({ months: 1 }); setMonth(m); setCursor(m.toISODate()!); }}><Icon name="forward" /></button>
      </div>
      <div className="date-picker-weekdays" aria-hidden="true">{["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map(d => <span key={d}>{d}</span>)}</div>
      <div className="date-picker-grid" role="grid" aria-label={month.toFormat("MMMM yyyy")}
        onKeyDown={(e) => {
          const d = DateTime.fromISO(cursor);
          let next: DateTime;
          switch (e.key) {
            case "ArrowLeft": next = d.minus({ days: 1 }); break;
            case "ArrowRight": next = d.plus({ days: 1 }); break;
            case "ArrowUp": next = d.minus({ days: 7 }); break;
            case "ArrowDown": next = d.plus({ days: 7 }); break;
            case "Home": next = d.startOf("week"); break;
            case "End": next = d.endOf("week"); break;
            case "PageUp": next = d.minus(e.shiftKey ? { years: 1 } : { months: 1 }); break;
            case "PageDown": next = d.plus(e.shiftKey ? { years: 1 } : { months: 1 }); break;
            default: return;
          }
          e.preventDefault(); e.stopPropagation(); setCursor(next.toISODate()!);
          if (next.month !== month.month || next.year !== month.year) setMonth(next.startOf("month"));
        }}>
        {Array.from({ length: 6 }, (_, row) => <div role="row" key={row}>
          {days.slice(row * 7, row * 7 + 7).map(d => {
            const date = d.toISODate()!;
            const blocked = (!!minDay && date < minDay) || (!!maxDay && date > maxDay);
            return <button type="button" role="gridcell" className="date-picker-day" key={date} data-date={date} aria-disabled={blocked || undefined}
              data-other={d.month !== month.month || undefined} aria-label={d.toLocaleString(DateTime.DATE_FULL)}
              aria-selected={date === selected} aria-current={date === today ? "date" : undefined}
              tabIndex={date === cursor ? 0 : -1} onFocus={() => setCursor(date)} onClick={() => { if (!blocked) choose(date); }}>{d.day}</button>;
          })}
        </div>)}
      </div>
      <div className="date-picker-footer">
        <button type="button" className="btn" onClick={() => choose("")}>Clear</button>
        <button type="button" className="btn" onClick={() => choose(today!)}>Today</button>
      </div>
    </div>
  </div>;
}

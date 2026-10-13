import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { DateTime } from "luxon";
import { Icon } from "./Icon";
import "./date-field.css";
import "./date-range-field.css";

type Range = { start: string; end: string };
type View = "days" | "months" | "years";
/** The end is inclusive for all-day ranges; timed values use local ISO timestamps. */
export function DateRangeField({ start, end, allDay, onChange, maxDays = 366 }: Range & {
  allDay: boolean; onChange: (range: Range) => void; maxDays?: number;
}) {
  const id = useId();
  const field = useRef<HTMLButtonElement>(null), picker = useRef<HTMLDivElement>(null);
  const initial = DateTime.fromISO(start).isValid ? DateTime.fromISO(start) : DateTime.local();
  const [draft, setDraft] = useState<Range>({ start, end });
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("days");
  const [month, setMonth] = useState<DateTime>(initial.startOf("month"));
  const [cursor, setCursor] = useState(initial.toISODate()!);
  const [endpoint, setEndpoint] = useState<"start" | "end">("start");
  const [hover, setHover] = useState<string | null>(null);
  const a = DateTime.fromISO(draft.start), b = DateTime.fromISO(draft.end);
  const error = !a.isValid || !b.isValid ? "Choose both dates."
    : (allDay ? b < a : b <= a) ? "The end must follow the start."
    : b.diff(a, "days").days + (allDay ? 1 : 0) > maxDays ? `Choose a range of at most ${maxDays} days.` : null;
  const startDay = draft.start.slice(0, 10), endDay = draft.end.slice(0, 10);
  const preview = endpoint === "end" && hover ? [startDay, hover].sort() : [startDay, endDay];
  const today = DateTime.local().toISODate();
  const first = month.startOf("week");
  const days = Array.from({ length: 42 }, (_, i) => first.plus({ days: i }));
  const decade = Math.floor(month.year / 10) * 10;
  const display = (value: string) => {
    const d = DateTime.fromISO(value);
    return d.isValid ? d.toFormat(allDay ? "dd LLL yyyy" : "dd LLL yyyy · HH:mm") : "Choose date";
  };
  const withDay = (date: string, previous: string, fallback: string) => date + (allDay ? "" : `T${previous.split("T")[1] || fallback}`);
  const choose = (date: string) => {
    if (endpoint === "start") {
      const nextStart = withDay(date, draft.start, "09:00");
      let nextEnd = draft.end;
      if (draft.end.slice(0, 10) < date) nextEnd = withDay(date, draft.end, "10:00");
      if (!allDay && nextEnd <= nextStart) nextEnd = DateTime.fromISO(nextStart).plus({ hours: 1 }).toFormat("yyyy-MM-dd'T'HH:mm");
      setDraft({ start: nextStart, end: nextEnd });
      setEndpoint("end");
    } else {
      const [from, through] = [startDay, date].sort();
      setDraft({ start: withDay(from, draft.start, "09:00"), end: withDay(through, draft.end, "10:00") });
      setEndpoint("start");
    }
    setHover(null); setCursor(date);
    if (DateTime.fromISO(date).month !== month.month) setMonth(DateTime.fromISO(date).startOf("month"));
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!picker.current?.contains(e.target as Node)) picker.current?.hidePopover(); };
    window.addEventListener("resize", close); window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !field.current || !picker.current) return;
    const el = picker.current, anchor = field.current.getBoundingClientRect();
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const below = anchor.bottom / zoom + 6;
    const flip = below + el.offsetHeight > (window.innerHeight - 8) / zoom;
    el.style.left = `${Math.max(8 / zoom, Math.min(anchor.left / zoom, (window.innerWidth - 8) / zoom - el.offsetWidth))}px`;
    el.style.top = `${flip ? Math.max(8 / zoom, anchor.top / zoom - el.offsetHeight - 6) : below}px`;
    el.style.transformOrigin = flip ? "bottom left" : "top left";
  }, [open, view, month, allDay, error]);
  useLayoutEffect(() => {
    if (open && view === "days") picker.current?.querySelector<HTMLButtonElement>(`[data-date="${cursor}"]`)?.focus({ preventScroll: true });
  }, [open, cursor, view]);
  const navigate = (direction: number) => {
    const m = month.plus(view === "days" ? { months: direction } : { years: direction * (view === "years" ? 10 : 1) });
    setMonth(m); setCursor(m.toISODate()!); setHover(null);
  };
  return <div className="date-range-field">
    <span id={`${id}-label`} className="date-range-label">Date range</span>
    <button ref={field} type="button" className="date-range-trigger" aria-labelledby={`${id}-label ${id}-value`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id} popoverTarget={id} popoverTargetAction="toggle"
      onClick={() => {
        if (!open) { setDraft({ start, end }); setMonth(initial.startOf("month")); setCursor(initial.toISODate()!); setView("days"); setEndpoint("start"); setHover(null); }
      }}>
      <span id={`${id}-value`} className="date-range-value"><span>{display(start)}</span><Icon name="forward" size={14} /><span>{display(end)}</span></span>
      <Icon name={open ? "close" : "calendar"} size={16} />
    </button>
    <div ref={picker} id={id} popover="auto" className="popover date-picker date-range-picker" role="dialog" aria-label="Choose date range"
      onToggle={e => setOpen(e.newState === "open")}>
      <div className="date-range-endpoints">
        {(["start", "end"] as const).map(key => <div key={key} className="date-range-endpoint" data-active={endpoint === key || undefined}>
          <label htmlFor={`${id}-${key}`}>{key === "start" ? "Start" : allDay ? "Through" : "End"}</label>
          <input id={`${id}-${key}`} type="date" value={draft[key].slice(0, 10)} aria-label={`${key === "start" ? "Start" : "End"} date`}
            onFocus={() => { setEndpoint(key); setHover(null); }}
            onChange={e => setDraft(d => ({ ...d, [key]: withDay(e.target.value, d[key], key === "start" ? "09:00" : "10:00") }))} />
          {!allDay && <input type="time" aria-label={`${key === "start" ? "Start" : "End"} time`} value={draft[key].split("T")[1] || ""}
            onChange={e => setDraft(d => ({ ...d, [key]: `${d[key].slice(0, 10)}T${e.target.value}` }))} />}
        </div>)}
      </div>
      <div className="date-picker-head date-range-head">
        <div>
          <button type="button" className="date-range-heading" aria-label="Choose month" onClick={() => setView(view === "months" ? "days" : "months")}>{month.toFormat("MMMM")}</button>
          <button type="button" className="date-range-heading" aria-label="Choose year" onClick={() => setView(view === "years" ? "days" : "years")}>{view === "years" ? `${decade}–${decade + 9}` : month.year}</button>
        </div>
        <button type="button" className="icon-btn" aria-label={`Previous ${view === "days" ? "month" : view === "months" ? "year" : "decade"}`} onClick={() => navigate(-1)}><Icon name="back" /></button>
        <button type="button" className="icon-btn" aria-label={`Next ${view === "days" ? "month" : view === "months" ? "year" : "decade"}`} onClick={() => navigate(1)}><Icon name="forward" /></button>
      </div>
      {view === "days" ? <>
        <div className="date-picker-weekdays" aria-hidden="true">{["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map(d => <span key={d}>{d}</span>)}</div>
        <div className="date-picker-grid date-range-grid" role="grid" aria-multiselectable="true" aria-label={month.toFormat("MMMM yyyy")}
          onPointerLeave={() => setHover(null)} onKeyDown={e => {
            const d = DateTime.fromISO(cursor);
            const next = e.key === "ArrowLeft" ? d.minus({ days: 1 }) : e.key === "ArrowRight" ? d.plus({ days: 1 })
              : e.key === "ArrowUp" ? d.minus({ days: 7 }) : e.key === "ArrowDown" ? d.plus({ days: 7 })
              : e.key === "Home" ? d.startOf("week") : e.key === "End" ? d.endOf("week")
              : e.key === "PageUp" ? d.minus(e.shiftKey ? { years: 1 } : { months: 1 })
              : e.key === "PageDown" ? d.plus(e.shiftKey ? { years: 1 } : { months: 1 }) : null;
            if (!next) return;
            e.preventDefault(); e.stopPropagation(); setCursor(next.toISODate()!); setHover(null);
            if (next.month !== month.month || next.year !== month.year) setMonth(next.startOf("month"));
          }}>
          {Array.from({ length: 6 }, (_, row) => <div role="row" key={row}>{days.slice(row * 7, row * 7 + 7).map(d => {
            const date = d.toISODate()!, inRange = date >= preview[0] && date <= preview[1];
            return <div role="presentation" className="date-range-cell" key={date} data-range={inRange || undefined}
              data-from={date === preview[0] || undefined} data-through={date === preview[1] || undefined}>
              <button type="button" role="gridcell" className="date-picker-day" data-date={date}
                data-other={d.month !== month.month || undefined} data-endpoint={date === preview[0] || date === preview[1] || undefined}
                aria-label={d.toLocaleString(DateTime.DATE_FULL)} aria-selected={date >= startDay && date <= endDay}
                aria-current={date === today ? "date" : undefined} tabIndex={date === cursor ? 0 : -1}
                onFocus={() => setCursor(date)} onPointerEnter={() => setHover(date)} onClick={() => choose(date)}>{d.day}</button>
            </div>;
          })}</div>)}
        </div>
      </> : <div className="date-range-periods" role="group" aria-label={view === "months" ? "Months" : "Years"}>
        {Array.from({ length: 12 }, (_, i) => {
          const m = view === "months" ? month.set({ month: i + 1 }) : month.set({ year: decade - 1 + i });
          const selected = view === "months" ? m.month === month.month : m.year === month.year;
          return <button type="button" className="date-range-period" key={i} aria-pressed={selected}
            onClick={() => { setMonth(m.startOf("month")); setCursor(m.startOf("month").toISODate()!); setView(view === "years" ? "months" : "days"); }}>
            {view === "months" ? m.toFormat("LLL") : m.year}
          </button>;
        })}
      </div>}
      <p className={error ? "date-range-hint field-error" : "date-range-hint"} role={error ? "alert" : "status"}>
        {error || `Choose ${endpoint === "start" ? "a start" : "an end"} date${endpoint === "end" ? " to finish the range" : ""}.`}
      </p>
      <div className="date-picker-footer date-range-footer">
        <button type="button" className="btn ghost" onClick={() => picker.current?.hidePopover()}>Cancel</button>
        <button type="button" className="btn primary" disabled={!!error} onClick={() => { onChange(draft); picker.current?.hidePopover(); }}>Apply range</button>
      </div>
    </div>
  </div>;
}

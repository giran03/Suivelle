// Day arithmetic for the calendar and timeline. Days are "YYYY-MM-DD" strings; they are never
// converted through local time, so a date never shifts with the time zone or a daylight-saving change.

const DAY_MS = 86_400_000;

const toUtc = (iso: string): number => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const dayOf = (iso: string): string => iso.slice(0, 10);

export const addDays = (iso: string, n: number): string => fromUtc(toUtc(iso) + n * DAY_MS);

/** Whole days from `a` to `b` (negative when b is earlier). */
export const daysBetween = (a: string, b: string): number => Math.round((toUtc(b) - toUtc(a)) / DAY_MS);

/** 0 = Monday … 6 = Sunday. */
export const weekday = (iso: string): number => (new Date(toUtc(iso)).getUTCDay() + 6) % 7;

export const todayIso = (now = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
};

export const monthOf = (iso: string): string => iso.slice(0, 7);

export const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthTitle = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
};

/** The 6 weeks (42 days, Monday first) that make up a month's grid, including spill-over days. */
export function monthGrid(month: string): string[] {
  const first = `${month}-01`;
  const start = addDays(first, -weekday(first));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export interface DateSpan {
  start: string;
  end?: string;
}

export function spanOf(value: unknown): DateSpan | null {
  if (!value || typeof value !== "object") return null;
  const { start, end } = value as { start?: unknown; end?: unknown };
  if (typeof start !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(start)) return null;
  return { start, ...(typeof end === "string" && end ? { end } : {}) };
}

/** The first and last day a record covers (a record with no end covers one day). */
export function daysOf(span: DateSpan): { first: string; last: string } {
  const first = dayOf(span.start);
  const last = span.end ? dayOf(span.end) : first;
  return { first, last: last < first ? first : last };
}

const shift = (iso: string, n: number): string => addDays(iso, n) + iso.slice(10);

/** Moves a whole date value by `days`, keeping any time of day. */
export function shiftSpan(span: DateSpan, days: number): DateSpan {
  return { start: shift(span.start, days), ...(span.end ? { end: shift(span.end, days) } : {}) };
}

/**
 * Moves one edge. The start cannot pass the end and the end cannot precede the start; dragging
 * the end of a one-day record gives it an end date.
 */
export function resizeSpan(span: DateSpan, edge: "start" | "end", days: number): DateSpan {
  const { first, last } = daysOf(span);
  if (edge === "start") {
    const next = Math.min(daysBetween(first, last), days);
    return { start: shift(span.start, next), ...(span.end ? { end: span.end } : {}) };
  }
  const nextLast = addDays(last, days);
  const end = nextLast < first ? first : nextLast;
  if (end === first && !span.end) return { start: span.start };
  return { start: span.start, end: span.end && span.end.length > 10 ? `${end}${span.end.slice(10)}` : end };
}

export type Zoom = "week" | "month" | "quarter";

/** Pixels per day and how many days the timeline shows, per zoom level. */
export const ZOOM: Record<Zoom, { px: number; span: number; label: string }> = {
  week: { px: 44, span: 42, label: "Week" },
  month: { px: 16, span: 150, label: "Month" },
  quarter: { px: 6, span: 450, label: "Quarter" },
};

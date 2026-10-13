import { DateTime } from "luxon";
export interface CalendarLink {
  pageId: string;
  blockId: string | null;
  label: string;
}
export interface CalendarRepeat {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  days: number[];
  until: string | null;
  count: number | null;
}
export interface CalendarException {
  date: string;
  cancelled: boolean;
  start: string | null;
  end: string | null;
}
export interface CalendarSchedule {
  importedDescription?: string | null;
  followSourceTitle?: boolean;
  calendarId: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  recurrence: CalendarRepeat | null;
  exceptions: CalendarException[];
  links: CalendarLink[];
  reminders: number[];
  location: string;
  completed: boolean;
  busy: boolean;
  /** Explicit `#RRGGBB`; absent means the view assigns one. */
  color?: string;
}
export interface CalendarEvent {
  notes?: string;
  pageId: string;
  blockId: string;
  revision: number;
  title: string;
  data: CalendarSchedule;
}
export interface CalendarOccurrence {
  id: string;
  pageId: string;
  originalDate: string;
  start: string;
  end: string;
  allDay: boolean;
}
export interface CalendarSource {
  kind: "calendar" | "database";
  pageId: string;
  propertyId?: string;
  viewId?: string;
  timezone?: string;
  label?: string;
  color?: string;
  writable?: boolean;
}
export const CALENDAR_VIEWS = {
  dayGridMonth: "Month",
  timeGridWeek: "Week",
  timeGridDay: "Day",
  listWeek: "Agenda",
  multiMonthYear: "Year",
} as const;
export type CalendarView = keyof typeof CALENDAR_VIEWS;
export interface CalendarConfig {
  sources: CalendarSource[];
  view: CalendarView;
  height: number;
  timezone: string;
  weekStart: number;
  weekends: boolean;
  isCollection: boolean;
  calendarId: string | null;
  workStart: string;
  workEnd: string;
  autoColor: boolean;
  weekNumbers: boolean;
}
export const localZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export const sourceKey = (s: CalendarSource) =>
  `${s.kind}:${s.pageId}:${s.propertyId ?? ""}`;
export function calendarConfig(input: Record<string, unknown>): CalendarConfig {
  const sources = Array.isArray(input.sources)
    ? input.sources
        .filter(
          (s): s is CalendarSource =>
            !!s &&
            typeof s === "object" &&
            ["calendar", "database"].includes(s.kind) &&
            typeof s.pageId === "string",
        )
        .slice(0, 32)
    : [];
  return {
    sources: [...new Map(sources.map((s) => [sourceKey(s), s])).values()],
    view:
      typeof input.view === "string" && input.view in CALENDAR_VIEWS
        ? (input.view as CalendarView)
        : "dayGridMonth",
    height:
      typeof input.height === "number" && Number.isFinite(input.height)
        ? Math.max(320, Math.min(1000, input.height))
        : 560,
    timezone:
      typeof input.timezone === "string" &&
      DateTime.now().setZone(input.timezone).isValid
        ? input.timezone
        : localZone(),
    weekStart: input.weekStart === 0 ? 0 : 1,
    weekends: input.weekends !== false,
    isCollection: input.isCollection === true,
    calendarId: typeof input.calendarId === "string" ? input.calendarId : null,
    workStart:
      typeof input.workStart === "string" && /^\d\d:\d\d$/.test(input.workStart)
        ? input.workStart
        : "09:00",
    workEnd:
      typeof input.workEnd === "string" && /^\d\d:\d\d$/.test(input.workEnd)
        ? input.workEnd
        : "18:00",
    autoColor: input.autoColor !== false,
    weekNumbers: input.weekNumbers === true,
  };
}
export const wallTime = (iso: string, zone: string, allDay: boolean) =>
  allDay
    ? iso.slice(0, 10)
    : DateTime.fromISO(iso, { zone })
        .setZone(zone)
        .toFormat("yyyy-MM-dd'T'HH:mm");
export function newSchedule(
  calendarId: string,
  start?: string,
  end?: string,
  allDay = true,
): CalendarSchedule {
  const base = DateTime.fromISO(start ?? DateTime.local().toISODate()!).startOf(
    allDay ? "day" : "minute",
  );
  const format = (d: DateTime) =>
    d.toFormat(allDay ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm");
  return {
    calendarId,
    start: format(base),
    end: end
      ? wallTime(end, localZone(), allDay)
      : format(base.plus(allDay ? { days: 1 } : { hours: 1 })),
    allDay,
    timezone: localZone(),
    recurrence: null,
    exceptions: [],
    links: [],
    reminders: [],
    location: "",
    completed: false,
    busy: true,
  };
}
export function patchOccurrence(
  data: CalendarSchedule,
  originalDate: string,
  start: string,
  end: string,
): CalendarSchedule {
  if (!data.recurrence) return { ...data, start, end };
  return {
    ...data,
    exceptions: [
      ...data.exceptions.filter((e) => e.date !== originalDate),
      { date: originalDate, start, end, cancelled: false },
    ],
  };
}
export function overlaps(
  a: { start: string; end: string },
  b: { start: string; end: string },
) {
  return (
    DateTime.fromISO(a.start).toMillis() < DateTime.fromISO(b.end).toMillis() &&
    DateTime.fromISO(b.start).toMillis() < DateTime.fromISO(a.end).toMillis()
  );
}
export function daySummary(
  items: {
    start: string;
    end: string;
    allDay?: boolean;
    busy?: boolean;
    completed?: boolean;
  }[],
  day: string,
  zone: string,
  workStart = "09:00",
  workEnd = "18:00",
) {
  const from = DateTime.fromISO(day, { zone }).startOf("day").toMillis(),
    to = DateTime.fromISO(day, { zone })
      .plus({ days: 1 })
      .startOf("day")
      .toMillis();
  const intervals = items
    .filter((i) => !i.allDay && i.busy !== false && !i.completed)
    .map((i) => [
      Math.max(from, DateTime.fromISO(i.start, { zone }).toMillis()),
      Math.min(to, DateTime.fromISO(i.end, { zone }).toMillis()),
    ])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let planned = 0,
    occupied = 0,
    end = from,
    conflicts = 0;
  intervals.forEach(([a, b], index) => {
    planned += b - a;
    occupied += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
    conflicts += intervals
      .slice(0, index)
      .filter(([x, y]) => a < y && x < b).length;
  });
  const work = Math.max(
    0,
    DateTime.fromISO(`${day}T${workEnd}`, { zone }).toMillis() -
      DateTime.fromISO(`${day}T${workStart}`, { zone }).toMillis(),
  );
  return {
    plannedMinutes: planned / 60000,
    busyMinutes: occupied / 60000,
    overlapMinutes: (planned - occupied) / 60000,
    workMinutes: work / 60000,
    conflicts,
  };
}

/** Mid-tone colors that keep white text readable in light and dark themes. The default blue is left out so ranges never match plain events. */
export const AUTO_COLORS = [
  "#2f7f86",
  "#387357",
  "#8a6a1f",
  "#805834",
  "#a34250",
  "#a03d7a",
  "#785099",
  "#5b5fc7",
  "#4a6b82",
];
/** Stable per page, so a range keeps its color while the visible month changes. */
export function autoColor(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return AUTO_COLORS[(h >>> 0) % AUTO_COLORS.length];
}
export const HEX_COLOR = /^#[\da-f]{6}$/i;
/** Black or white, whichever reads better on the given `#RRGGBB`. */
export function readableText(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 160 ? "#111827" : "#ffffff";
}
/** Explicit color first, then (for multi-day ranges) an automatic one, else the source color. */
export function eventColor(
  data: Pick<CalendarSchedule, "color" | "start" | "end" | "allDay">,
  pageId: string,
  source: string | undefined,
  auto: boolean,
) {
  if (data.color && HEX_COLOR.test(data.color)) return data.color;
  return auto && spanDays(data) > 1 ? autoColor(pageId) : source;
}
/** Calendar days an event touches; an all-day end is exclusive. */
export function spanDays(
  d: Pick<CalendarSchedule, "start" | "end" | "allDay">,
) {
  const a = DateTime.fromISO(d.start.slice(0, 10)),
    b = DateTime.fromISO(d.end.slice(0, 10));
  if (!a.isValid || !b.isValid) return 1;
  const days = Math.round(b.diff(a, "days").days);
  return d.allDay ? Math.max(1, days) : Math.max(1, days + 1);
}
const stamp = (d: DateTime, allDay: boolean) =>
  d.toFormat(allDay ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm");
const minimumLength = (allDay: boolean) =>
  allDay ? { days: 1 } : { minutes: 15 };
/** The latest an end can be, mirroring the one-year limit the backend enforces. */
export const maxEnd = (start: string, allDay: boolean) => {
  const a = DateTime.fromISO(start);
  return a.isValid ? stamp(a.plus({ days: 366 }), allDay) : "";
};
/** Moving the start keeps the event's length, so the end never falls behind it. */
export function moveStart(
  data: Pick<CalendarSchedule, "start" | "end" | "allDay">,
  start: string,
) {
  const a = DateTime.fromISO(start);
  const oldA = DateTime.fromISO(data.start),
    oldB = DateTime.fromISO(data.end);
  if (!a.isValid) return { start, end: data.end };
  const keep = oldA.isValid && oldB.isValid && oldB > oldA ? oldB.diff(oldA) : null;
  const end = keep
    ? a.plus(keep)
    : a.plus(minimumLength(data.allDay));
  return { start, end: stamp(end, data.allDay) };
}
/** Picking an end before the start snaps it to the earliest valid end. */
export function clampEnd(
  data: Pick<CalendarSchedule, "start" | "allDay">,
  end: string,
) {
  const a = DateTime.fromISO(data.start),
    b = DateTime.fromISO(end);
  if (!a.isValid || !b.isValid) return end;
  const floor = a.plus(minimumLength(data.allDay));
  return b < floor ? stamp(floor, data.allDay) : end;
}
/** What blocks saving, in plain words, or null when the schedule is usable. */
export function scheduleProblem(
  d: Pick<CalendarSchedule, "start" | "end" | "allDay">,
) {
  const a = DateTime.fromISO(d.start),
    b = DateTime.fromISO(d.end);
  if (!a.isValid) return "Choose a start.";
  if (!b.isValid) return d.allDay ? "Choose a through date." : "Choose an end.";
  if (b <= a)
    return d.allDay
      ? "The through date can't be before the start."
      : "The end must be after the start.";
  if (b.diff(a, "days").days > 366) return "Events can span at most one year.";
  return null;
}
/** "3 days", "1 h 30 min" — shown beside the date fields. */
export function durationLabel(
  d: Pick<CalendarSchedule, "start" | "end" | "allDay">,
) {
  if (scheduleProblem(d)) return "";
  if (d.allDay) {
    const n = spanDays(d);
    return `${n} ${n === 1 ? "day" : "days"}`;
  }
  const minutes = Math.round(
    DateTime.fromISO(d.end).diff(DateTime.fromISO(d.start), "minutes").minutes,
  );
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    mins = minutes % 60;
  return [
    days && `${days} ${days === 1 ? "day" : "days"}`,
    hours && `${hours} h`,
    mins && `${mins} min`,
  ]
    .filter(Boolean)
    .join(" ");
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_WORD =
  "(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
const weekdayIndex = (word: string) =>
  DAYS.indexOf(word.slice(0, 3).toLowerCase());
const hour24 = (h: number, meridiem?: string) =>
  meridiem ? (h % 12) + (meridiem === "pm" ? 12 : 0) : h;
const clock = (h: number, m?: string) =>
  h > 23 || (m && +m > 59) ? null : [h, m ? +m : 0];
const minutesOf = (t: number[]) => t[0] * 60 + t[1];
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const DURATION = /\bfor\s+(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?)\b/i;
const TIME_RANGE =
  /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
const TIME =
  /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2})(?::(\d{2}))?\b|\b(\d{1,2}):(\d{2})\b/i;
const DAY_RANGE = new RegExp(
  String.raw`\b(${DAY_WORD})\s*(?:-|–|—|to|through|thru)\s*(${DAY_WORD})\b`,
  "i",
);
const DAY = new RegExp(String.raw`\b(${DAY_WORD}|today|tomorrow)\b`, "i");
export interface QuickAdd {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
}
/**
 * Reads a phrase such as "Focus session Mon–Wed 9am", "Review tomorrow 2–3:30pm" or
 * "Call 2026-11-02 at 14:00 for 45 min". A weekday means the next one, today included.
 */
export function parseQuickAdd(input: string, today: DateTime): QuickAdd {
  let text = ` ${input} `;
  const take = (re: RegExp) => {
    const m = re.exec(text);
    if (m) text = text.replace(re, " ");
    return m;
  };
  const day0 = today.startOf("day");
  const next = (from: DateTime, index: number) =>
    from.plus({ days: (index - (from.weekday - 1) + 7) % 7 });
  const iso = take(ISO_DATE);
  const isoDate = iso && DateTime.fromISO(iso[1]);
  const length = take(DURATION);
  let from: number[] | null = null,
    to: number[] | null = null;
  const range = TIME_RANGE.exec(text);
  if (range && (range[2] || range[3] || range[5] || range[6])) {
    const [, h1, m1, a1, h2, m2, a2] = range;
    const end = a2?.toLowerCase();
    to = clock(hour24(+h2, end), m2);
    from = clock(hour24(+h1, a1?.toLowerCase() ?? end), m1);
    if (!a1 && from && to && minutesOf(from) >= minutesOf(to) && end === "pm")
      from = clock(hour24(+h1, "am"), m1);
    if (from && to) text = text.replace(TIME_RANGE, " ");
    else from = to = null;
  }
  if (!from) {
    const one = take(TIME);
    if (one)
      from = one[1]
        ? clock(hour24(+one[1], one[3].toLowerCase()), one[2])
        : one[4]
          ? clock(+one[4], one[5])
          : clock(+one[6], one[7]);
  }
  let first = day0,
    last: DateTime | null = null;
  const span = take(DAY_RANGE);
  if (isoDate?.isValid) first = isoDate;
  else if (span) {
    first = next(day0, weekdayIndex(span[1]));
    last = next(first, weekdayIndex(span[2]));
  } else {
    const word = take(DAY);
    if (word) {
      const w = word[1].toLowerCase();
      first =
        w === "today"
          ? day0
          : w === "tomorrow"
            ? day0.plus({ days: 1 })
            : next(day0, weekdayIndex(w));
    }
  }
  const title = text
    .replace(/\b(on|at|from)\s*$/i, " ")
    .replace(/^\s*(on|at|from)\b/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  const day = (d: DateTime) => d.toFormat("yyyy-MM-dd");
  if (!from)
    return {
      title,
      start: day(first),
      end: day((last ?? first).plus({ days: 1 })),
      allDay: true,
    };
  const at = (d: DateTime, t: number[]) => d.set({ hour: t[0], minute: t[1] });
  const start = at(first, from);
  let minutes = 60;
  if (length) {
    const n = +length[1];
    minutes = Math.max(1, Math.round(/^h/i.test(length[2]) ? n * 60 : n));
  }
  let end = to ? at(last ?? first, to) : at(last ?? first, from).plus({ minutes });
  if (end <= start) end = start.plus({ minutes: 60 });
  const stamp = (d: DateTime) => d.toFormat("yyyy-MM-dd'T'HH:mm");
  return { title, start: stamp(start), end: stamp(end), allDay: false };
}

/**
 * Turns typed phrases into dates: "tomorrow", "next fri", "in 2 weeks", "oct 12", "12/10/2027",
 * "friday at 3pm". Everything is local time and English; anything it does not understand is null,
 * never a guess. Pure, so it can be tested with a fixed "now".
 */
export interface ParsedDate {
  /** yyyy-mm-dd */
  date: string;
  /** HH:MM, when the phrase named a time. */
  time?: string;
}

export interface Options {
  now?: Date;
  /** How a numeric date like 10/12 reads. Defaults to the system's habit. */
  order?: "mdy" | "dmy";
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const pad = (n: number) => String(n).padStart(2, "0");
export const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(d.getDate(), last));
  return r;
}

function real(y: number, m: number, d: number): Date | null {
  const x = new Date(y, m - 1, d);
  return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d ? x : null;
}

const prefixIndex = (names: string[], word: string): number => (word.length >= 3 ? names.findIndex((n) => n.startsWith(word)) : -1);
const weekday = (w: string) => (w === "tues" || w === "thur" || w === "thurs" ? DAYS.findIndex((n) => n.startsWith(w.slice(0, 3))) : prefixIndex(DAYS, w));
const month = (w: string) => (w === "sept" ? 8 : prefixIndex(MONTHS, w));

function systemOrder(): "mdy" | "dmy" {
  try {
    const parts = new Intl.DateTimeFormat(typeof navigator !== "undefined" ? navigator.language : "en-US").formatToParts(new Date(2000, 10, 25));
    const names = parts.map((p) => p.type).filter((t) => t === "day" || t === "month");
    return names[0] === "day" ? "dmy" : "mdy";
  } catch {
    return "mdy";
  }
}

const fullYear = (y: number, digits: number) => (digits <= 2 ? (y < 70 ? 2000 + y : 1900 + y) : y);

/** Pulls a trailing time ("3pm", "at 9:30", "15:45", "noon") off the phrase. */
function takeTime(text: string): { rest: string; time?: string } {
  const twelve = /(?:\bat\s+)?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?=\s|$)/;
  const m12 = twelve.exec(text);
  if (m12) {
    let h = Number(m12[1]);
    const min = Number(m12[2] ?? 0);
    if (h < 1 || h > 12 || min > 59) return { rest: text };
    const pm = m12[3].startsWith("p");
    h = h % 12 + (pm ? 12 : 0);
    return { rest: text.replace(twelve, " ").trim(), time: `${pad(h)}:${pad(min)}` };
  }
  const h24 = /(?:\bat\s+)?\b([01]?\d|2[0-3]):([0-5]\d)(?=\s|$)/.exec(text);
  if (h24) return { rest: text.replace(h24[0], " ").trim(), time: `${pad(Number(h24[1]))}:${h24[2]}` };
  const word = /\b(noon|midday|midnight)\b/.exec(text);
  if (word) return { rest: text.replace(word[0], " ").replace(/\bat\b/, " ").trim(), time: word[1] === "midnight" ? "00:00" : "12:00" };
  return { rest: text };
}

export function parseNaturalDate(input: string, opts: Options = {}): ParsedDate | null {
  const today = startOfDay(opts.now ?? new Date());
  const order = opts.order ?? systemOrder();
  let text = input
    .toLowerCase()
    .replace(/[,]/g, " ")
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1")
    .replace(/^\s*on\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const { rest, time } = takeTime(text);
  text = rest.replace(/^at\s+/, "").replace(/\s+at$/, "").trim();
  const done = (d: Date | null): ParsedDate | null => (d ? { date: isoOf(d), ...(time ? { time } : {}) } : null);

  if (!text) return time ? done(today) : null;

  // Relative words.
  if (text === "today") return done(today);
  if (text === "tomorrow" || text === "tmrw" || text === "tmr") return done(addDays(today, 1));
  if (text === "yesterday") return done(addDays(today, -1));
  if (text === "day after tomorrow") return done(addDays(today, 2));
  if (text === "next week") return done(addDays(today, 7));
  if (text === "next month") return done(addMonths(today, 1));
  if (text === "next year") return done(addMonths(today, 12));
  if (text === "weekend" || text === "this weekend") return done(addDays(today, ((6 - today.getDay() + 7) % 7) || 7));

  const unit = (n: number, u: string): Date | null => {
    if (u.startsWith("d")) return addDays(today, n);
    if (u.startsWith("w")) return addDays(today, n * 7);
    if (u.startsWith("m")) return addMonths(today, n);
    if (u.startsWith("y")) return addMonths(today, n * 12);
    return null;
  };
  let m = /^in (\d+) ?(days?|d|weeks?|w|months?|years?|y)$/.exec(text) ?? /^(\d+) ?(days?|weeks?|months?|years?) (?:from now|later)$/.exec(text);
  if (m) return done(unit(Number(m[1]), m[2]));
  m = /^in (?:a|an|one) (day|week|month|year)$/.exec(text);
  if (m) return done(unit(1, m[1]));
  m = /^(\d+) ?(days?|weeks?|months?|years?) ago$/.exec(text);
  if (m) return done(unit(-Number(m[1]), m[2]));

  // A weekday: the upcoming one, or the one in next week.
  m = /^(next |this |coming |upcoming )?([a-z]+)$/.exec(text);
  if (m) {
    const wd = weekday(m[2]);
    if (wd >= 0) {
      const ahead = ((wd - today.getDay() + 7) % 7) || 7;
      const upcoming = addDays(today, ahead);
      if (m[1]?.trim() !== "next") return done(upcoming);
      // "next friday" is the friday after this week's (weeks start on Monday).
      const daysLeftThisWeek = (7 - today.getDay()) % 7; // Sunday ends the week
      return done(addDays(today, ahead <= daysLeftThisWeek ? ahead + 7 : ahead));
    }
  }

  // yyyy-mm-dd
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (m) return done(real(Number(m[1]), Number(m[2]), Number(m[3])));

  // 10/12, 10/12/27, 10/12/2027, also with . or -
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(text);
  if (m) {
    let a = Number(m[1]);
    let b = Number(m[2]);
    // A part above 12 can only be the day; otherwise follow the system's order.
    const dayFirst = a > 12 ? true : b > 12 ? false : order === "dmy";
    const [day, mon] = dayFirst ? [a, b] : [b, a];
    a = day;
    b = mon;
    const year = m[3] ? fullYear(Number(m[3]), m[3].length) : today.getFullYear();
    return done(real(year, b, a));
  }

  // oct 12, october 12 2027, 12 oct, 12 october 2027, oct 2027
  m = /^([a-z]+) (\d{1,2})(?: (\d{4}))?$/.exec(text);
  if (m && month(m[1]) >= 0) return done(real(m[3] ? Number(m[3]) : today.getFullYear(), month(m[1]) + 1, Number(m[2])));
  m = /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/.exec(text);
  if (m && month(m[2]) >= 0) return done(real(m[3] ? Number(m[3]) : today.getFullYear(), month(m[2]) + 1, Number(m[1])));
  m = /^([a-z]+) (\d{4})$/.exec(text);
  if (m && month(m[1]) >= 0) return done(real(Number(m[2]), month(m[1]) + 1, 1));

  return null;
}

/** A readable form for the preview under the box: "Friday, 10 Oct 2026, 3:00 PM". */
export function describeParsed(p: ParsedDate): string {
  const [y, mo, d] = p.date.split("-").map(Number);
  const date = new Date(y, mo - 1, d);
  const day = date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short", year: "numeric" });
  if (!p.time) return day;
  const [h, min] = p.time.split(":").map(Number);
  return `${day}, ${new Date(2000, 0, 1, h, min).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

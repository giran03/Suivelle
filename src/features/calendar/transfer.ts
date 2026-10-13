import ICAL from "ical.js";
import { DateTime } from "luxon";
import {
  newSchedule,
  localZone,
  type CalendarEvent,
  type CalendarRepeat,
  type CalendarSchedule,
} from "./model";

const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const stamp = (s: string) => s.replace(/[-:]/g, "").replace(/\.\d+/g, "");
const escapeText = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
// Fold on UTF-8 byte boundaries, not JS character positions.
function fold(line: string): string {
  let result = "",
    part = "",
    size = 0;
  for (const c of line) {
    const n = new TextEncoder().encode(c).length;
    if (size + n > 74) {
      result += part + "\r\n ";
      part = "";
      size = 1;
    }
    part += c;
    size += n;
  }
  return result + part;
}
function timezoneComponent(
  zone: string,
  startYear: number,
  endYear: number,
  unbounded: boolean,
): string[] {
  const offset = (n: number) =>
    `${n < 0 ? "-" : "+"}${String(Math.floor(Math.abs(n) / 60)).padStart(2, "0")}${String(Math.abs(n) % 60).padStart(2, "0")}`;
  const first = DateTime.utc(startYear, 1, 1),
    last = DateTime.utc(endYear + 1, 1, 1);
  let previous = first.setZone(zone).offset;
  const initial = previous;
  const changes: {
    at: DateTime;
    before: number;
    after: number;
    kind: string;
  }[] = [];
  for (let t = first.plus({ days: 1 }); t <= last; t = t.plus({ days: 1 })) {
    const current = t.setZone(zone).offset;
    if (current === previous) continue;
    let low = t.minus({ days: 1 }).toMillis(),
      high = t.toMillis();
    while (high - low > 60000) {
      const mid = Math.floor((low + high) / 120000) * 60000;
      if (DateTime.fromMillis(mid, { zone }).offset === previous) low = mid;
      else high = mid;
    }
    changes.push({
      at: DateTime.fromMillis(high, { zone: "UTC" }).plus({
        minutes: previous,
      }),
      before: previous,
      after: current,
      kind: current > previous ? "DAYLIGHT" : "STANDARD",
    });
    previous = current;
  }
  const lines = [
    "BEGIN:VTIMEZONE",
    `TZID:${zone}`,
    "BEGIN:STANDARD",
    `DTSTART:${first.plus({ minutes: initial }).toFormat("yyyyMMdd'T'HHmmss")}`,
    `TZOFFSETFROM:${offset(initial)}`,
    `TZOFFSETTO:${offset(initial)}`,
    "END:STANDARD",
  ];
  const rule = (d: DateTime) =>
    `FREQ=YEARLY;BYMONTH=${d.month};BYDAY=${d.day + 7 > d.daysInMonth! ? -1 : Math.ceil(d.day / 7)}${DAYS[d.weekday - 1]}`;
  for (const change of changes) {
    lines.push(
      `BEGIN:${change.kind}`,
      `DTSTART:${change.at.toFormat("yyyyMMdd'T'HHmmss")}`,
      `TZOFFSETFROM:${offset(change.before)}`,
      `TZOFFSETTO:${offset(change.after)}`,
    );
    if (
      unbounded &&
      changes.filter((c) => c.kind === change.kind).slice(-1)[0] === change
    ) {
      const same = changes.filter((c) => c.kind === change.kind);
      const old = same[same.length - 2];
      if (
        !old ||
        old.before !== change.before ||
        old.after !== change.after ||
        rule(old.at) !== rule(change.at) ||
        old.at.toFormat("HHmmss") !== change.at.toFormat("HHmmss")
      )
        throw new Error(
          `Give recurring events in ${zone} an end date before exporting; its future timezone transitions do not follow a simple yearly rule.`,
        );
      lines.push(`RRULE:${rule(change.at)}`);
    }
    lines.push(`END:${change.kind}`);
  }
  lines.push("END:VTIMEZONE");
  return lines;
}
export function exportCalendar(events: CalendarEvent[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Suivelle//Local Calendar//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const zone of new Set(
    events.filter((e) => !e.data.allDay).map((e) => e.data.timezone),
  )) {
    const zoned = events.filter(
      (e) => !e.data.allDay && e.data.timezone === zone,
    );
    const from =
      Math.min(...zoned.map((e) => Number(e.data.start.slice(0, 4)))) - 1;
    const unbounded = zoned.some(
      (e) =>
        e.data.recurrence &&
        !e.data.recurrence.count &&
        !e.data.recurrence.until,
    );
    const to = Math.max(
      ...zoned.map((e) => {
        const r = e.data.recurrence;
        const year = Number((r?.until ?? e.data.end).slice(0, 4));
        if (r?.count) {
          const days =
            r.count *
            r.interval *
            { daily: 1, weekly: 7, monthly: 31, yearly: 366 }[r.frequency];
          return Math.min(year + 100, year + Math.ceil(days / 365) + 1);
        }
        return r ? year + 10 : year + 1;
      }),
    );
    lines.push(...timezoneComponent(zone, from, to, unbounded));
  }
  for (const event of events) {
    const d = event.data;
    const dateLine = (name: string, value: string) =>
      d.allDay
        ? `${name};VALUE=DATE:${stamp(value)}`
        : `${name};TZID=${d.timezone}:${stamp(value)}00`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.pageId}@suivelle`,
      `DTSTAMP:${DateTime.utc().toFormat("yyyyMMdd'T'HHmmss'Z'")}`,
      `SUMMARY:${escapeText(event.title)}`,
      dateLine("DTSTART", d.start),
      dateLine("DTEND", d.end),
    );
    if (d.location) lines.push(`LOCATION:${escapeText(d.location)}`);
    if (event.notes) lines.push(`DESCRIPTION:${escapeText(event.notes)}`);
    if (d.recurrence) {
      const r = d.recurrence;
      const pieces = [
        `FREQ=${r.frequency.toUpperCase()}`,
        `INTERVAL=${r.interval}`,
      ];
      if (r.days.length && r.frequency === "weekly")
        pieces.push(`BYDAY=${r.days.map((n) => DAYS[n]).join(",")}`);
      if (r.count) pieces.push(`COUNT=${r.count}`);
      else if (r.until)
        pieces.push(
          `UNTIL=${
            d.allDay
              ? stamp(r.until)
              : DateTime.fromISO(r.until + "T23:59:59", { zone: d.timezone })
                  .toUTC()
                  .toFormat("yyyyMMdd'T'HHmmss'Z'")
          }`,
        );
      lines.push(`RRULE:${pieces.join(";")}`);
    }
    lines.push(
      `TRANSP:${d.busy ? "OPAQUE" : "TRANSPARENT"}`,
      `X-SUIVELLE-SCHEDULE:${btoa(Array.from(new TextEncoder().encode(JSON.stringify(d)), (byte) => String.fromCharCode(byte)).join(""))}`,
    );
    for (const x of d.exceptions)
      lines.push(
        dateLine(
          "EXDATE",
          d.allDay ? x.date : x.date + "T" + d.start.slice(11),
        ),
      );
    for (const minutes of d.reminders)
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeText(event.title)}`,
        `TRIGGER:-PT${minutes}M`,
        "END:VALARM",
      );
    lines.push("END:VEVENT");
    for (const x of d.exceptions.filter(
      (x) => !x.cancelled && x.start && x.end,
    )) {
      lines.push(
        "BEGIN:VEVENT",
        `UID:${event.pageId}@suivelle`,
        `DTSTAMP:${DateTime.utc().toFormat("yyyyMMdd'T'HHmmss'Z'")}`,
        `SUMMARY:${escapeText(event.title)}`,
        dateLine(
          "RECURRENCE-ID",
          d.allDay ? x.date : x.date + "T" + d.start.slice(11),
        ),
        dateLine("DTSTART", x.start!),
        dateLine("DTEND", x.end!),
        "END:VEVENT",
      );
    }
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
export function importCalendar(
  text: string,
  calendarId: string,
): { events: { title: string; data: CalendarSchedule }[]; warnings: string[] } {
  if (new TextEncoder().encode(text).length > 5 * 1024 * 1024)
    throw new Error("Calendar files must be under 5 MB.");
  const root = new ICAL.Component(ICAL.parse(text));
  if (root.name !== "vcalendar") throw new Error("Choose an iCalendar file.");
  const components = root.getAllSubcomponents("vevent");
  if (components.length > 1000)
    throw new Error("Import at most 1,000 events at a time.");
  const events: { title: string; data: CalendarSchedule }[] = [];
  const warnings: string[] = [];
  const byUid = new Map<string, CalendarSchedule>();
  for (const c of components.filter(
    (c) => !c.getFirstProperty("recurrence-id"),
  )) {
    const title = String(
      c.getFirstPropertyValue("summary") || "Imported event",
    );
    try {
      if (c.getFirstPropertyValue("status") === "CANCELLED") {
        warnings.push(`Skipped cancelled event “${title}”.`);
        continue;
      }
      const start = c.getFirstPropertyValue("dtstart") as ICAL.Time | null;
      if (!start) throw new Error("no start date");
      const rawZone = String(
        c.getFirstProperty("dtstart")?.getParameter("tzid") ||
          (start.zone.tzid === "UTC" ? "UTC" : localZone()),
      );
      if (!DateTime.now().setZone(rawZone).isValid)
        throw new Error("custom timezone definitions are not supported");
      const end = c.getFirstPropertyValue("dtend") as ICAL.Time | null;
      const data = newSchedule(
        calendarId,
        start.toString().slice(0, start.isDate ? 10 : 16),
        end?.toString().slice(0, start.isDate ? 10 : 16),
        start.isDate,
      );
      data.timezone = rawZone;
      const duration = c.getFirstPropertyValue("duration");
      if (!end && duration instanceof ICAL.Duration) {
        const finish = DateTime.fromISO(data.start, { zone: rawZone }).plus({
          seconds: duration.toSeconds(),
        });
        data.end = finish.toFormat(
          start.isDate ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm",
        );
      }
      if (start.second || end?.second)
        warnings.push(`Times on “${title}” were rounded to the minute.`);
      data.location = String(c.getFirstPropertyValue("location") || "");
      data.busy = c.getFirstPropertyValue("transp") !== "TRANSPARENT";
      const native = c.getFirstPropertyValue("x-suivelle-schedule");
      if (typeof native === "string") {
        const saved = JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(atob(native), (c) => c.charCodeAt(0)),
          ),
        ) as CalendarSchedule;
        Object.assign(data, saved, { calendarId, links: [] });
        if (saved.links?.length)
          warnings.push(
            `Links on “${title}” were not imported; use workspace archives to preserve links.`,
          );
      } else {
        const rule = c.getFirstPropertyValue("rrule") as ICAL.Recur | null;
        if (rule) {
          const unsupported = Object.keys(rule.parts).filter(
            (k) => k !== "BYDAY",
          );
          if (
            unsupported.length ||
            (rule.parts.BYDAY?.length && rule.freq !== "WEEKLY") ||
            (rule.wkst !== undefined &&
              rule.wkst !== ICAL.Time.MONDAY &&
              rule.interval > 1) ||
            !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.freq) ||
            rule.parts.BYDAY?.some((v: string) => !DAYS.includes(v))
          )
            throw new Error("this recurrence rule is not supported");
          data.recurrence = {
            frequency: rule.freq.toLowerCase() as CalendarRepeat["frequency"],
            interval: rule.interval || 1,
            days: (rule.parts.BYDAY ?? []).map((d: string) => DAYS.indexOf(d)),
            count: rule.count || null,
            until: rule.until?.toString().slice(0, 10) ?? null,
          };
          if (rule.until && !rule.until.isDate) {
            const cutoff = DateTime.fromISO(rule.until.toString(), {
              zone: rule.until.zone.tzid === "UTC" ? "UTC" : rawZone,
            }).setZone(rawZone);
            const finalStart = cutoff
              .startOf("day")
              .set({ hour: start.hour, minute: start.minute });
            data.recurrence.until = (
              finalStart > cutoff ? cutoff.minus({ days: 1 }) : cutoff
            ).toISODate();
          }
        }
        for (const p of c.getAllProperties("exdate"))
          for (const time of p.getValues() as ICAL.Time[])
            data.exceptions.push({
              date: time.toString().slice(0, 10),
              cancelled: true,
              start: null,
              end: null,
            });
        for (const alarm of c.getAllSubcomponents("valarm")) {
          const trigger = alarm.getFirstPropertyValue("trigger");
          if (trigger instanceof ICAL.Duration) {
            const n = -trigger.toSeconds() / 60;
            if (Number.isInteger(n) && n >= 0 && n <= 43200)
              data.reminders.push(n);
          }
        }
        if (c.getFirstProperty("rdate") || c.getFirstProperty("exrule"))
          throw new Error(
            "additional recurrence dates or exclusion rules are not supported",
          );
      }
      if (
        !DateTime.fromISO(data.end).isValid ||
        DateTime.fromISO(data.end) <= DateTime.fromISO(data.start)
      )
        throw new Error("invalid end time");
      data.importedDescription =
        String(c.getFirstPropertyValue("description") || "") || null;
      events.push({ title, data });
      byUid.set(String(c.getFirstPropertyValue("uid")), data);
    } catch (e) {
      warnings.push(
        `Skipped “${title}”: ${e instanceof Error ? e.message : String(e)}.`,
      );
    }
  }
  for (const c of components.filter((c) =>
    c.getFirstProperty("recurrence-id"),
  )) {
    const parent = byUid.get(String(c.getFirstPropertyValue("uid")));
    if (!parent) {
      warnings.push("An occurrence override had no imported parent series.");
      continue;
    }
    if (c.getFirstProperty("recurrence-id")?.getParameter("range")) {
      warnings.push(
        "An occurrence override with a future range was skipped; edit the series in Suivelle.",
      );
      continue;
    }
    const original = (c.getFirstPropertyValue("recurrence-id") as ICAL.Time)
      .toString()
      .slice(0, 10);
    if (parent.exceptions.some((x) => x.date === original && !x.cancelled))
      continue;
    const start = c.getFirstPropertyValue("dtstart") as ICAL.Time | null,
      end = c.getFirstPropertyValue("dtend") as ICAL.Time | null;
    const toWall = (time: ICAL.Time | null, name: string) => {
      if (!time) return null;
      if (parent.allDay) return time.toString().slice(0, 10);
      const zone = String(
        c.getFirstProperty(name)?.getParameter("tzid") ||
          (time.zone.tzid === "UTC" ? "UTC" : parent.timezone),
      );
      const value = DateTime.fromISO(time.toString(), { zone }).setZone(
        parent.timezone,
      );
      if (!value.isValid)
        throw new Error("An occurrence override has an unsupported timezone.");
      return value.toFormat("yyyy-MM-dd'T'HH:mm");
    };
    let movedStart: string | null, movedEnd: string | null;
    try {
      movedStart = toWall(start, "dtstart");
      movedEnd = toWall(end, "dtend");
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    parent.exceptions = parent.exceptions.filter((x) => x.date !== original);
    parent.exceptions.push({
      date: original,
      cancelled: c.getFirstPropertyValue("status") === "CANCELLED",
      start: movedStart,
      end: movedEnd,
    });
  }
  return { events, warnings: [...new Set(warnings)] };
}

import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import {
  autoColor,
  AUTO_COLORS,
  calendarConfig,
  clampEnd,
  durationLabel,
  eventColor,
  maxEnd,
  moveStart,
  readableText,
  scheduleProblem,
  spanDays,
  daySummary,
  newSchedule,
  parseQuickAdd,
  patchOccurrence,
  wallTime,
} from "./model";
import { exportCalendar, importCalendar } from "./transfer";
describe("calendar data", () => {
  it("uses the event timezone when applying a UTC recurrence cutoff", () => {
    const text =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Review\r\nDTSTART;TZID=Asia/Manila:20261013T090000\r\nDTEND;TZID=Asia/Manila:20261013T100000\r\nRRULE:FREQ=DAILY;UNTIL=20261014T000000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    expect(importCalendar(text, "c").events[0].data.recurrence?.until).toBe(
      "2026-10-13",
    );
  });
  it("exports a timezone definition for a timed recurring event", () => {
    const data = newSchedule(
      "c",
      "2026-10-13T09:00",
      "2026-10-13T10:00",
      false,
    );
    data.timezone = "America/New_York";
    data.recurrence = {
      frequency: "weekly",
      interval: 1,
      days: [],
      until: null,
      count: null,
    };
    const output = exportCalendar([
      { pageId: "id", blockId: "b", revision: 1, title: "Weekly review", data },
    ]);
    expect(output).toContain("BEGIN:VTIMEZONE");
    expect(output).toContain("TZOFFSETTO:-0400");
    expect(output).toContain("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU");
    expect(importCalendar(output, "target").events[0].data.timezone).toBe(
      "America/New_York",
    );
  });
  it("imports duration and refuses monthly weekday rules", () => {
    const wrap = (rule: string) =>
      `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Review\r\nDTSTART:20261013T090000Z\r\nDURATION:PT90M\r\n${rule}END:VEVENT\r\nEND:VCALENDAR\r\n`;
    expect(importCalendar(wrap(""), "c").events[0].data).toMatchObject({
      start: "2026-10-13T09:00",
      end: "2026-10-13T10:30",
      timezone: "UTC",
    });
    expect(
      importCalendar(wrap("RRULE:FREQ=MONTHLY;BYDAY=MO\r\n"), "c").events,
    ).toHaveLength(0);
  });
  it("counts busy time once and excludes deadlines and completed sessions", () => {
    const summary = daySummary(
      [
        { start: "2026-10-13T09:00", end: "2026-10-13T11:00" },
        { start: "2026-10-13T10:00", end: "2026-10-13T12:00" },
        { start: "2026-10-13", end: "2026-10-14", allDay: true },
        { start: "2026-10-13T13:00", end: "2026-10-13T14:00", completed: true },
      ],
      "2026-10-13",
      "Asia/Manila",
    );
    expect(summary).toMatchObject({
      plannedMinutes: 240,
      busyMinutes: 180,
      overlapMinutes: 60,
      conflicts: 1,
    });
  });
  it("normalizes source identities and keeps calendar dates independent of timezone", () => {
    expect(
      calendarConfig({
        sources: [
          { kind: "calendar", pageId: "p" },
          { kind: "calendar", pageId: "p" },
        ],
        height: Infinity,
      }).sources,
    ).toHaveLength(1);
    expect(calendarConfig({ height: Infinity }).height).toBe(560);
    expect(wallTime("2026-10-13", "America/Los_Angeles", true)).toBe(
      "2026-10-13",
    );
  });
  it("changes one occurrence without moving the series", () => {
    const data = newSchedule("c", "2026-10-13", "2026-10-14");
    data.recurrence = {
      frequency: "daily",
      interval: 1,
      days: [],
      until: null,
      count: null,
    };
    const patched = patchOccurrence(
      data,
      "2026-10-15",
      "2026-10-20",
      "2026-10-21",
    );
    expect(patched.start).toBe(data.start);
    expect(patched.exceptions).toEqual([
      {
        date: "2026-10-15",
        start: "2026-10-20",
        end: "2026-10-21",
        cancelled: false,
      },
    ]);
    expect(data.exceptions).toHaveLength(0);
  });
  it("round trips a recurring event with a moved occurrence through iCalendar", () => {
    const data = newSchedule("c", "2026-10-13", "2026-10-14");
    data.recurrence = {
      frequency: "daily",
      interval: 1,
      days: [],
      until: null,
      count: 4,
    };
    data.exceptions = [
      {
        date: "2026-10-15",
        start: "2026-10-20",
        end: "2026-10-21",
        cancelled: false,
      },
    ];
    const output = exportCalendar([
      { pageId: "id", blockId: "b", revision: 1, title: "Review, café", data },
    ]);
    const result = importCalendar(output, "destination");
    expect(result.warnings).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      title: "Review, café",
      data: { ...data, calendarId: "destination" },
    });
  });
  it("reports unsupported recurrence without silently flattening it", () => {
    const input =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Custom\r\nDTSTART;VALUE=DATE:20261013\r\nDTEND;VALUE=DATE:20261014\r\nRRULE:FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const result = importCalendar(input, "c");
    expect(result.events).toHaveLength(0);
    expect(result.warnings.join()).toContain("recurrence rule");
  });
});

describe("event date rules", () => {
  const range = { allDay: true, start: "2026-10-13", end: "2026-10-16" };
  it("snaps an end before the start to the shortest valid event", () => {
    expect(clampEnd(range, "2026-10-10")).toBe("2026-10-14");
    expect(clampEnd(range, "2026-10-13")).toBe("2026-10-14");
    expect(clampEnd(range, "2026-10-20")).toBe("2026-10-20");
    const timed = { allDay: false, start: "2026-10-13T09:00", end: "2026-10-13T10:00" };
    expect(clampEnd(timed, "2026-10-13T08:00")).toBe("2026-10-13T09:15");
    expect(clampEnd(timed, "2026-10-13T09:30")).toBe("2026-10-13T09:30");
  });
  it("keeps the length when the start moves, past the old end too", () => {
    expect(moveStart(range, "2026-10-20")).toEqual({ start: "2026-10-20", end: "2026-10-23" });
    expect(moveStart(range, "2026-10-01")).toEqual({ start: "2026-10-01", end: "2026-10-04" });
    const timed = { allDay: false, start: "2026-10-13T09:00", end: "2026-10-13T10:30" };
    expect(moveStart(timed, "2026-10-15T14:00").end).toBe("2026-10-15T15:30");
    expect(moveStart({ ...range, end: "" }, "2026-10-20").end).toBe("2026-10-21");
  });
  it("explains what blocks saving and counts a through date inclusively", () => {
    expect(scheduleProblem(range)).toBeNull();
    expect(scheduleProblem({ ...range, end: "2026-10-13" })).toMatch(/before the start/);
    expect(scheduleProblem({ ...range, end: "" })).toMatch(/through/i);
    expect(scheduleProblem({ ...range, end: "2028-01-01" })).toMatch(/one year/);
    expect(scheduleProblem({ allDay: false, start: "2026-10-13T09:00", end: "2026-10-13T09:00" })).toMatch(/after the start/);
    expect(spanDays(range)).toBe(3);
    expect(durationLabel(range)).toBe("3 days");
    expect(durationLabel({ allDay: false, start: "2026-10-13T09:00", end: "2026-10-13T10:30" })).toBe("1 h 30 min");
    expect(maxEnd("2026-10-13", true)).toBe("2027-10-14");
  });
});
describe("event colors", () => {
  const multi = { start: "2026-10-12", end: "2026-10-22", allDay: true };
  it("prefers the event color, then colors only multi-day ranges automatically", () => {
    expect(eventColor({ ...multi, color: "#112233" }, "p", "#355aa4", true)).toBe("#112233");
    expect(eventColor(multi, "p", "#355aa4", true)).toBe(autoColor("p"));
    expect(eventColor(multi, "p", "#355aa4", false)).toBe("#355aa4");
    expect(eventColor({ start: "2026-10-12", end: "2026-10-13", allDay: true }, "p", "#355aa4", true)).toBe("#355aa4");
    expect(eventColor({ ...multi, color: "red" }, "p", "#355aa4", false)).toBe("#355aa4");
  });
  it("assigns the same palette color to a page every time and never the default blue", () => {
    expect(autoColor("page-1")).toBe(autoColor("page-1"));
    expect(AUTO_COLORS).not.toContain("#355aa4");
    const used = new Set(Array.from({ length: 60 }, (_, i) => autoColor(`page-${i}`)));
    expect(used.size).toBeGreaterThan(5);
  });
  it("picks readable text and defaults auto-coloring on", () => {
    expect(readableText("#ffffff")).toBe("#111827");
    expect(readableText("#355aa4")).toBe("#ffffff");
    expect(calendarConfig({}).autoColor).toBe(true);
    expect(calendarConfig({ autoColor: false }).autoColor).toBe(false);
  });
});
describe("quick add", () => {
  const today = DateTime.fromISO("2026-10-13"); // Tuesday
  it("reads weekday ranges and times", () => {
    expect(parseQuickAdd("Focus session Mon-Wed 9am", today)).toEqual({
      title: "Focus session", start: "2026-10-19T09:00", end: "2026-10-21T10:00".replace("10:00", "10:00"), allDay: false,
    });
  });
  it("defaults to an all-day event today", () => {
    expect(parseQuickAdd("Deadline", today)).toEqual({ title: "Deadline", start: "2026-10-13", end: "2026-10-14", allDay: true });
    expect(parseQuickAdd("Trip tomorrow", today).start).toBe("2026-10-14");
  });
  it("reads time ranges, durations and ISO dates", () => {
    expect(parseQuickAdd("Review tomorrow 2-3:30pm", today)).toMatchObject({ title: "Review", start: "2026-10-14T14:00", end: "2026-10-14T15:30" });
    expect(parseQuickAdd("Call 2026-11-02 at 14:00 for 45 min", today)).toMatchObject({ title: "Call", start: "2026-11-02T14:00", end: "2026-11-02T14:45" });
    expect(parseQuickAdd("Standup friday 9:30am for 2h", today)).toMatchObject({ start: "2026-10-16T09:30", end: "2026-10-16T11:30" });
  });
  it("leaves numbers in titles alone", () => {
    expect(parseQuickAdd("Sprint 12 kickoff", today).title).toBe("Sprint 12 kickoff");
  });
});

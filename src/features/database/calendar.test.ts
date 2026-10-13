import { describe, expect, it } from "vitest";
import { addDays, addMonths, daysBetween, daysOf, monthGrid, monthTitle, resizeSpan, shiftSpan, spanOf, todayIso, weekday } from "./calendar";

describe("day arithmetic", () => {
  it("adds and counts days across month, year and leap boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2); // across a daylight-saving change
    expect(daysBetween("2026-03-05", "2026-03-01")).toBe(-4);
  });
  it("knows weekdays (Monday first) and builds a month grid", () => {
    expect(weekday("2026-03-02")).toBe(0);
    expect(weekday("2026-03-08")).toBe(6);
    const grid = monthGrid("2026-03");
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe("2026-02-23");
    expect(grid[6]).toBe("2026-03-01");
    expect(grid[41]).toBe("2026-04-05");
    expect(monthGrid("2026-02")[0]).toBe("2026-01-26");
  });
  it("moves between months", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-03", 14)).toBe("2027-05");
    expect(monthTitle("2026-03")).toBe("March 2026");
    expect(todayIso(new Date(2026, 2, 5))).toBe("2026-03-05");
  });
});

describe("date values", () => {
  it("reads spans and the days they cover", () => {
    expect(spanOf({ start: "2026-03-10T09:00", end: "2026-03-12" })).toEqual({ start: "2026-03-10T09:00", end: "2026-03-12" });
    expect(spanOf({ start: "nope" })).toBeNull();
    expect(spanOf(null)).toBeNull();
    expect(daysOf({ start: "2026-03-10T09:00" })).toEqual({ first: "2026-03-10", last: "2026-03-10" });
    expect(daysOf({ start: "2026-03-10", end: "2026-03-12" })).toEqual({ first: "2026-03-10", last: "2026-03-12" });
  });
  it("shifts a whole record and keeps the time of day", () => {
    expect(shiftSpan({ start: "2026-03-10T14:30", end: "2026-03-11T16:00" }, 3)).toEqual({ start: "2026-03-13T14:30", end: "2026-03-14T16:00" });
    expect(shiftSpan({ start: "2026-03-31" }, 1)).toEqual({ start: "2026-04-01" });
  });
  it("resizes one edge without letting the range invert", () => {
    const span = { start: "2026-03-10", end: "2026-03-14" };
    expect(resizeSpan(span, "end", 2)).toEqual({ start: "2026-03-10", end: "2026-03-16" });
    expect(resizeSpan(span, "end", -9)).toEqual({ start: "2026-03-10", end: "2026-03-10" });
    expect(resizeSpan(span, "start", -2)).toEqual({ start: "2026-03-08", end: "2026-03-14" });
    expect(resizeSpan(span, "start", 9)).toEqual({ start: "2026-03-14", end: "2026-03-14" });
    expect(resizeSpan({ start: "2026-03-10" }, "end", 3)).toEqual({ start: "2026-03-10", end: "2026-03-13" });
    expect(resizeSpan({ start: "2026-03-10" }, "end", -3)).toEqual({ start: "2026-03-10" });
  });
});

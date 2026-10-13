import { describe, expect, it } from "vitest";
import { parseNaturalDate, type ParsedDate } from "./naturalDate";

// Wednesday, 7 October 2026.
const now = new Date(2026, 9, 7, 10, 30);
const parse = (s: string, order: "mdy" | "dmy" = "mdy"): ParsedDate | null => parseNaturalDate(s, { now, order });
const date = (s: string, order: "mdy" | "dmy" = "mdy") => parse(s, order)?.date ?? null;

describe("relative days", () => {
  it("understands today, tomorrow and yesterday", () => {
    expect(date("today")).toBe("2026-10-07");
    expect(date("Tomorrow")).toBe("2026-10-08");
    expect(date("tmrw")).toBe("2026-10-08");
    expect(date("yesterday")).toBe("2026-10-06");
    expect(date("day after tomorrow")).toBe("2026-10-09");
  });

  it("understands offsets", () => {
    expect(date("in 3 days")).toBe("2026-10-10");
    expect(date("in 2 weeks")).toBe("2026-10-21");
    expect(date("in 1 month")).toBe("2026-11-07");
    expect(date("in a week")).toBe("2026-10-14");
    expect(date("5 days from now")).toBe("2026-10-12");
    expect(date("2 days ago")).toBe("2026-10-05");
    expect(date("next week")).toBe("2026-10-14");
    expect(date("next month")).toBe("2026-11-07");
    expect(date("next year")).toBe("2027-10-07");
  });

  it("clamps month arithmetic to the end of a short month", () => {
    const jan31 = new Date(2026, 0, 31);
    expect(parseNaturalDate("in 1 month", { now: jan31 })?.date).toBe("2026-02-28");
  });
});

describe("weekdays", () => {
  it("picks the upcoming day, never today", () => {
    expect(date("friday")).toBe("2026-10-09");
    expect(date("fri")).toBe("2026-10-09");
    expect(date("wednesday")).toBe("2026-10-14");
    expect(date("monday")).toBe("2026-10-12");
    expect(date("thurs")).toBe("2026-10-08");
  });

  it("treats next as the one in next week", () => {
    expect(date("next friday")).toBe("2026-10-16");
    expect(date("next monday")).toBe("2026-10-12");
    // Sunday ends this Monday-to-Sunday week, so "next sunday" is the one after.
    expect(date("next sunday")).toBe("2026-10-18");
    expect(date("sunday")).toBe("2026-10-11");
  });

  it("finds the weekend", () => {
    expect(date("this weekend")).toBe("2026-10-10");
  });
});

describe("calendar dates", () => {
  it("reads month names in either order, with optional year", () => {
    expect(date("oct 12")).toBe("2026-10-12");
    expect(date("October 12th")).toBe("2026-10-12");
    expect(date("12 oct")).toBe("2026-10-12");
    expect(date("dec 25 2027")).toBe("2027-12-25");
    expect(date("25 december 2027")).toBe("2027-12-25");
    expect(date("sept 3")).toBe("2026-09-03");
    expect(date("march 2028")).toBe("2028-03-01");
  });

  it("reads ISO dates and numeric dates by the given order", () => {
    expect(date("2026-10-12")).toBe("2026-10-12");
    expect(date("10/12/2027", "mdy")).toBe("2027-10-12");
    expect(date("10/12/2027", "dmy")).toBe("2027-12-10");
    expect(date("10/12", "mdy")).toBe("2026-10-12");
    expect(date("12.10.27", "dmy")).toBe("2027-10-12");
  });

  it("lets an impossible month settle the order", () => {
    expect(date("25/12/2026", "mdy")).toBe("2026-12-25");
    expect(date("12/25/2026", "dmy")).toBe("2026-12-25");
  });

  it("rejects dates that do not exist", () => {
    expect(parse("feb 30")).toBeNull();
    expect(parse("2026-13-01")).toBeNull();
    expect(parse("31/04/2026", "dmy")).toBeNull();
  });
});

describe("times", () => {
  it("adds a time to a date", () => {
    expect(parse("tomorrow 3pm")).toEqual({ date: "2026-10-08", time: "15:00" });
    expect(parse("friday at 9:30 am")).toEqual({ date: "2026-10-09", time: "09:30" });
    expect(parse("oct 12 15:45")).toEqual({ date: "2026-10-12", time: "15:45" });
    expect(parse("tomorrow noon")).toEqual({ date: "2026-10-08", time: "12:00" });
    expect(parse("today at midnight")).toEqual({ date: "2026-10-07", time: "00:00" });
  });

  it("handles 12 am and 12 pm", () => {
    expect(parse("today 12am")?.time).toBe("00:00");
    expect(parse("today 12pm")?.time).toBe("12:00");
  });

  it("a bare time means today", () => {
    expect(parse("3pm")).toEqual({ date: "2026-10-07", time: "15:00" });
  });

  it("does not mistake a day number for a time", () => {
    expect(parse("oct 12")).toEqual({ date: "2026-10-12" });
  });
});

describe("what it does not understand", () => {
  it("returns null instead of guessing", () => {
    for (const s of ["", "   ", "soonish", "the 5th of never", "oct", "99", "next blursday", "hello world"]) expect(parse(s)).toBeNull();
  });
});

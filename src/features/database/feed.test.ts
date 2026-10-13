import { describe, expect, it } from "vitest";
import { dayHeading, groupByDay, timeOfDay } from "./feed";

const now = new Date(2026, 9, 7, 15, 0); // Wed 7 Oct 2026, local time
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h, 30).toISOString();

describe("feed days", () => {
  it("names recent days and dates older ones", () => {
    expect(dayHeading(at(2026, 9, 7), now)).toBe("Today");
    expect(dayHeading(at(2026, 9, 6), now)).toBe("Yesterday");
    expect(dayHeading(at(2026, 9, 4), now)).toBe("Sunday");
    expect(dayHeading(at(2026, 9, 1), now)).toBe("Thursday");
    expect(dayHeading(at(2026, 8, 30), now)).toBe("September 30");
    expect(dayHeading(at(2025, 11, 25), now)).toBe("December 25, 2025");
    expect(dayHeading("garbage", now)).toBe("Earlier");
  });

  it("groups an ordered list into runs by day", () => {
    const items = [at(2026, 9, 7, 14), at(2026, 9, 7, 8), at(2026, 9, 6, 22), at(2026, 8, 30)].map((s) => ({ s }));
    const groups = groupByDay(items, (i) => i.s, now);
    expect(groups.map((g) => [g.heading, g.items.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["September 30", 1],
    ]);
  });

  it("formats the time of day", () => {
    expect(timeOfDay(new Date(2026, 9, 7, 9, 5).toISOString())).toBe("09:05");
    expect(timeOfDay("x")).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import type { ChartData, ChartSpec, Property } from "../../types";
import { arcPath, buildModel, categoryLabel, clip, defaultChartSpec, describeChart, EMPTY_KEY, fillDates, niceScale } from "./chartModel";

const opt = (id: string, name: string, color = "violet") => ({ id, name, color: color as "violet" });
const status: Property = { id: "st", databaseId: "d", name: "Status", type: "status", position: 1, config: { options: [opt("todo", "To do", "gray"), opt("doing", "Doing", "blue"), opt("done", "Done", "green")] } };
const team: Property = { id: "tm", databaseId: "d", name: "Team", type: "select", position: 2, config: { options: [opt("n", "North"), opt("s", "South")] } };
const when: Property = { id: "dt", databaseId: "d", name: "Closed", type: "date", position: 3, config: {} };
const amount: Property = { id: "am", databaseId: "d", name: "Amount", type: "number", position: 4, config: {} };
const title: Property = { id: "ti", databaseId: "d", name: "Name", type: "title", position: 0, config: {} };
const props = [title, status, team, when, amount];

const spec = (patch: Partial<ChartSpec>): ChartSpec => ({ chartType: "bar", aggregation: "count", sort: "x", xPropertyId: "st", ...patch });
const data = (points: ChartData["points"]): ChartData => ({ points, truncated: false, records: points.reduce((n, p) => n + p.count, 0) });

describe("chart model", () => {
  it("orders option categories by the option order and puts 'no value' last", () => {
    const m = buildModel(
      spec({}),
      props,
      data([
        { x: "done", group: null, value: 3, count: 3 },
        { x: null, group: null, value: 1, count: 1 },
        { x: "todo", group: null, value: 2, count: 2 },
      ]),
    );
    expect(m.categories.map((c) => c.label)).toEqual(["To do", "Done", "No value"]);
    expect(m.values[0]).toEqual([2, 3, 1]);
    expect(m.categories[0].tone).toBe("gray");
    expect(m.totals).toEqual([2, 3, 1]);
  });

  it("splits into series, stacking only sums and counts", () => {
    const points = [
      { x: "todo", group: "n", value: 10, count: 2 },
      { x: "todo", group: "s", value: 5, count: 1 },
      { x: "done", group: "s", value: 7, count: 1 },
    ];
    const sum = buildModel(spec({ aggregation: "sum", yPropertyId: "am", groupPropertyId: "tm" }), props, data(points));
    expect(sum.series.map((s) => s.label)).toEqual(["North", "South"]);
    expect(sum.stackable).toBe(true);
    expect(sum.totals).toEqual([15, 7]);
    expect(sum.valueLabel).toBe("Sum of Amount");
    const avg = buildModel(spec({ aggregation: "average", yPropertyId: "am", groupPropertyId: "tm" }), props, data(points));
    expect(avg.stackable).toBe(false);
    expect(avg.totals).toEqual([10, 7]);
  });

  it("sorts by value, keeping 'no value' last, and caps pie slices", () => {
    const pts = [
      { x: "todo", group: null, value: 1, count: 1 },
      { x: "doing", group: null, value: 9, count: 9 },
      { x: "done", group: null, value: 4, count: 4 },
      { x: null, group: null, value: 50, count: 50 },
    ];
    const desc = buildModel(spec({ sort: "value_desc" }), props, data(pts));
    expect(desc.categories.map((c) => c.key)).toEqual(["doing", "done", "todo", EMPTY_KEY]);
    const asc = buildModel(spec({ sort: "value_asc" }), props, data(pts));
    expect(asc.categories.map((c) => c.key)).toEqual(["todo", "done", "doing", EMPTY_KEY]);
    const many = Array.from({ length: 30 }, (_, i) => ({ x: `k${i}`, group: null, value: 1, count: 1 }));
    expect(buildModel(spec({ chartType: "pie" }), props, data(many)).categories.length).toBe(12);
  });

  it("fills gaps in time and labels date buckets", () => {
    expect(fillDates(["2026-01", "2026-04"], "month")).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(fillDates(["2025-11", "2026-02"], "month")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(fillDates(["2024", "2027"], "year")).toEqual(["2024", "2025", "2026", "2027"]);
    expect(fillDates(["2026-02-27", "2026-03-02"], "day")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(fillDates(["2026-W02", "2026-W09"], "week")).toEqual(["2026-W02", "2026-W09"]);
    expect(categoryLabel(when, "2026-10", "month")).toBe("Oct 2026");
    expect(categoryLabel(when, "2026-W41", "week")).toBe("Week 41, 2026");
    expect(categoryLabel(when, EMPTY_KEY)).toBe("No date");
    expect(categoryLabel(status, "gone")).toBe("Unknown option");
    const m = buildModel(
      spec({ chartType: "line", xPropertyId: "dt", bucket: "month" }),
      props,
      data([
        { x: "2026-01", group: null, value: 2, count: 2 },
        { x: "2026-03", group: null, value: 1, count: 1 },
      ]),
    );
    expect(m.categories.map((c) => c.label)).toEqual(["Jan 2026", "Feb 2026", "Mar 2026"]);
    expect(m.values[0]).toEqual([2, 0, 1]);
  });

  it("picks a sensible default and names the chart", () => {
    expect(defaultChartSpec(props).xPropertyId).toBe("st");
    expect(defaultChartSpec([title, when]).bucket).toBe("month");
    expect(defaultChartSpec([title]).xPropertyId).toBeNull();
    expect(describeChart(spec({ aggregation: "sum", yPropertyId: "am", groupPropertyId: "tm" }), props)).toBe("Sum of Amount by Status, split by Team");
    expect(describeChart(spec({ chartType: "kpi" }), props)).toBe("Records");
  });
});

describe("chart geometry", () => {
  it("chooses round axis maxima", () => {
    expect(niceScale(0)).toEqual({ max: 1, step: 0.25 });
    expect(niceScale(7)).toEqual({ max: 8, step: 2 });
    expect(niceScale(130)).toEqual({ max: 150, step: 50 });
    expect(niceScale(8423).max).toBeGreaterThanOrEqual(8423);
  });

  it("draws closed arcs and survives a full circle", () => {
    expect(arcPath(50, 50, 40, 0, 0, Math.PI / 2)).toBe("M50 50L50 10A40 40 0 0 1 90 50Z");
    expect(arcPath(50, 50, 40, 25, 0, Math.PI)).toContain("A25 25 0 0 0");
    expect(arcPath(50, 50, 40, 0, 0, Math.PI * 2)).toContain("A40 40 0 1 1");
  });

  it("shortens long labels", () => {
    expect(clip("abc", 5)).toBe("abc");
    expect(clip("abcdefgh", 5)).toBe("abcd…");
  });
});

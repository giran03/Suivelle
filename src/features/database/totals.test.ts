import { describe, expect, it } from "vitest";
import type { Property } from "../../types";
import { aggregatesFor, formatAggregate, summarizeSelection } from "./totals";

const prop = (id: string, type: Property["type"], config: Property["config"] = {}): Property => ({ id, databaseId: "d", name: id, type, config, position: 1 });
const num = prop("n", "number");
const money = prop("m", "number", { format: { currency: "$", decimals: 2 } });

describe("aggregatesFor", () => {
  it("offers summaries by what a column holds", () => {
    expect(aggregatesFor(num)).toEqual(expect.arrayContaining(["count", "sum", "average", "median", "min", "max", "range"]));
    expect(aggregatesFor(num)).not.toContain("earliest");
    expect(aggregatesFor(prop("d", "date"))).toEqual(expect.arrayContaining(["earliest", "latest", "date_range"]));
    expect(aggregatesFor(prop("c", "checkbox"))).toContain("percent_checked");
    expect(aggregatesFor(prop("t", "text"))).toEqual(["count", "empty", "filled", "percent_filled"]);
    expect(aggregatesFor(prop("b", "button"))).toEqual([]);
  });

  it("follows the result type of formulas and rollups", () => {
    expect(aggregatesFor(prop("f", "formula", { resultType: "number" }))).toContain("sum");
    expect(aggregatesFor(prop("f", "formula", { resultType: "bool" }))).toContain("percent_checked");
    expect(aggregatesFor(prop("f", "formula", { resultType: "text" }))).not.toContain("sum");
    expect(aggregatesFor(prop("r", "rollup", { function: "latest" }))).toContain("date_range");
    expect(aggregatesFor(prop("r", "rollup", { function: "sum" }))).toContain("average");
  });
});

describe("formatAggregate", () => {
  it("formats counts, percentages, dates and numbers", () => {
    expect(formatAggregate("count", 1200, num)).toBe((1200).toLocaleString(undefined, { maximumFractionDigits: 0 }));
    expect(formatAggregate("percent_checked", 0.5, prop("c", "checkbox"))).toBe("50%");
    expect(formatAggregate("percent_filled", 0.3333, num)).toBe("33.3%");
    expect(formatAggregate("earliest", "2026-01-05", prop("d", "date"))).toBe("Jan 5, 2026");
    expect(formatAggregate("date_range", 10, prop("d", "date"))).toBe("10 days");
    expect(formatAggregate("date_range", 1, prop("d", "date"))).toBe("1 day");
    expect(formatAggregate("sum", 1234.5, money)).toBe("$1234.50");
    expect(formatAggregate("sum", null, num)).toBe("");
  });

  it("rounds an average to two places unless the format sets decimals", () => {
    expect(formatAggregate("average", 10 / 3, num)).toBe((3.33).toLocaleString(undefined, { maximumFractionDigits: 10 }));
    expect(formatAggregate("average", 10 / 3, prop("m", "number", { format: { decimals: 3 } }))).toBe("3.333");
  });
});

describe("summarizeSelection", () => {
  it("counts filled cells and sums only numbers", () => {
    const s = summarizeSelection([
      { prop: num, value: 2 },
      { prop: num, value: 4 },
      { prop: num, value: null },
      { prop: prop("t", "text"), value: "hello" },
      { prop: prop("t", "text"), value: "" },
      { prop: prop("c", "checkbox"), value: false },
      { prop: prop("c", "checkbox"), value: true },
    ]);
    expect(s).toMatchObject({ count: 4, numbers: 2, sum: 6, average: 3 });
  });

  it("has no sum or average when no cell is a number", () => {
    const s = summarizeSelection([{ prop: prop("t", "text"), value: "7" }]);
    expect(s).toMatchObject({ count: 1, numbers: 0, sum: 0, average: null });
  });

  it("carries the number format only when every number shares a property", () => {
    expect(summarizeSelection([{ prop: money, value: 1 }, { prop: money, value: 2 }]).format).toEqual({ currency: "$", decimals: 2 });
    expect(summarizeSelection([{ prop: money, value: 1 }, { prop: num, value: 2 }]).format).toBeUndefined();
  });

  it("ignores NaN and infinite values", () => {
    expect(summarizeSelection([{ prop: num, value: Number.POSITIVE_INFINITY }, { prop: num, value: 1 }]).numbers).toBe(1);
  });
});

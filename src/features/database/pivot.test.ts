import { describe, expect, it } from "vitest";
import type { PivotData, PivotSpec, Property } from "../../types";
import { ALL_KEY, buildPivotModel, defaultPivotSpec, formatPivotValue, orderAxisKeys, updatePivotSpec, valueLabel } from "./pivot";

const opt = (id: string, name: string, color = "violet") => ({ id, name, color: color as "violet" });
const title: Property = { id: "ti", databaseId: "d", name: "Name", type: "title", position: 0, config: {} };
const status: Property = { id: "st", databaseId: "d", name: "Status", type: "status", position: 1, config: { options: [opt("todo", "To do", "gray"), opt("done", "Done", "green")] } };
const team: Property = { id: "tm", databaseId: "d", name: "Team", type: "select", position: 2, config: { options: [opt("n", "North"), opt("s", "South")] } };
const when: Property = { id: "dt", databaseId: "d", name: "Closed", type: "date", position: 3, config: {} };
const amount: Property = { id: "am", databaseId: "d", name: "Amount", type: "number", position: 4, config: { format: { decimals: 1, currency: "$" } } };
const props = [title, status, team, when, amount];

const spec = (patch: Partial<PivotSpec> = {}): PivotSpec => ({ rowPropertyId: "st", columnPropertyId: "tm", aggregation: "count", showTotals: true, ...patch });
const pt = (x: string | null, group: string | null, value: number | null, count: number) => ({ x, group, value, count });
const data: PivotData = {
  cells: [pt("done", "s", 3, 3), pt("todo", "n", 1, 1), pt(null, null, null, 1), pt("done", "n", 2, 2)],
  rowTotals: [pt("done", null, 5, 5), pt("todo", null, 1, 1), pt(null, null, null, 1)],
  columnTotals: [pt("n", null, 3, 3), pt("s", null, 3, 3), pt(null, null, null, 1)],
  grand: pt(null, null, 7, 7),
  truncated: false,
  records: 7,
};

describe("pivot model", () => {
  it("orders rows and columns by option order with no value last", () => {
    const m = buildPivotModel(spec(), props, data);
    expect(m.rows.map((r) => r.label)).toEqual(["To do", "Done", "No value"]);
    expect(m.columns.map((c) => c.label)).toEqual(["North", "South", "No value"]);
    expect(m.rows[0].tone).toBe("gray");
    expect(m.values).toEqual([
      [1, null, null],
      [2, 3, null],
      [null, null, 1],
    ]);
    expect(m.rowTotals).toEqual([1, 5, 1]);
    expect(m.columnTotals).toEqual([3, 3, 1]);
    expect(m.grand).toBe(7);
    expect(m.empty).toBe(false);
  });

  it("uses the calculation, not the count, for sums and keeps empty calculations empty", () => {
    const sums: PivotData = { ...data, cells: [pt("done", "n", 250, 2), pt("todo", "n", null, 1)], rowTotals: [pt("done", null, 250, 2), pt("todo", null, null, 1)], columnTotals: [pt("n", null, 250, 3)], grand: pt(null, null, 250, 3) };
    const m = buildPivotModel(spec({ aggregation: "sum", valuePropertyId: "am" }), props, sums);
    expect(m.values).toEqual([[null], [250]]);
    expect(m.rowTotals).toEqual([null, 250]);
    expect(m.grand).toBe(250);
  });

  it("shows one column of row totals when there is no column property", () => {
    const m = buildPivotModel(spec({ columnPropertyId: null }), props, { ...data, cells: [], columnTotals: [] });
    expect(m.columns).toEqual([{ key: ALL_KEY, label: "Records" }]);
    expect(m.values).toEqual([[1], [5], [1]]);
    expect(m.columnTotals).toEqual([7]);
  });

  it("buckets date columns in time order", () => {
    const d: PivotData = { ...data, cells: [pt("done", "2026-02", 1, 1), pt("done", "2026-01", 1, 1)], columnTotals: [pt("2026-02", null, 1, 1), pt("2026-01", null, 1, 1)] };
    const m = buildPivotModel(spec({ columnPropertyId: "dt", columnBucket: "month" }), props, d);
    expect(m.columns.map((c) => c.label)).toEqual(["Jan 2026", "Feb 2026"]);
  });

  it("reports an empty pivot", () => {
    const empty: PivotData = { cells: [], rowTotals: [], columnTotals: [], grand: pt(null, null, 0, 0), truncated: false, records: 0 };
    expect(buildPivotModel(spec(), props, empty).empty).toBe(true);
  });
});

describe("pivot helpers", () => {
  it("orders checkbox keys false before true", () => {
    const check: Property = { id: "ck", databaseId: "d", name: "Done", type: "checkbox", position: 5, config: {} };
    expect(orderAxisKeys(check, ["true", "false"])).toEqual(["false", "true"]);
  });

  it("starts with status rows and a select column, and counts", () => {
    expect(defaultPivotSpec(props)).toMatchObject({ rowPropertyId: "st", columnPropertyId: "tm", aggregation: "count", showTotals: true });
  });

  it("keeps the spec valid when one thing changes", () => {
    let s = updatePivotSpec(spec(), props, { aggregation: "sum" });
    expect(s.valuePropertyId).toBe("am");
    s = updatePivotSpec(s, props, { aggregation: "count" });
    expect(s.valuePropertyId).toBeNull();
    s = updatePivotSpec(spec(), props, { columnPropertyId: "st" });
    expect(s.columnPropertyId).toBeNull();
    s = updatePivotSpec(spec(), props, { rowPropertyId: "dt" });
    expect(s.rowBucket).toBe("month");
    // No number property: a sum falls back to counting.
    expect(updatePivotSpec(spec(), [title, status], { aggregation: "sum" }).aggregation).toBe("count");
  });

  it("labels and formats values", () => {
    expect(valueLabel(spec({ aggregation: "average", valuePropertyId: "am" }), props)).toBe("Average of Amount");
    expect(formatPivotValue(spec({ aggregation: "sum", valuePropertyId: "am" }), props, 1234.5)).toBe("$1234.5");
    expect(formatPivotValue(spec(), props, null)).toBe("");
  });
});

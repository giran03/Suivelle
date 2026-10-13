import { describe, expect, it } from "vitest";
import type { GroupCount, Property } from "../../types";
import { buildLayout, collapseKey, EMPTY_GROUP, groupLabel, locate, valueForGroup } from "./groups";

const g = (key: string, count: number, subgroups: GroupCount[] = []): GroupCount => ({ key, count, subgroups });
const status: Property = {
  id: "s", databaseId: "d", name: "Status", type: "status", position: 0,
  config: { options: [{ id: "o1", name: "Todo", color: "gray" }, { id: "o2", name: "Done", color: "green" }] },
};

describe("buildLayout", () => {
  it("lays out a header then the records of each group", () => {
    const layout = buildLayout([g("a", 2), g("b", 0), g("c", 3)], new Set());
    expect(layout.size).toBe(3 + 2 + 3); // three headers, five records
    expect(layout.records).toBe(5);
    expect(layout.segments.map((s) => `${s.kind}:${s.start}`)).toEqual(["header:0", "rows:1", "header:3", "header:4", "rows:5"]);
  });

  it("collapsed groups keep only their header", () => {
    const layout = buildLayout([g("a", 2), g("c", 3)], new Set([collapseKey("a")]));
    expect(layout.size).toBe(1 + 1 + 3);
    expect(layout.records).toBe(3);
  });

  it("nests subgroups, skipping empty ones, and collapses them independently", () => {
    const groups = [g("a", 3, [g("x", 2), g("y", 0), g("z", 1)])];
    const open = buildLayout(groups, new Set());
    expect(open.size).toBe(1 + (1 + 2) + (1 + 1));
    const closed = buildLayout(groups, new Set([collapseKey("a", "x")]));
    expect(closed.size).toBe(1 + 1 + (1 + 1));
    expect(closed.segments.filter((s) => s.kind === "header" && s.level === 1).map((s) => (s as { key: string }).key)).toEqual(["x", "z"]);
  });

  it("handles no groups", () => {
    expect(buildLayout([], new Set())).toEqual({ segments: [], size: 0, records: 0 });
  });
});

describe("locate", () => {
  const layout = buildLayout([g("a", 2), g("b", 3)], new Set());
  it("finds the segment and offset for any index", () => {
    expect(locate(layout, 0)).toMatchObject({ segment: { kind: "header", key: "a" }, offset: 0 });
    expect(locate(layout, 1)).toMatchObject({ segment: { kind: "rows", groupKey: "a" }, offset: 0 });
    expect(locate(layout, 2)).toMatchObject({ segment: { kind: "rows", groupKey: "a" }, offset: 1 });
    expect(locate(layout, 3)).toMatchObject({ segment: { kind: "header", key: "b" } });
    expect(locate(layout, 6)).toMatchObject({ segment: { kind: "rows", groupKey: "b" }, offset: 2 });
    expect(locate(layout, 7)).toBeNull();
    expect(locate(layout, -1)).toBeNull();
  });
});

describe("labels and drop values", () => {
  it("labels options, checkboxes, dates and the empty group", () => {
    expect(groupLabel(status, "o2")).toBe("Done");
    expect(groupLabel(status, "gone")).toBe("Unknown option");
    expect(groupLabel(status, EMPTY_GROUP)).toBe("No Status");
    expect(groupLabel({ ...status, type: "checkbox" }, "true")).toBe("Checked");
    expect(groupLabel({ ...status, type: "date" }, "2026-10", "month")).toBe("October 2026");
    expect(groupLabel({ ...status, type: "date" }, "2026", "year")).toBe("2026");
    expect(groupLabel({ ...status, type: "date" }, "2026-W41", "week")).toBe("2026 week 41");
    expect(groupLabel({ ...status, type: "date" }, "2026-10-07", "day")).toBe("Oct 7, 2026");
  });

  it("only option and checkbox groups can be set by dropping", () => {
    expect(valueForGroup(status, "o1")).toEqual({ value: "o1" });
    expect(valueForGroup(status, EMPTY_GROUP)).toEqual({ value: null });
    expect(valueForGroup({ ...status, type: "checkbox" }, "true")).toEqual({ value: true });
    expect(valueForGroup({ ...status, type: "date" }, "2026-10")).toBeUndefined();
    expect(valueForGroup(undefined, "x")).toBeUndefined();
  });
});

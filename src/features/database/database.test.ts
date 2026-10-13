import { describe, expect, it } from "vitest";
import type { FilterGroup, Property, PropertyType } from "../../types";
import { addTo, compact, countConditions, depthOf, newCondition, removeAt, rootOf, updateAt } from "./filter";
import { cursorFor, isTypingKey, missingPages, moveCell } from "./gridNav";
import { cellText, defaultFilterValue, formatDateValue, formatNumber, formatWhen, isCompleteCondition, formatFormulaValue, isFilterable, isSortable, operatorNeedsValue, operatorsFor, ROLLUP_FUNCTIONS, uniqueIdLabel, valueType } from "./model";

const prop = (id: string, type: PropertyType, config: Property["config"] = {}): Property => ({ id, databaseId: "d", name: id, type, config, position: 0 });
const select = prop("pri", "select", { options: [{ id: "o1", name: "Low", color: "gray" }, { id: "o2", name: "High", color: "red" }] });
const props = new Map([prop("pts", "number"), prop("txt", "text"), select, prop("due", "date"), prop("done", "checkbox")].map((p) => [p.id, p]));

describe("conditions", () => {
  it("knows which operators need a value and offers type-appropriate ones", () => {
    expect(operatorNeedsValue("text", "is_empty")).toBe(false);
    expect(operatorNeedsValue("text", "contains")).toBe(true);
    expect(operatorsFor("multi_select").map((o) => o.value)).toEqual(["contains", "not_contains", "is_empty", "is_not_empty"]);
    expect(operatorsFor("created_time").some((o) => o.value === "is_empty")).toBe(false);
  });

  it("starts each type with a sensible value", () => {
    expect(defaultFilterValue(select, "=")).toBe("o1");
    expect(defaultFilterValue(prop("due", "date"), "before")).toEqual({ relativeDays: 0 });
    expect(defaultFilterValue(prop("due", "date"), "between")).toEqual([{ relativeDays: -7 }, { relativeDays: 0 }]);
    expect(defaultFilterValue(prop("t", "text"), "is_empty")).toBeUndefined();
  });

  it("only treats finished conditions as saveable", () => {
    expect(isCompleteCondition(props.get("pts"), ">", null)).toBe(false);
    expect(isCompleteCondition(props.get("pts"), ">", 3)).toBe(true);
    expect(isCompleteCondition(props.get("txt"), "contains", "  ")).toBe(false);
    expect(isCompleteCondition(props.get("txt"), "is_empty", undefined)).toBe(true);
    expect(isCompleteCondition(props.get("due"), "between", [{ relativeDays: 0 }])).toBe(false);
    expect(isCompleteCondition(props.get("due"), "=", "2026-10-07")).toBe(true);
    expect(isCompleteCondition(props.get("done"), "=", false)).toBe(true);
    expect(isCompleteCondition(undefined, "=", "x")).toBe(false);
  });
});

describe("filter tree editing", () => {
  const leaf = (propertyId: string, operator: string, value: unknown) => ({ propertyId, operator, value });

  it("wraps a saved single condition and starts empty", () => {
    expect(rootOf(null)).toEqual({ op: "and", children: [] });
    expect(rootOf(leaf("pts", ">", 1))).toEqual({ op: "and", children: [leaf("pts", ">", 1)] });
    const g: FilterGroup = { op: "or", children: [] };
    expect(rootOf(g)).toBe(g);
  });

  it("adds, updates and removes conditions immutably, including inside one group", () => {
    let root = rootOf(null);
    root = addTo(root, [], newCondition(props.get("pts")!));
    root = addTo(root, [], { op: "or", children: [] });
    root = addTo(root, [1], newCondition(props.get("txt")!));
    expect(depthOf(root)).toBe(2);
    expect(countConditions(root)).toBe(2);
    const before = JSON.stringify(root);
    const updated = updateAt(root, [1, 0], (n) => ({ ...n, operator: "=", value: "x" }));
    expect(JSON.stringify(root)).toBe(before);
    expect((updated.children[1] as FilterGroup).children[0]).toMatchObject({ operator: "=", value: "x" });
    const removed = removeAt(updated, [0]);
    expect(removed.children).toHaveLength(1);
    expect(updateAt(root, [], (n) => ({ ...n, op: "or" })).op).toBe("or");
  });

  it("compacts to what can be saved", () => {
    const draft: FilterGroup = {
      op: "and",
      children: [
        leaf("pts", ">", 5),
        leaf("pts", ">", null), // incomplete
        { op: "or", children: [leaf("txt", "contains", ""), leaf("done", "=", true)] },
        { op: "or", children: [leaf("txt", "is_empty", undefined)] },
        { op: "and", children: [leaf("gone", "=", "x")] }, // unknown property
      ],
    };
    expect(compact(draft, props)).toEqual({
      op: "and",
      children: [leaf("pts", ">", 5), { op: "or", children: [leaf("done", "=", true)] }, { op: "or", children: [{ propertyId: "txt", operator: "is_empty" }] }],
    });
    expect(compact({ op: "and", children: [leaf("pts", ">", null)] }, props)).toBeNull();
    expect(countConditions(null)).toBe(0);
  });
});

describe("grid navigation", () => {
  const b = { rows: 5, cols: 3 };

  it("moves within bounds", () => {
    expect(moveCell({ row: 0, col: 0 }, "ArrowUp", b)).toEqual({ row: 0, col: 0 });
    expect(moveCell({ row: 4, col: 2 }, "ArrowDown", b)).toEqual({ row: 4, col: 2 });
    expect(moveCell({ row: 1, col: 1 }, "ArrowRight", b)).toEqual({ row: 1, col: 2 });
    expect(moveCell({ row: 1, col: 1 }, "ArrowLeft", b)).toEqual({ row: 1, col: 0 });
    expect(moveCell({ row: 1, col: 1 }, "Home", b)).toEqual({ row: 1, col: 0 });
    expect(moveCell({ row: 1, col: 1 }, "End", b, { ctrl: true })).toEqual({ row: 4, col: 2 });
    expect(moveCell({ row: 3, col: 1 }, "PageUp", b)).toEqual({ row: 0, col: 1 });
    expect(moveCell({ row: 0, col: 1 }, "x", b)).toBeNull();
  });

  it("wraps Tab across rows and stops at the ends", () => {
    expect(moveCell({ row: 1, col: 2 }, "Tab", b)).toEqual({ row: 2, col: 0 });
    expect(moveCell({ row: 1, col: 0 }, "Tab", b, { shift: true })).toEqual({ row: 0, col: 2 });
    expect(moveCell({ row: 4, col: 2 }, "Tab", b)).toEqual({ row: 4, col: 0 });
    expect(moveCell({ row: 0, col: 0 }, "Tab", b, { shift: true })).toEqual({ row: 0, col: 2 });
    expect(moveCell({ row: 0, col: 0 }, "ArrowDown", { rows: 0, cols: 0 })).toEqual({ row: 0, col: 0 });
  });

  it("recognises typing keys and plans page fetches", () => {
    expect(isTypingKey({ key: "a" })).toBe(true);
    expect(isTypingKey({ key: "a", ctrlKey: true })).toBe(false);
    expect(isTypingKey({ key: "Enter" })).toBe(false);
    const have = new Set([0]);
    expect(missingPages(0, 250, 100, 1000, have)).toEqual([1, 2]);
    expect(missingPages(990, 5000, 100, 1000, new Set())).toEqual([9]);
    expect(missingPages(0, 10, 100, 0, have)).toEqual([]);
    expect(cursorFor(0, 100)).toBeNull();
    expect(cursorFor(3, 100)).toBe("o:300");
  });
});

describe("formatting", () => {
  it("formats dates without time-zone shifts", () => {
    expect(formatWhen("2026-10-07")).toBe("Oct 7, 2026");
    expect(formatWhen("2026-10-07T09:30")).toBe("Oct 7, 2026 09:30");
    expect(formatDateValue({ start: "2026-10-07", end: "2026-10-09" })).toBe("Oct 7, 2026 → Oct 9, 2026");
    expect(formatDateValue(null)).toBe("");
  });

  it("formats numbers, ids and cell text", () => {
    expect(formatNumber(1234.5)).toBe((1234.5).toLocaleString(undefined, { maximumFractionDigits: 10 }));
    expect(formatNumber("x")).toBe("");
    expect(uniqueIdLabel(prop("id", "unique_id", { prefix: "TASK" }), 7)).toBe("TASK-7");
    expect(uniqueIdLabel(prop("id", "unique_id"), 7)).toBe("7");
    const row = { title: "T", uniqueId: 1, createdAt: "", updatedAt: "", values: { pri: "o2", gone: ["zzz"] } };
    expect(cellText(select, row)).toBe("High");
    expect(cellText(prop("m", "multi_select"), { ...row, values: { m: ["zzz"] } })).toBe("Unknown option");
    expect(cellText(prop("t", "title"), row)).toBe("T");
  });
});

describe("relations and rollups", () => {
  const row = { title: "T", uniqueId: 1, createdAt: "", updatedAt: "", values: {} as Record<string, unknown> };
  it("shows linked titles and rollup results", () => {
    const rel = prop("rel", "relation", { targetDatabaseId: "d2", reverseId: null });
    const links = [{ id: "a", pageId: "pa", title: "Alpha" }, { id: "b", pageId: "pb", title: "" }];
    expect(cellText(rel, { ...row, values: { rel: links } })).toBe("Alpha, Untitled");
    expect(cellText(rel, row)).toBe("");
    const pct = prop("pct", "rollup", { function: "percent_checked" });
    expect(cellText(pct, { ...row, values: { pct: 33.333 } })).toBe("33%");
    expect(cellText(prop("first", "rollup", { function: "earliest" }), { ...row, values: { first: "2026-02-01" } })).toBe("Feb 1, 2026");
    expect(cellText(prop("n", "rollup", { function: "count" }), { ...row, values: { n: 3 } })).toBe("3");
  });
  it("limits relation filters to emptiness and keeps rollups out of filters and sorts", () => {
    expect(operatorsFor("relation").map((o) => o.value)).toEqual(["is_empty", "is_not_empty"]);
    expect(isFilterable(prop("r", "rollup", { function: "sum" }))).toBe(true);
    expect(isFilterable(prop("r", "relation"))).toBe(true);
    expect(ROLLUP_FUNCTIONS.filter((f) => f.accepts("checkbox")).map((f) => f.value)).toEqual(["count", "count_unique", "percent_checked"]);
    expect(ROLLUP_FUNCTIONS.filter((f) => f.accepts("date")).map((f) => f.value)).toEqual(["count", "count_unique", "earliest", "latest"]);
  });
});

describe("formulas", () => {
  const row = { title: "T", uniqueId: 1, createdAt: "", updatedAt: "", values: {} as Record<string, unknown> };
  it("formats every result shape", () => {
    expect(formatFormulaValue(10)).toBe("10");
    expect(formatFormulaValue("hi")).toBe("hi");
    expect(formatFormulaValue(true)).toBe("true");
    expect(formatFormulaValue({ start: "2026-03-15" })).toBe("Mar 15, 2026");
    expect(formatFormulaValue({ error: "#TYPE" })).toBe("#TYPE");
    expect(formatFormulaValue(["a", "b"])).toBe("a, b");
    expect(formatFormulaValue(null)).toBe("");
    expect(cellText(prop("f", "formula", { resultType: "number" }), { ...row, values: { f: 4.5 } })).toBe("4.5");
  });
  it("filters and sorts by the type of the result", () => {
    const f = (resultType: NonNullable<Property["config"]["resultType"]>) => prop("f", "formula", { resultType });
    expect(valueType(f("number"))).toBe("number");
    expect(valueType(f("bool"))).toBe("checkbox");
    expect(valueType(f("date"))).toBe("date");
    expect(valueType(f("list"))).toBe("relation");
    expect(operatorsFor(valueType(f("text"))).some((o) => o.value === "contains")).toBe(true);
    expect(isSortable(f("number"))).toBe(true);
    expect(isSortable(f("list"))).toBe(false);
    expect(valueType(prop("r", "rollup", { function: "earliest" }))).toBe("date");
    expect(valueType(prop("r", "rollup", { function: "sum" }))).toBe("number");
    expect(isFilterable(prop("r", "rollup", { function: "sum" }))).toBe(true);
    expect(defaultFilterValue(f("number"), ">")).toBeNull();
    expect(isCompleteCondition(f("number"), ">", 3)).toBe(true);
  });
});

describe("project progress", () => {
  it("offers percent done for status properties and formats it as a percentage", () => {
    expect(ROLLUP_FUNCTIONS.filter((f) => f.accepts("status")).map((f) => f.value)).toEqual(["count", "count_unique", "percent_done"]);
    const p = prop("p", "rollup", { function: "percent_done" });
    expect(cellText(p, { title: "", uniqueId: 1, createdAt: "", updatedAt: "", values: { p: 66.6 } })).toBe("67%");
    expect(valueType(p)).toBe("number");
  });
});

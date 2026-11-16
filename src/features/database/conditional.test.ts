import { describe, expect, it } from "vitest";
import type { FilterNode, FormatRule, Property, RecordRow } from "../../types";
import { evaluateRules, matchesFilter, ruleColumn } from "./conditional";

const prop = (id: string, type: Property["type"], config: Property["config"] = {}): Property => ({ id, databaseId: "d", name: id, type, config, position: 1 });
const props = new Map(
  [prop("title", "title"), prop("pts", "number"), prop("pri", "select"), prop("tags", "multi_select"), prop("due", "date"), prop("done", "checkbox"), prop("notes", "text"), prop("rel", "relation"), prop("made", "created_time")].map((p) => [p.id, p]),
);
const TODAY = new Date(2026, 5, 15); // 15 June 2026, local
const row = (values: Record<string, unknown>, extra: Partial<RecordRow> = {}): RecordRow => ({ id: "r", pageId: "p", databaseId: "d", title: "Alpha", uniqueId: 1, createdAt: "2026-06-01T10:00:00Z", updatedAt: "", values, ...extra });
const leaf = (propertyId: string, operator: string, value?: unknown): FilterNode => ({ propertyId, operator, value });
const test = (f: FilterNode, r: RecordRow) => matchesFilter(f, r, props, TODAY);

describe("matchesFilter", () => {
  it("compares numbers, treating a missing value as not matching an inequality", () => {
    expect(test(leaf("pts", ">", 5), row({ pts: 6 }))).toBe(true);
    expect(test(leaf("pts", ">", 5), row({ pts: 5 }))).toBe(false);
    expect(test(leaf("pts", ">=", 5), row({ pts: 5 }))).toBe(true);
    expect(test(leaf("pts", ">", 5), row({}))).toBe(false);
    expect(test(leaf("pts", "!=", 5), row({}))).toBe(true);
    expect(test(leaf("pts", "is_empty"), row({}))).toBe(true);
    expect(test(leaf("pts", "is_not_empty"), row({ pts: 0 }))).toBe(true);
  });

  it("matches text without regard to case, and the title", () => {
    expect(test(leaf("notes", "contains", "URGENT"), row({ notes: "very urgent" }))).toBe(true);
    expect(test(leaf("notes", "not_contains", "x"), row({}))).toBe(true);
    expect(test(leaf("notes", "=", "Hello"), row({ notes: "hello" }))).toBe(true);
    expect(test(leaf("title", "contains", "alp"), row({}))).toBe(true);
    expect(test(leaf("notes", "is_empty"), row({ notes: "" }))).toBe(true);
  });

  it("matches options, multi-selects, checkboxes and relations", () => {
    expect(test(leaf("pri", "=", "a"), row({ pri: "a" }))).toBe(true);
    expect(test(leaf("pri", "!=", "a"), row({}))).toBe(true);
    expect(test(leaf("tags", "contains", "x"), row({ tags: ["x", "y"] }))).toBe(true);
    expect(test(leaf("tags", "not_contains", "x"), row({ tags: ["y"] }))).toBe(true);
    expect(test(leaf("tags", "is_empty"), row({ tags: [] }))).toBe(true);
    expect(test(leaf("done", "=", true), row({ done: true }))).toBe(true);
    expect(test(leaf("done", "=", false), row({}))).toBe(true);
    expect(test(leaf("rel", "contains", "r2"), row({ rel: [{ id: "r2", title: "B" }] }))).toBe(true);
    expect(test(leaf("rel", "is_empty"), row({ rel: [] }))).toBe(true);
  });

  it("compares whole days, with relative days counted from today", () => {
    const due = (start: string) => row({ due: { start } });
    expect(test(leaf("due", "before", { relativeDays: 0 }), due("2026-06-14"))).toBe(true);
    expect(test(leaf("due", "before", { relativeDays: 0 }), due("2026-06-15"))).toBe(false);
    expect(test(leaf("due", "=", { relativeDays: 0 }), due("2026-06-15T09:30"))).toBe(true);
    expect(test(leaf("due", "after", "2026-06-01"), due("2026-06-02"))).toBe(true);
    expect(test(leaf("due", "between", [{ relativeDays: -7 }, { relativeDays: 0 }]), due("2026-06-10"))).toBe(true);
    expect(test(leaf("due", "between", [{ relativeDays: -7 }, { relativeDays: 0 }]), due("2026-06-16"))).toBe(false);
    expect(test(leaf("due", "before", "2026-06-01"), row({}))).toBe(false);
    expect(test(leaf("made", "=", "2026-06-01"), row({}))).toBe(true);
  });

  it("combines groups with and/or, and ignores unknown properties and operators", () => {
    const f: FilterNode = { op: "or", children: [leaf("pts", ">", 100), { op: "and", children: [leaf("done", "=", true), leaf("pri", "=", "a")] }] };
    expect(test(f, row({ done: true, pri: "a" }))).toBe(true);
    expect(test(f, row({ done: true }))).toBe(false);
    expect(test({ op: "and", children: [] }, row({}))).toBe(true);
    expect(test(leaf("gone", "=", 1), row({}))).toBe(false);
    expect(test(leaf("pts", "weird", 1), row({ pts: 1 }))).toBe(false);
  });
});

describe("evaluateRules", () => {
  const rule = (id: string, target: FormatRule["target"], filter: FilterNode, color: FormatRule["color"], propertyId?: string): FormatRule => ({ id, target, filter, color, propertyId });

  it("returns null when no rules match", () => {
    expect(evaluateRules([], row({}), props)).toBeNull();
    expect(evaluateRules([rule("1", "row", leaf("pts", ">", 5), "red")], row({ pts: 1 }), props, TODAY)).toBeNull();
  });

  it("colours the row and the named or tested cell, the first matching rule winning", () => {
    const rules = [
      rule("1", "row", leaf("done", "=", true), "green"),
      rule("2", "row", leaf("pts", ">", 5), "red"),
      rule("3", "cell", leaf("pts", ">", 5), "orange"),
      rule("4", "cell", leaf("pts", ">", 0), "blue"),
      rule("5", "cell", leaf("pts", ">", 0), "violet", "notes"),
    ];
    const tones = evaluateRules(rules, row({ pts: 9, done: true }), props, TODAY);
    expect(tones?.row).toBe("green");
    expect(tones?.cells.get("pts")).toBe("orange");
    expect(tones?.cells.get("notes")).toBe("violet");
    expect(evaluateRules(rules, row({ pts: 9 }), props, TODAY)?.row).toBe("red");
  });

  it("finds the column of a cell rule inside nested conditions", () => {
    expect(ruleColumn(rule("1", "cell", { op: "and", children: [{ op: "or", children: [leaf("due", "=", "2026-01-01")] }] }, "red"))).toBe("due");
    expect(ruleColumn(rule("1", "cell", leaf("pts", ">", 1), "red", "notes"))).toBe("notes");
    expect(ruleColumn(rule("1", "cell", { op: "and", children: [] }, "red"))).toBeNull();
  });
});

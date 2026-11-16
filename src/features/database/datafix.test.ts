import { describe, expect, it } from "vitest";
import type { Property, RecordRow, ViewColumn } from "../../types";
import { frozenCount, moveBeside, stickyOffsets, toggleWrap } from "./columnOps";
import { planReplace, replaceInText, writes } from "./findReplace";
import { andCondition, quickCondition } from "./quickFilter";
import { searchFilter, splitMatches } from "./search";
import { checkCell, cleanRules, describeRules } from "./validation";

const prop = (type: Property["type"], config: Property["config"] = {}, id: string = type): Property =>
  ({ id, databaseId: "d", name: id, type, config, position: 0 }) as unknown as Property;
const row = (title: string, values: Record<string, unknown> = {}, id = title): RecordRow =>
  ({ id, pageId: `p-${id}`, databaseId: "d", title, uniqueId: 7, createdAt: "", updatedAt: "", values }) as RecordRow;

describe("search", () => {
  it("builds the any-text condition and ignores blanks", () => {
    expect(searchFilter("  plumb ")).toEqual({ propertyId: "*", operator: "search", value: "plumb" });
    expect(searchFilter("   ")).toBeNull();
  });
  it("splits text around case-insensitive matches", () => {
    expect(splitMatches("Call the Plumber, plumb", "PLUMB")).toEqual([
      { text: "Call the ", hit: false },
      { text: "Plumb", hit: true },
      { text: "er, ", hit: false },
      { text: "plumb", hit: true },
    ]);
    expect(splitMatches("abc", "")).toEqual([{ text: "abc", hit: false }]);
    expect(splitMatches("abc", "z")).toEqual([{ text: "abc", hit: false }]);
  });
});

describe("data checks", () => {
  const age = prop("number", { validation: { required: true, min: 0, max: 120 } });
  it("marks required, range and length problems", () => {
    expect(checkCell(age, row("a"))).toBe("This value is required");
    expect(checkCell(age, row("a", { number: 50 }))).toBeNull();
    expect(checkCell(age, row("a", { number: -1 }))).toBe("Must be at least 0");
    expect(checkCell(age, row("a", { number: 400 }))).toBe("Must be at most 120");
    const text = prop("text", { validation: { min: 3, max: 5 } });
    expect(checkCell(text, row("a"))).toBeNull();
    expect(checkCell(text, row("a", { text: "ab" }))).toBe("Must be at least 3 characters");
    expect(checkCell(text, row("a", { text: "abcdef" }))).toBe("Must be at most 5 characters");
  });
  it("checks email and web address formats on text", () => {
    const mail = prop("text", { validation: { format: "email" } });
    expect(checkCell(mail, row("a", { text: "me@site.io" }))).toBeNull();
    expect(checkCell(mail, row("a", { text: "me@site" }))).toBe("Not a valid email address");
    const url = prop("text", { validation: { format: "url" } });
    expect(checkCell(url, row("a", { text: "https://site.io/x" }))).toBeNull();
    expect(checkCell(url, row("a", { text: "site.io" }))).toBe("Not a valid web address");
  });
  it("flags duplicates only when asked to be unique", () => {
    const unique = prop("text", { validation: { unique: true } });
    expect(checkCell(unique, row("a", { text: "x" }), true)).toBe("Another record has the same value");
    expect(checkCell(unique, row("a", { text: "x" }), false)).toBeNull();
    expect(checkCell(prop("text"), row("a", { text: "x" }), true)).toBeNull();
  });
  it("treats an empty title and an unchecked box as missing", () => {
    expect(checkCell(prop("title", { validation: { required: true } }), row(""))).toBe("This value is required");
    expect(checkCell(prop("checkbox", { validation: { required: true } }), row("a", { checkbox: false }))).toBe("This value is required");
    expect(checkCell(prop("checkbox", { validation: { required: true } }), row("a", { checkbox: true }))).toBeNull();
  });
  it("cleans and describes rules", () => {
    expect(cleanRules({ required: false, min: Number.NaN })).toBeUndefined();
    expect(cleanRules({ required: true, max: 3 })).toEqual({ required: true, max: 3 });
    expect(describeRules({ required: true, unique: true, format: "email" })).toBe("required, unique, email address");
  });
});

describe("quick filters", () => {
  it("matches or excludes a text value, or its emptiness", () => {
    const t = prop("text");
    expect(quickCondition(t, row("a", { text: "hi" }), false)).toEqual({ propertyId: "text", operator: "=", value: "hi" });
    expect(quickCondition(t, row("a", { text: "hi" }), true)).toEqual({ propertyId: "text", operator: "!=", value: "hi" });
    expect(quickCondition(t, row("a"), false)).toEqual({ propertyId: "text", operator: "is_empty" });
    expect(quickCondition(t, row("a"), true)).toEqual({ propertyId: "text", operator: "is_not_empty" });
    expect(quickCondition(prop("title"), row("Hello"), false)).toEqual({ propertyId: "title", operator: "=", value: "Hello" });
  });
  it("handles numbers, options, checkboxes and ids", () => {
    expect(quickCondition(prop("number"), row("a", { number: 3 }), true)).toEqual({ propertyId: "number", operator: "!=", value: 3 });
    expect(quickCondition(prop("select"), row("a", { select: "o1" }), false)).toEqual({ propertyId: "select", operator: "=", value: "o1" });
    expect(quickCondition(prop("checkbox"), row("a", { checkbox: true }), true)).toEqual({ propertyId: "checkbox", operator: "=", value: false });
    expect(quickCondition(prop("unique_id"), row("a"), false)).toEqual({ propertyId: "unique_id", operator: "=", value: 7 });
  });
  it("combines several tags and refuses what it cannot express", () => {
    const tags = prop("multi_select", { options: [{ id: "a", name: "A", color: "gray" }, { id: "b", name: "B", color: "gray" }] });
    const c = quickCondition(tags, row("x", { multi_select: ["a", "b"] }), false);
    expect(c).toEqual({ op: "and", children: [{ propertyId: "multi_select", operator: "contains", value: "a" }, { propertyId: "multi_select", operator: "contains", value: "b" }] });
    expect(quickCondition(prop("date"), row("x", { date: { start: "2026-05-04T10:00" } }), false)).toEqual({ propertyId: "date", operator: "=", value: "2026-05-04" });
    expect(quickCondition(prop("date"), row("x", { date: { start: "2026-05-04" } }), true)).toBeNull();
    expect(quickCondition(prop("relation"), row("x"), false)).toBeNull();
  });
  it("adds to the existing filter with AND", () => {
    const a = { propertyId: "a", operator: "=", value: 1 };
    const b = { propertyId: "b", operator: "=", value: 2 };
    expect(andCondition(null, a)).toEqual(a);
    expect(andCondition(a, b)).toEqual({ op: "and", children: [a, b] });
    const any = { op: "or" as const, children: [a, a] };
    expect(andCondition(any, b)).toEqual({ op: "and", children: [any, b] });
  });
});

describe("find and replace", () => {
  const o = (find: string, replace: string, extra: Partial<{ matchCase: boolean; wholeCell: boolean }> = {}) => ({ find, replace, matchCase: false, wholeCell: false, ...extra });
  it("replaces every match, ignoring case unless asked", () => {
    expect(replaceInText("Foo foo FOO", o("foo", "x"))).toBe("x x x");
    expect(replaceInText("Foo foo FOO", o("foo", "x", { matchCase: true }))).toBe("Foo x FOO");
    expect(replaceInText("abc", o("z", "x"))).toBeNull();
    expect(replaceInText("a.b", o(".", "-"))).toBe("a-b");
  });
  it("can require the whole cell", () => {
    expect(replaceInText("Paris", o("paris", "Lyon", { wholeCell: true }))).toBe("Lyon");
    expect(replaceInText("Paris 2", o("paris", "Lyon", { wholeCell: true }))).toBeNull();
    expect(replaceInText("Paris", o("paris", "Lyon", { wholeCell: true, matchCase: true }))).toBeNull();
  });
  it("plans changes over the chosen properties and counts records", () => {
    const title = prop("title");
    const text = prop("text");
    const num = prop("number");
    const rows = [row("Old plan", { text: "old notes", number: 1 }, "1"), row("Other", { text: "none" }, "2"), row("Old", { text: "x" }, "3")];
    const plan = planReplace(rows, [title, text, num], o("old", "new"));
    expect(plan.changes.map((c) => `${c.recordId}:${c.propertyId}:${c.after}`)).toEqual(["1:title:new plan", "1:text:new notes", "3:title:new"]);
    expect(plan.records).toBe(2);
    expect(planReplace(rows, [text], o("old", "new")).changes).toHaveLength(1);
    expect(planReplace(rows, [text], o("", "new")).changes).toHaveLength(0);
  });
  it("skips results the backend would reject and writes undo values back", () => {
    const mail = prop("email");
    const rows = [row("a", { email: "a@x.io" }, "1")];
    const bad = planReplace(rows, [mail], o("@", ""));
    expect(bad.changes).toHaveLength(0);
    expect(bad.skipped).toBe(1);
    const good = planReplace(rows, [mail], o("x.io", "y.io"));
    const map = new Map([[mail.id, mail]]);
    expect(writes(good, map, "apply")[0].value).toBe("a@y.io");
    expect(writes(good, map, "undo")[0].value).toBe("a@x.io");
    const clearing = planReplace([row("a", { text: "gone" }, "1")], [prop("text")], o("gone", "", { wholeCell: true }));
    expect(writes(clearing, new Map([["text", prop("text")]]), "apply")[0].value).toBeNull();
  });
});

describe("column options", () => {
  const cols = ["t", "a", "b", "c"].map((id) => ({ propertyId: id, hidden: false }) as ViewColumn);
  it("moves a column beside another", () => {
    expect(moveBeside(cols, "c", "a", "left").map((c) => c.propertyId)).toEqual(["t", "c", "a", "b"]);
    expect(moveBeside(cols, "a", "b", "right").map((c) => c.propertyId)).toEqual(["t", "b", "a", "c"]);
    expect(moveBeside(cols, "a", "a", "left")).toBe(cols);
  });
  it("toggles wrapping and clamps the frozen count", () => {
    expect(toggleWrap(undefined, "a", true)).toEqual(["a"]);
    expect(toggleWrap(["a", "b"], "a", false)).toEqual(["b"]);
    expect(frozenCount(undefined, 5)).toBe(0);
    expect(frozenCount(9, 8)).toBe(3);
    expect(frozenCount(3, 2)).toBe(1);
    expect(frozenCount(-2, 5)).toBe(0);
  });
  it("offsets frozen columns by the widths before them", () => {
    expect(stickyOffsets([280, 180, 100, 90], 2)).toEqual([0, 280, 460]);
    expect(stickyOffsets([280, 180], 0)).toEqual([0]);
  });
});

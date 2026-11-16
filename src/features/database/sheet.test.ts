import { describe, expect, it } from "vitest";
import type { Property } from "../../types";
import { continueSeries } from "./fill";
import { parseCellText, parseDateText, parseNumberText, parseTsv, planPaste, toHtmlTable, toTsv } from "./paste";
import { coversAll, extendRange, fillTarget, fullRange, inRect, rectOf } from "./range";
import { afterUndo, emptyHistory, planReplay, record, sameValue } from "./undo";

const prop = (type: Property["type"], options: { id: string; name: string }[] = [], id = type): Property =>
  ({ id, databaseId: "d", name: id, type, config: { options: options.map((o) => ({ ...o, color: "gray" })) }, position: 0 }) as unknown as Property;

describe("range", () => {
  const b = { rows: 10, cols: 5 };
  it("extends from the anchor and keeps it", () => {
    const r1 = extendRange(null, { row: 2, col: 1 }, "ArrowDown", b)!;
    expect(r1).toEqual({ anchor: { row: 2, col: 1 }, focus: { row: 3, col: 1 } });
    const r2 = extendRange(r1, { row: 3, col: 1 }, "ArrowRight", b)!;
    expect(r2.anchor).toEqual({ row: 2, col: 1 });
    expect(rectOf(r2)).toEqual({ r0: 2, r1: 3, c0: 1, c1: 2 });
    expect(extendRange(r2, { row: 3, col: 2 }, "x", b)).toBeNull();
  });
  it("normalises a range dragged backwards", () => {
    const rect = rectOf({ anchor: { row: 4, col: 3 }, focus: { row: 1, col: 0 } });
    expect(rect).toEqual({ r0: 1, r1: 4, c0: 0, c1: 3 });
    expect(inRect(rect, 2, 2)).toBe(true);
    expect(inRect(rect, 5, 2)).toBe(false);
  });
  it("selects everything", () => {
    const all = fullRange(3, 2);
    expect(coversAll(all, 3, 2)).toBe(true);
    expect(coversAll({ anchor: { row: 0, col: 0 }, focus: { row: 1, col: 1 } }, 3, 2)).toBe(false);
    expect(fullRange(0, 2)).toBeNull();
  });
  it("grows the fill target toward the pointer", () => {
    const src = { r0: 1, r1: 2, c0: 1, c1: 2 };
    expect(fillTarget(src, { row: 2, col: 2 })).toBeNull();
    expect(fillTarget(src, { row: 5, col: 2 })).toEqual({ dir: "down", rect: { r0: 1, r1: 5, c0: 1, c1: 2 } });
    expect(fillTarget(src, { row: 2, col: 4 })).toEqual({ dir: "right", rect: { r0: 1, r1: 2, c0: 1, c1: 4 } });
  });
});

describe("tsv", () => {
  it("round-trips quoting", () => {
    const cells = [["a", 'b "q"', "line\nbreak"], ["", "tab\there", "z"]];
    expect(parseTsv(toTsv(cells))).toEqual(cells);
  });
  it("reads CRLF and drops a trailing break", () => {
    expect(parseTsv("1\t2\r\n3\t4\r\n")).toEqual([["1", "2"], ["3", "4"]]);
    expect(parseTsv("solo")).toEqual([["solo"]]);
    expect(parseTsv("")).toEqual([]);
  });
  it("keeps empty trailing cells", () => {
    expect(parseTsv("a\t\nb\tc")).toEqual([["a", ""], ["b", "c"]]);
  });
  it("builds an escaped html table", () => {
    expect(toHtmlTable([["<a>", "x&y"]])).toBe("<table><tbody><tr><td>&lt;a&gt;</td><td>x&amp;y</td></tr></tbody></table>");
  });
});

describe("parseCellText", () => {
  it("parses numbers in several notations", () => {
    expect(parseNumberText("1,234.5")).toBe(1234.5);
    expect(parseNumberText("1.234,5")).toBe(1234.5);
    expect(parseNumberText("3,5")).toBe(3.5);
    expect(parseNumberText("")).toBeNull();
    expect(parseNumberText("abc")).toBeNaN();
    expect(parseCellText(prop("number"), "12")).toEqual({ value: 12 });
    expect(parseCellText(prop("number"), "x")).toEqual({ skip: "invalid" });
    expect(parseCellText(prop("number"), " ")).toEqual({ value: null });
  });
  it("parses dates in the app's own formats", () => {
    expect(parseDateText("2026-10-07")).toEqual({ start: "2026-10-07" });
    expect(parseDateText("Oct 7, 2026 09:30")).toEqual({ start: "2026-10-07T09:30" });
    expect(parseDateText("Oct 7, 2026 → Oct 9, 2026")).toEqual({ start: "2026-10-07", end: "2026-10-09" });
    expect(parseDateText("not a date at all")).toBeNull();
    expect(parseCellText(prop("date"), "nope")).toEqual({ skip: "invalid" });
  });
  it("parses checkboxes", () => {
    expect(parseCellText(prop("checkbox"), "Checked")).toEqual({ value: true });
    expect(parseCellText(prop("checkbox"), "Unchecked")).toEqual({ value: false });
    expect(parseCellText(prop("checkbox"), "maybe")).toEqual({ skip: "invalid" });
  });
  it("matches options by name, ignoring case", () => {
    const sel = prop("select", [{ id: "o1", name: "Open" }, { id: "o2", name: "Done" }]);
    expect(parseCellText(sel, "done")).toEqual({ value: "o2" });
    expect(parseCellText(sel, "Nope")).toEqual({ skip: "unmatched" });
    expect(parseCellText(sel, "")).toEqual({ value: null });
    const multi = prop("multi_select", [{ id: "o1", name: "Open" }, { id: "o2", name: "Done" }]);
    expect(parseCellText(multi, "Open, done")).toEqual({ value: ["o1", "o2"], loose: false });
    expect(parseCellText(multi, "Open, Ghost")).toEqual({ value: ["o1"], loose: true });
    expect(parseCellText(multi, "Ghost")).toEqual({ skip: "unmatched" });
  });
  it("resolves relations through the lookup", () => {
    const rel = prop("relation");
    const ctx = { relation: (_: Property, t: string) => (t === "Alpha" ? "r1" : undefined) };
    expect(parseCellText(rel, "Alpha", ctx)).toEqual({ value: ["r1"], loose: false });
    expect(parseCellText(rel, "Alpha, Beta", ctx)).toEqual({ value: ["r1"], loose: true });
    expect(parseCellText(rel, "Beta", ctx)).toEqual({ skip: "unmatched" });
    expect(parseCellText(rel, "Alpha")).toEqual({ skip: "unmatched" });
  });
  it("skips calculated columns", () => {
    expect(parseCellText(prop("formula"), "5")).toEqual({ skip: "calculated" });
    expect(parseCellText(prop("created_time"), "5")).toEqual({ skip: "calculated" });
    expect(parseCellText(prop("title"), "a\nb")).toEqual({ value: "a b" });
  });
});

describe("planPaste", () => {
  const props = [prop("title"), prop("number"), prop("formula"), prop("text")];
  it("lays text over columns and counts what it skipped", () => {
    const plan = planPaste([["A", "1", "9", "t"], ["B", "oops", "9", ""]], 0, props);
    expect(plan.rows).toBe(2);
    expect(plan.skipped).toBe(3); // two formula cells, one bad number
    expect(plan.cells).toContainEqual({ r: 0, c: 1, value: 1 });
    expect(plan.cells).toContainEqual({ r: 1, c: 3, value: null });
    expect(plan.cells.some((c) => c.c === 2)).toBe(false);
  });
  it("drops columns past the last one", () => {
    const plan = planPaste([["1", "2", "3"]], 3, props);
    expect(plan.cells).toEqual([{ r: 0, c: 3, value: "1" }]);
  });
  it("fills a selection with a single copied cell", () => {
    const plan = planPaste([["7"]], 1, props, {}, { rows: 3, cols: 1 });
    expect(plan.rows).toBe(3);
    expect(plan.cells.map((c) => c.value)).toEqual([7, 7, 7]);
  });
});

describe("continueSeries", () => {
  it("copies a single value and cycles a plain list", () => {
    expect(continueSeries([5], 3, "number")).toEqual([5, 5, 5]);
    expect(continueSeries(["a", "b"], 5, "text")).toEqual(["a", "b", "a", "b", "a"]);
    expect(continueSeries([1, 2, 4], 2, "number")).toEqual([1, 2]);
  });
  it("continues number patterns", () => {
    expect(continueSeries([1, 2, 3], 3, "number")).toEqual([4, 5, 6]);
    expect(continueSeries([10, 7], 2, "number")).toEqual([4, 1]);
    expect(continueSeries([0.1, 0.2], 2, "number")).toEqual([0.3, 0.4]);
  });
  it("continues day patterns across month ends", () => {
    const src = [{ start: "2026-01-30" }, { start: "2026-01-31" }];
    expect(continueSeries(src, 2, "date")).toEqual([{ start: "2026-02-01" }, { start: "2026-02-02" }]);
    expect(continueSeries([{ start: "2026-01-30T09:00" }, { start: "2026-01-31T09:00" }], 1, "date")).toEqual([{ start: "2026-01-30T09:00" }]);
    expect(continueSeries([], 3, "number")).toEqual([]);
  });
});

describe("undo history", () => {
  const edit = (recordId: string, before: unknown, after: unknown) => ({ recordId, propertyId: "p", before, after });
  it("compares values by content, with empty equal to empty", () => {
    expect(sameValue(null, "")).toBe(true);
    expect(sameValue([], undefined)).toBe(true);
    expect(sameValue({ start: "a" }, { start: "a" })).toBe(true);
    expect(sameValue(1, 2)).toBe(false);
    expect(sameValue(false, null)).toBe(false);
  });
  it("records steps, clears redo on a new edit and caps the stack", () => {
    let h = emptyHistory("s");
    h = record(h, { edits: [edit("a", 1, 2)] });
    const step = h.undo[0];
    h = afterUndo(h, step);
    expect(h.redo).toHaveLength(1);
    h = record(h, { edits: [edit("a", 1, 3)] });
    expect(h.redo).toHaveLength(0);
    for (let i = 0; i < 150; i++) h = record(h, { edits: [edit("a", i, i + 1)] });
    expect(h.undo).toHaveLength(100);
    expect(record(h, { edits: [] })).toBe(h);
  });
  it("skips cells that changed since the step", () => {
    const step = { edits: [edit("a", 1, 2), edit("b", 1, 2), edit("c", 1, 2)] };
    const now: Record<string, unknown> = { a: 2, b: 99 };
    const plan = planReplay(step, "undo", (id) => (id in now ? { value: now[id] } : undefined));
    expect(plan.skipped).toBe(1);
    expect(plan.cells.map((c) => c.recordId)).toEqual(["a", "c"]);
    expect(plan.cells[0].value).toBe(1);
    expect(plan.step.edits).toHaveLength(2);
    const redo = planReplay(plan.step, "redo", () => ({ value: 1 }));
    expect(redo.cells.map((c) => c.value)).toEqual([2, 2]);
  });
});

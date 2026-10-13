import { describe, expect, it } from "vitest";
import type { Property, SharedFilter, Widget } from "../../types";
import { boxOf, cellsFor, clampRect, overlaps, place, rowsOf, settle, slotFor } from "./layout";
import { choicesFrom, describe as describeFilter, filterFor, filterTypeFor, leafFor } from "./sharedFilters";

const w = (id: string, x: number, y: number, ww: number, h: number): Widget => ({ id, type: "text", x, y, w: ww, h });
const at = (list: Widget[], id: string) => list.find((x) => x.id === id)!;

describe("dashboard grid", () => {
  it("keeps rectangles on the grid", () => {
    expect(clampRect({ x: 10, y: -3, w: 6, h: 0 })).toEqual({ x: 6, y: 0, w: 6, h: 1 });
    expect(clampRect({ x: 0, y: 0, w: 99, h: 99 })).toEqual({ x: 0, y: 0, w: 12, h: 40 });
    expect(clampRect({ x: 1.4, y: 2.6, w: 1, h: 2 })).toEqual({ x: 1, y: 3, w: 2, h: 2 });
  });

  it("detects overlap only when areas intersect", () => {
    expect(overlaps({ x: 0, y: 0, w: 4, h: 2 }, { x: 4, y: 0, w: 4, h: 2 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 4, h: 2 }, { x: 3, y: 1, w: 4, h: 2 })).toBe(true);
    expect(overlaps({ x: 0, y: 0, w: 4, h: 2 }, { x: 0, y: 2, w: 4, h: 2 })).toBe(false);
  });

  it("settles widgets upward without overlap", () => {
    const out = settle([w("a", 0, 5, 4, 2), w("b", 4, 9, 4, 2), w("c", 0, 12, 4, 2)]);
    expect(at(out, "a").y).toBe(0);
    expect(at(out, "b").y).toBe(0);
    expect(at(out, "c").y).toBe(2);
  });

  it("makes room around the widget being moved", () => {
    const start = [w("a", 0, 0, 6, 3), w("b", 6, 0, 6, 3), w("c", 0, 3, 12, 2)];
    const out = place(start, "a", { x: 6, y: 0, w: 6, h: 3 });
    expect(at(out, "a")).toMatchObject({ x: 6, y: 0 });
    expect(overlaps(at(out, "a"), at(out, "b"))).toBe(false);
    expect(at(out, "b").y).toBe(3);
    for (const p of out) for (const q of out) if (p !== q) expect(overlaps(p, q)).toBe(false);
    // The order of the list never changes, only positions.
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("clamps resizes and finds a slot for a new widget", () => {
    const out = place([w("a", 8, 0, 4, 2)], "a", { x: 8, y: 0, w: 9, h: 2 });
    expect(at(out, "a")).toMatchObject({ x: 3, w: 9 });
    expect(slotFor([w("a", 0, 0, 6, 3), w("b", 6, 0, 6, 5)], 4, 2)).toEqual({ x: 0, y: 5, w: 4, h: 2 });
    expect(slotFor([], 4, 2).y).toBe(0);
    expect(rowsOf([w("a", 0, 0, 6, 3), w("b", 6, 2, 6, 5)])).toBe(7);
    expect(rowsOf([])).toBe(0);
  });

  it("converts between cells and pixels", () => {
    const b = boxOf({ x: 6, y: 1, w: 6, h: 2 }, 1188, 64, 12);
    expect(b.left).toBe(600);
    expect(b.top).toBe(76);
    expect(b.height).toBe(140);
    expect(cellsFor(200, 80, 1188, 64, 12)).toEqual({ dx: 2, dy: 1 });
    expect(cellsFor(-4, 3, 1188, 64, 12)).toEqual({ dx: -0, dy: 0 });
  });
});

const opts = (...names: string[]) => names.map((n, i) => ({ id: `o${i}`, name: n, color: "violet" as const }));
const prop = (id: string, name: string, type: Property["type"], config: Property["config"] = {}): Property => ({ id, databaseId: "d", name, type, config, position: 0 });
const props = [prop("t", "Name", "title"), prop("s", "Status", "status", { options: opts("To do", "Done") }), prop("c", "Done?", "checkbox"), prop("d", "Due", "date"), prop("n", "Points", "number")];
const f = (type: SharedFilter["type"], propertyName: string, value: unknown): SharedFilter => ({ id: "f", propertyName, type, value });

describe("dashboard filters", () => {
  it("finds properties by name and turns names into option ids", () => {
    expect(leafFor(f("option", "status", "done"), props)).toEqual({ propertyId: "s", operator: "=", value: "o1" });
    expect(leafFor(f("option", "Status", "Nope"), props)).toEqual({ propertyId: "s", operator: "=", value: "__no_such_option__" });
    expect(leafFor(f("checkbox", "Done?", false), props)).toEqual({ propertyId: "c", operator: "=", value: false });
    expect(leafFor(f("text", "Name", " alpha "), props)).toEqual({ propertyId: "t", operator: "contains", value: "alpha" });
  });

  it("leaves databases alone when the property is missing or the wrong type", () => {
    expect(leafFor(f("option", "Priority", "High"), props)).toBeNull();
    expect(leafFor(f("option", "Points", "High"), props)).toBeNull();
    expect(leafFor(f("text", "Name", "  "), props)).toBeNull();
    expect(filterFor([f("option", "Priority", "High")], props)).toBeNull();
  });

  it("turns day counts into relative date windows", () => {
    expect(leafFor(f("date_days", "Due", 7), props)).toEqual({ propertyId: "d", operator: "between", value: [{ relativeDays: -7 }, { relativeDays: 0 }] });
    expect(leafFor(f("date_days", "Due", -30), props)).toEqual({ propertyId: "d", operator: "between", value: [{ relativeDays: 0 }, { relativeDays: 30 }] });
    expect(leafFor(f("date_days", "Due", 0), props)).toBeNull();
  });

  it("combines every applicable filter with AND", () => {
    const both = filterFor([f("option", "Status", "To do"), f("date_days", "Due", 7), f("option", "Priority", "High")], props);
    expect(both).toMatchObject({ op: "and" });
    expect((both as { children: unknown[] }).children).toHaveLength(2);
    expect(filterFor([f("option", "Status", "To do")], props)).toMatchObject({ propertyId: "s" });
    expect(filterFor([], props)).toBeNull();
  });

  it("offers every property name across the dashboard's databases", () => {
    const other = [prop("x", "status", "status", { options: opts("Done", "Blocked") }), prop("y", "Owner", "relation")];
    const c = choicesFrom([props, other]);
    const status = c.find((x) => x.name.toLowerCase() === "status")!;
    expect(status.options).toEqual(["To do", "Done", "Blocked"]);
    expect(c.some((x) => x.name === "Owner")).toBe(false);
    expect(filterTypeFor(prop("r", "R", "rollup"))).toBeNull();
  });

  it("describes filters in words", () => {
    expect(describeFilter(f("option", "Status", "Done"))).toBe("Status is Done");
    expect(describeFilter(f("date_days", "Due", 30))).toBe("Due: last 30 days");
    expect(describeFilter(f("checkbox", "Done?", true))).toBe("Done? is checked");
  });
});

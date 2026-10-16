import { beforeEach, describe, expect, it } from "vitest";
import { paneCount, presetTree } from "./layouts";
import { useSplit } from "./store";
import { dividers, insertLeaf, leaf, leaves, moveLeaf, normalize, rects, removeLeaf, resize, split, zoneOf, MIN_SHARE } from "./tree";
import { useWorkspace } from "../../stores/workspace";

describe("layout tree", () => {
  it("builds every preset with all its panes reachable", () => {
    for (const [id, n] of [["columns", 2], ["rows", 2], ["quad", 4], ["master-detail", 3], ["tiled", 3], ["tiled", 5], ["tiled", 6]] as const) {
      const t = presetTree(id, n);
      expect(leaves(t).sort(), `${id}/${n}`).toEqual(Array.from({ length: n }, (_, i) => i));
      const area = [...rects(t).values()].reduce((a, r) => a + r.w * r.h, 0);
      expect(area).toBeCloseTo(1);
    }
    expect(paneCount("quad")).toBe(4);
  });

  it("lets the master span the full height", () => {
    expect(rects(presetTree("master-detail")).get(0)).toMatchObject({ x: 0, y: 0, h: 1 });
  });

  it("docks a pane against an edge, taking half of the target", () => {
    const t = insertLeaf(leaf(0), 1, 0, "left");
    expect(leaves(t)).toEqual([1, 0]);
    expect(rects(t).get(1)).toMatchObject({ x: 0, w: 0.5 });
    const stacked = insertLeaf(t, 2, 0, "bottom");
    expect(rects(stacked).get(2)).toMatchObject({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it("merges same-axis splits and collapses a lone child on removal", () => {
    const t = insertLeaf(insertLeaf(leaf(0), 1, 0, "right"), 2, 1, "right");
    expect("kids" in t && t.kids).toHaveLength(3);
    expect(removeLeaf(removeLeaf(t, 2)!, 1)).toEqual(leaf(0));
  });

  it("moves a pane without renumbering", () => {
    const t = moveLeaf(split("x", [leaf(0), leaf(1), leaf(2)]), 2, 0, "top");
    expect(rects(t).get(2)).toMatchObject({ y: 0, h: 0.5, x: 0 });
    expect(leaves(t).sort()).toEqual([0, 1, 2]);
  });

  it("breaks the divider where a pane spans across it", () => {
    const seams = dividers(presetTree("master-detail"));
    expect(seams.filter((d) => d.axis === "x")).toHaveLength(1);
    const row = seams.find((d) => d.axis === "y")!;
    expect(row.x).toBeCloseTo(0.58);
    expect(row.w).toBeCloseTo(0.42);
  });

  it("keeps resized tracks whole and above the minimum", () => {
    const next = resize([0.5, 0.5], 0, 0.2);
    expect(next[0]).toBeCloseTo(0.7);
    expect(resize([0.5, 0.5], 0, 5)[1]).toBeCloseTo(MIN_SHARE);
    expect(normalize([2, 2])).toEqual([0.5, 0.5]);
  });

  it("reads the drop zone from where in a pane the pointer is", () => {
    expect([zoneOf(0.5, 0.5), zoneOf(0.05, 0.5), zoneOf(0.95, 0.5), zoneOf(0.5, 0.05), zoneOf(0.5, 0.95)]).toEqual(["center", "left", "right", "top", "bottom"]);
  });
});

describe("split store", () => {
  beforeEach(() => {
    useWorkspace.setState({ view: "page", selectedPageId: "MAIN", favorites: [], children: { root: [] } } as never);
    useSplit.getState().closeAll();
  });

  it("opens a pane beside the main view when a page is placed", () => {
    useSplit.getState().place("A");
    expect(useSplit.getState().panes).toEqual(["A"]);
    expect(useSplit.getState().layout).toBe("custom");
  });

  it("ignores the open page and trades places for a page shown elsewhere", () => {
    const s = useSplit.getState();
    s.place("MAIN");
    expect(useSplit.getState().panes).toEqual([]);
    s.place("A");
    s.place("B");
    s.place("A", 2);
    expect(useSplit.getState().panes).toEqual(["B", "A"]);
  });

  it("docks a new page against a pane edge", () => {
    const s = useSplit.getState();
    s.dock("A", 0, "left");
    expect(useSplit.getState().panes).toEqual(["A"]);
    expect(rects(useSplit.getState().tree).get(1)).toMatchObject({ x: 0, w: 0.5 });
    s.dock("B", 1, "bottom");
    expect(rects(useSplit.getState().tree).get(2)).toMatchObject({ x: 0, y: 0.5, h: 0.5 });
  });

  it("moves a docked page and the main view without losing any", () => {
    const s = useSplit.getState();
    s.place("A");
    s.dock("A", 0, "top");
    expect(rects(useSplit.getState().tree).get(1)).toMatchObject({ y: 0, h: 0.5 });
    s.dock("MAIN", 1, "right");
    expect(rects(useSplit.getState().tree).get(0)).toMatchObject({ x: 0.5, y: 0, w: 0.5 });
    expect(useSplit.getState().panes).toEqual(["A"]);
  });

  it("closes a pane and renumbers the rest", () => {
    const s = useSplit.getState();
    s.place("A");
    s.place("B");
    s.place("C");
    s.closePane(1);
    expect(useSplit.getState().panes).toEqual(["B", "C"]);
    expect(leaves(useSplit.getState().tree).sort()).toEqual([0, 1, 2]);
    s.closePane(1);
    s.closePane(1);
    expect(useSplit.getState().layout).toBe("single");
  });

  it("fills a preset from the pages that are open and the pool, never leaving a pane empty", () => {
    useWorkspace.setState({ children: { root: [{ id: "X" }, { id: "Y" }, { id: "MAIN" }] } } as never);
    const s = useSplit.getState();
    s.setLayout("quad");
    expect(useSplit.getState().layout).toBe("tiled");
    expect(useSplit.getState().panes).toEqual(["X", "Y"]);
    s.setLayout("columns");
    expect(useSplit.getState().panes).toEqual(["X"]);
  });

  it("swaps two side panes", () => {
    const s = useSplit.getState();
    s.place("A");
    s.place("B");
    s.swap(1, 2);
    expect(useSplit.getState().panes).toEqual(["B", "A"]);
  });
});

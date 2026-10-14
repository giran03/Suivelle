import { describe, expect, it } from "vitest";
import { arrowBetween, bounds, clampZoom, edgePoint, fitViewport, gridSlots, snap, toScreen, toWorld, zoomAt } from "./viewport";

describe("canvas viewport", () => {
  it("converts between screen and world and back", () => {
    const v = { x: 30, y: -20, k: 2 };
    const w = toWorld(v, 130, 80);
    expect(w).toEqual({ x: 50, y: 50 });
    expect(toScreen(v, w.x, w.y)).toEqual({ x: 130, y: 80 });
  });

  it("zooms around the pointer so the point under it stays put", () => {
    const v = { x: 10, y: 10, k: 1 };
    const next = zoomAt(v, 200, 150, 2);
    expect(next.k).toBe(2);
    expect(toWorld(next, 200, 150)).toEqual(toWorld(v, 200, 150));
  });

  it("clamps zoom and leaves the viewport alone at the limit", () => {
    expect(clampZoom(100)).toBe(4);
    expect(clampZoom(0.001)).toBe(0.1);
    const v = { x: 0, y: 0, k: 4 };
    expect(zoomAt(v, 5, 5, 2)).toBe(v);
  });

  it("fits content inside the screen", () => {
    const content = { x: 100, y: 100, w: 1000, h: 500 };
    const v = fitViewport(content, 800, 600);
    const tl = toScreen(v, content.x, content.y);
    const br = toScreen(v, content.x + content.w, content.y + content.h);
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(800);
    expect(br.y).toBeLessThanOrEqual(600);
    expect(fitViewport(null, 800, 600).k).toBe(1);
  });

  it("measures the bounds of several boxes", () => {
    expect(bounds([])).toBeNull();
    expect(bounds([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }])).toEqual({ x: 0, y: 0, w: 30, h: 15 });
  });

  it("starts an arrow on the box edge facing the other box", () => {
    const a = { x: 0, y: 0, w: 100, h: 50 };
    const b = { x: 300, y: 0, w: 100, h: 50 };
    expect(edgePoint(a, { x: 350, y: 25 })).toEqual({ x: 100, y: 25 });
    const { a: start, b: end, mid } = arrowBetween(a, b);
    expect(start).toEqual({ x: 100, y: 25 });
    expect(end).toEqual({ x: 300, y: 25 });
    expect(mid).toEqual({ x: 200, y: 25 });
  });

  it("lays out grid slots row by row", () => {
    const slots = gridSlots(7, { x: 0, y: 100 });
    expect(slots).toHaveLength(7);
    expect(slots[0]).toEqual({ x: 0, y: 100 });
    expect(slots[5].x).toBe(0);
    expect(slots[5].y).toBeGreaterThan(100);
  });

  it("snaps to the grid", () => {
    expect(snap(13)).toBe(16);
    expect(snap(11)).toBe(8);
  });
});

import { alignBoxes, distributeBoxes, easeOutCubic, intersects, lerpViewport, normalizeBox, snapMove, stepZoom, zoomToBox } from "./viewport";

describe("canvas motion and arranging", () => {
  it("eases from 0 to 1 and interpolates zoom geometrically", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    const mid = lerpViewport({ x: 0, y: 0, k: 0.5 }, { x: 100, y: 40, k: 2 }, 0.5);
    expect(mid.k).toBeCloseTo(1);
    expect(mid.x).toBe(50);
  });

  it("steps zoom through presets and stops at the limits", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.1, -1)).toBe(0.1);
  });

  it("zooms to a box without enlarging a small one past 150%", () => {
    const v = zoomToBox({ x: 0, y: 0, w: 50, h: 50 }, 800, 600);
    expect(v.k).toBe(1.5);
  });

  it("tests box overlap and normalizes a dragged rectangle", () => {
    expect(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(normalizeBox(10, 20, 4, 8)).toEqual({ x: 4, y: 8, w: 6, h: 12 });
  });

  it("snaps a moving box to a neighbor's edge and reports the guide", () => {
    const { dx, dy, guides } = snapMove({ x: 103, y: 50, w: 40, h: 40 }, [{ x: 0, y: 0, w: 100, h: 100 }], 6);
    expect(dx).toBe(-3);
    expect(dy).toBe(0);
    expect(guides.some((g) => g.axis === "x" && g.at === 100)).toBe(true);
    expect(snapMove({ x: 300, y: 300, w: 10, h: 10 }, [{ x: 0, y: 0, w: 100, h: 100 }], 6)).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("aligns and distributes boxes", () => {
    const boxes = [
      { id: "a", x: 0, y: 0, w: 10, h: 10 },
      { id: "b", x: 50, y: 20, w: 30, h: 10 },
      { id: "c", x: 200, y: 5, w: 10, h: 10 },
    ];
    expect(alignBoxes(boxes, "left").get("b")?.x).toBe(0);
    expect(alignBoxes(boxes, "right").get("a")?.x).toBe(200);
    expect(alignBoxes(boxes, "middle").get("a")?.y).toBe(10);
    const spread = distributeBoxes(boxes, "x");
    const gapAB = spread.get("b")!.x - (spread.get("a")!.x + 10);
    const gapBC = spread.get("c")!.x - (spread.get("b")!.x + 30);
    expect(gapAB).toBeCloseTo(gapBC);
    expect(distributeBoxes(boxes.slice(0, 2), "x").size).toBe(0);
  });
});

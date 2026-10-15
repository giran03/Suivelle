import { describe, expect, it } from "vitest";
import type { CanvasItem, CanvasOp } from "../../../types";
import { applyOps, coalesce } from "./useCanvas";

const item = (id: string, x = 0): CanvasItem => ({ id, kind: "note", recordId: null, text: "", attachmentHash: null, x, y: 0, w: 100, h: 60, z: 0, color: null });

describe("canvas edits", () => {
  it("adds, moves and removes items, taking their arrows with them", () => {
    let d = applyOps({ items: [], edges: [] }, [
      { op: "upsert_item", item: item("a") },
      { op: "upsert_item", item: item("b", 200) },
      { op: "upsert_edge", edge: { id: "e", fromItem: "a", toItem: "b", label: "" } },
    ]);
    expect(d.items).toHaveLength(2);
    d = applyOps(d, [{ op: "upsert_item", item: item("a", 50) }]);
    expect(d.items.find((i) => i.id === "a")?.x).toBe(50);
    expect(d.items).toHaveLength(2);
    d = applyOps(d, [{ op: "delete_item", id: "b" }]);
    expect(d.edges).toHaveLength(0);
  });

  it("keeps only the last edit of an item within a batch", () => {
    const ops: CanvasOp[] = [
      { op: "upsert_item", item: item("a", 1) },
      { op: "delete_edge", id: "x" },
      { op: "upsert_item", item: item("a", 2) },
      { op: "upsert_item", item: item("a", 3) },
    ];
    const out = coalesce(ops);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ op: "upsert_item", item: item("a", 3) });
  });
});

import { inverseOf } from "./useCanvas";

describe("undoing canvas edits", () => {
  const base = { items: [item("a", 0), item("b", 100)], edges: [{ id: "e", fromItem: "a", toItem: "b", label: "x" }] };

  it("restores moved items, removes added ones", () => {
    const ops: CanvasOp[] = [
      { op: "upsert_item", item: item("a", 40) },
      { op: "upsert_item", item: item("new", 5) },
    ];
    const undone = applyOps(applyOps(base, ops), inverseOf(base, ops));
    expect(undone.items.map((i) => [i.id, i.x]).sort()).toEqual([["a", 0], ["b", 100]]);
  });

  it("brings a deleted item back with its arrows", () => {
    const ops: CanvasOp[] = [{ op: "delete_item", id: "a" }];
    const gone = applyOps(base, ops);
    expect(gone.edges).toHaveLength(0);
    const back = applyOps(gone, inverseOf(base, ops));
    expect(back.items).toHaveLength(2);
    expect(back.edges).toEqual(base.edges);
  });

  it("undoes a batch in reverse order", () => {
    const ops: CanvasOp[] = [
      { op: "upsert_item", item: item("a", 1) },
      { op: "upsert_item", item: item("a", 2) },
    ];
    const back = applyOps(applyOps(base, ops), inverseOf(base, ops));
    expect(back.items.find((i) => i.id === "a")?.x).toBe(0);
  });
});

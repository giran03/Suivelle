import { describe, expect, it } from "vitest";
import { coordinates, neighborhood, type MapData, type MapNode } from "./model";
const node = (id: string, parentId: string | null = null): MapNode => ({ id, parentId, workspaceId: "w", title: id, kind: "page", icon: null, favorite: false, archived: false, createdAt: "2026-01-01", updatedAt: "2026-01-01", count: 0, recordId: null, databaseId: null, tags: [], values: {} });
const data: MapData = { nodes: [node("a"), node("b", "a"), node("c")], edges: [{ id: "ab", source: "a", target: "b", kind: "contains", label: "Contains", propertyId: null, count: 1 }, { id: "wc", source: "workspace:w", target: "c", kind: "contains", label: "Contains", propertyId: null, count: 1 }], properties: [], totalNodes: 3, truncated: false };
describe("map navigation geometry", () => {
  it("keeps existing pages in place when a page is added or renamed", () => {
    const before = coordinates(data, "clusters", false);
    const after = coordinates({ ...data, nodes: [...data.nodes.map(n => ({ ...n, title: "Renamed" })), node("d")] }, "clusters", false);
    expect(after.a).toEqual(before.a); expect(after.b).toEqual(before.b);
  });
  it("keeps a readable plane and honors pins, including malformed parent cycles", () => {
    const plane = coordinates({ ...data, nodes: [node("a", "b"), node("b", "a")] }, "hierarchy", true, "", { a: { x: 12, y: 34, z: 56 } });
    expect(plane.a).toEqual({ x: 12, y: 34, z: 0 }); expect(Number.isFinite(plane.b.y)).toBe(true);
  });
  it("does not expand neighborhoods through workspace membership", () => {
    expect([...neighborhood(data, "a", 3)].sort()).toEqual(["a", "b"]);
    expect([...neighborhood(data, "c", 3)]).toEqual(["c"]);
  });
});

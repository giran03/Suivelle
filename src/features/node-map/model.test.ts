import { describe, expect, it } from "vitest";
import { coordinates, neighborhood, tether, TETHER, type MapData, type MapNode } from "./model";
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
  it("fills a sphere in 3D and a disc in 2D", () => {
    const many: MapData = { ...data, nodes: Array.from({ length: 400 }, (_, i) => node(`page-${i}`)) };
    const extent = (positions: ReturnType<typeof coordinates>, axis: "x" | "y" | "z") => { const values = Object.values(positions).map(p => p[axis]); return Math.max(...values) - Math.min(...values); };
    const ball = coordinates(many, "clusters", false);
    expect(extent(ball, "z")).toBeGreaterThan(extent(ball, "x") * .8);
    for (const p of Object.values(ball)) expect(Math.hypot(p.x, p.y, p.z)).toBeLessThanOrEqual(260.5);
    expect(extent(coordinates(many, "clusters", true), "z")).toBe(0);
  });
  it("spreads workspaces over a sphere in 3D and a ring in 2D", () => {
    const hubs: MapData = { ...data, nodes: Array.from({ length: 6 }, (_, i) => ({ ...node(`workspace:${i}`), kind: "workspace" as const, workspaceId: `w${i}` })) };
    const space = Object.values(coordinates(hubs, "clusters", false)), plane = Object.values(coordinates(hubs, "clusters", true));
    const radius = Math.hypot(space[0].x, space[0].y, space[0].z);
    for (const p of space) expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(radius, 5);
    expect(new Set(space.map(p => Math.round(p.z))).size).toBeGreaterThan(3);
    expect(plane.every(p => p.z === 0)).toBe(true);
  });
  it("tethers pages to their parent or workspace, branch by branch, pins included", () => {
    const hub = { ...node("workspace:w"), kind: "workspace" as const };
    const tree: MapData = { ...data, nodes: [hub, node("top"), node("child", "top"), node("leaf", "child"), node("pinned")] };
    const drifted = { "workspace:w": { x: 0, y: 0, z: 0 }, top: { x: 2000, y: 0, z: 0 }, child: { x: -3000, y: 0, z: 0 }, leaf: { x: 0, y: 5000, z: 0 }, pinned: { x: 9000, y: 0, z: 0 } };
    const held = tether(tree, drifted);
    const gap = (a: string, b: string) => Math.hypot(held[a].x - held[b].x, held[a].y - held[b].y, held[a].z - held[b].z);
    expect(gap("top", "workspace:w")).toBeCloseTo(TETHER.workspace);
    expect(gap("child", "top")).toBeCloseTo(TETHER.parent);
    expect(gap("leaf", "child")).toBeCloseTo(TETHER.parent);
    expect(gap("pinned", "workspace:w")).toBeCloseTo(TETHER.workspace);
    const many: MapData = { ...data, nodes: [hub, ...Array.from({ length: 300 }, (_, i) => node(`p${i}`, i > 20 ? `p${i % 20}` : null))] };
    const placed = coordinates(many, "clusters", false);
    for (const n of many.nodes) if (n.parentId) { const a = placed[n.id], b = placed[n.parentId]; expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThanOrEqual(TETHER.parent + 1e-6); }
  });
  it("does not expand neighborhoods through workspace membership", () => {
    expect([...neighborhood(data, "a", 3)].sort()).toEqual(["a", "b"]);
    expect([...neighborhood(data, "c", 3)]).toEqual(["c"]);
  });
});

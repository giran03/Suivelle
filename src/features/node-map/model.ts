export type NodeKind = "workspace" | "page" | "database" | "record" | "dashboard";
/** Semantic theme tokens shared by the renderer, list and node-type legend. */
export const NODE_COLORS: Record<Exclude<NodeKind, "workspace">, string> = { page: "--tone-blue", database: "--tone-violet", record: "--tone-green", dashboard: "--tone-orange" };
export type EdgeKind = "contains" | "membership" | "reference" | "relation" | "dependency";
export interface MapNode {
  id: string; workspaceId: string; parentId: string | null; title: string; kind: NodeKind;
  icon: string | null; favorite: boolean; archived: boolean; createdAt: string; updatedAt: string;
  count: number; recordId: string | null; databaseId: string | null; tags: string[]; values: Record<string, unknown>;
  /** The agent that created the page, when an agent did. */
  createdBy?: string | null;
}
export interface MapEdge { id: string; source: string; target: string; kind: EdgeKind; label: string; propertyId: string | null; count: number }
export interface MapProperty { id: string; databaseId: string; name: string; kind: string; config: Record<string, unknown> }
export interface MapData { nodes: MapNode[]; edges: MapEdge[]; properties: MapProperty[]; totalNodes: number; truncated: boolean }
export interface MapQuery { workspaceIds: string[]; pageId?: string; hops?: number; search?: string; includeRecords?: boolean; limit?: number }
export type Layout = "clusters" | "hierarchy" | "organic" | "property" | "timeline";
export interface Position { x: number; y: number; z: number }
export interface CameraState { position: [number, number, number]; target: [number, number, number]; zoom: number }
export type MapEdit =
  | { kind: "reference"; source: string; target: string }
  | { kind: "move"; source: string; target: string | null }
  | { kind: "relation"; source: string; target: string; propertyId: string; dependency: boolean }
  | { kind: "setProperty"; pageIds: string[]; propertyId: string; value: unknown }
  | { kind: "tag"; pageIds: string[]; tag: string }
  | { kind: "restoreParent"; source: string; parent: string | null; position: number; expectedParent: string | null; expectedPosition: number }
  | { kind: "blocks"; changes: { pageId: string; blockId: string; dataJson: string; position: number; expectedRevision: number | null }[] }
  | { kind: "cells"; propertyId: string; dependency: boolean; changes: { recordId: string; value: unknown; expected: unknown }[] };
export const workspaceNode = (id: string) => `workspace:${id}`;

/** Stable coordinates based on identity, not list order: renamed and newly added pages stay put. */
export function hash(id: string) { let value = 2166136261; for (const c of id) value = Math.imul(value ^ c.charCodeAt(0), 16777619); return value >>> 0; }

export function coordinates(data: MapData, layout: Layout, flat: boolean, propertyId = "", pins: Record<string, Position> = {}): Record<string, Position> {
  const at = new Map(data.nodes.map(n => [n.id, n]));
  const positions: Record<string, Position> = {};
  const clusters = [...new Set(data.nodes.map(n => layout === "property" ? propertyGroup(n, data.properties.find(p => p.id === propertyId)) : n.workspaceId))].sort();
  const dateProperty = data.properties.find(p => p.id === propertyId);
  const dateOf = (node: MapNode) => { const raw = dateProperty ? node.values[dateProperty.id] : node.createdAt; const time = typeof raw === "object" && raw !== null ? (raw as { start?: string }).start : raw; return typeof time === "string" ? Date.parse(time) : Number.NaN; };
  const dates = layout === "timeline" ? data.nodes.filter(n => n.kind !== "workspace").map(dateOf).filter(Number.isFinite) : [];
  const minDate = Math.min(...dates), maxDate = Math.max(...dates);
  for (const node of data.nodes) {
    if (pins[node.id]) { positions[node.id] = { ...pins[node.id], z: flat ? 0 : pins[node.id].z }; continue; }
    const group = layout === "property" ? propertyGroup(node, data.properties.find(p => p.id === propertyId)) : node.workspaceId;
    const index = clusters.indexOf(group), angle = index * Math.PI * 2 / Math.max(1, clusters.length);
    const spread = clusters.length > 1 ? 260 + clusters.length * 50 : 0;
    // 2D (and the timeline, whose depth is time) keeps workspaces on a ring; 3D spreads them evenly
    // over a sphere (a Fibonacci lattice) so the universe has depth at every scale.
    const sphere = !flat && layout !== "timeline" && clusters.length > 1;
    const lift = sphere ? 1 - 2 * (index + .5) / clusters.length : 0, ring = Math.sqrt(1 - lift * lift), turn = sphere ? index * Math.PI * (3 - Math.sqrt(5)) : angle;
    const anchor = sphere ? { x: Math.cos(turn) * ring * spread, y: lift * spread, z: Math.sin(turn) * ring * spread } : { x: Math.cos(angle) * spread, y: Math.sin(angle) * spread, z: 0 };
    const seed = hash(node.id), theta = seed / 0xffffffff * Math.PI * 2, radius = 70 + ((seed >>> 9) % 180);
    let depth = 0, parent = node.parentId; const visited = new Set([node.id]);
    while (parent && at.has(parent) && !visited.has(parent)) { visited.add(parent); depth++; parent = at.get(parent)?.parentId ?? null; }
    let p: Position;
    if (flat) p = node.kind === "workspace" ? { x: anchor.x, y: anchor.y + 180, z: 0 } : { x: anchor.x + Math.cos(theta) * radius, y: anchor.y + Math.sin(theta) * radius, z: 0 };
    else if (node.kind === "workspace") p = { x: anchor.x, y: layout === "hierarchy" ? 210 : anchor.y, z: anchor.z };
    else {
      // In 3D, pages fill a ball around their workspace hub: an even direction on the sphere and a
      // cube-root radius, so the cluster reads as a sphere from every angle instead of a thin disc.
      const second = hash(`${node.id}#z`), cosPhi = (second % 10007) / 10006 * 2 - 1, sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
      const ball = 70 + 190 * Math.cbrt(((second >>> 14) % 4001) / 4000);
      p = { x: anchor.x + ball * sinPhi * Math.cos(theta), y: anchor.y + ball * sinPhi * Math.sin(theta), z: anchor.z + ball * cosPhi };
    }
    // Hierarchy levels become rings around the vertical axis in 3D, so a tree is a solid, not a sheet.
    if (layout === "hierarchy" && node.kind !== "workspace") { p.y = 80 - depth * 130; p.x = anchor.x + Math.cos(theta) * radius; p.z = flat ? 0 : anchor.z + Math.sin(theta) * radius; }
    if (layout === "timeline" && node.kind !== "workspace") {
      const parsed = dateOf(node);
      const t = Number.isFinite(parsed) ? ((parsed - minDate) / Math.max(1, maxDate - minDate)) * 1000 - 500 : 650;
      if (flat) p.y = t; else p.z = t;
    }
    positions[node.id] = p;
  }
  return layout === "clusters" ? tether(data, positions) : positions;
}

/** Furthest a page may sit from its parent page, or from its workspace when it is top level. */
export const TETHER = { parent: 200, workspace: 300 };
/**
 * Keeps every page near what it belongs to, so a sparsely linked page never drifts off on its own.
 * Parents are placed first, so whole branches stay together. Pins are held too: a page dragged past
 * its leash rests at the edge, so nothing can end up stranded across the map.
 */
export function tether(data: MapData, positions: Record<string, Position>): Record<string, Position> {
  const at = new Map(data.nodes.map(n => [n.id, n])), depth = new Map<string, number>();
  const depthOf = (node: MapNode) => {
    let d = 0, current: MapNode | undefined = node; const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.id)) { seen.add(current.id); const parent = at.get(current.parentId); if (!parent || parent.kind === "workspace") break; d++; current = parent; }
    return d;
  };
  for (const n of data.nodes) depth.set(n.id, depthOf(n));
  const result = { ...positions };
  for (const node of [...data.nodes].sort((a, b) => depth.get(a.id)! - depth.get(b.id)!)) {
    const p = result[node.id]; if (node.kind === "workspace" || !p) continue;
    const parent = node.parentId ? at.get(node.parentId) : undefined, nested = !!parent && parent.kind !== "workspace";
    const anchor = result[nested ? parent!.id : workspaceNode(node.workspaceId)]; if (!anchor) continue;
    const limit = nested ? TETHER.parent : TETHER.workspace;
    const dx = p.x - anchor.x, dy = p.y - anchor.y, dz = p.z - anchor.z, distance = Math.hypot(dx, dy, dz);
    if (distance > limit) { const k = limit / distance; result[node.id] = { x: anchor.x + dx * k, y: anchor.y + dy * k, z: anchor.z + dz * k }; }
  }
  return result;
}

export function propertyGroup(node: MapNode, property?: MapProperty): string {
  if (!property || !node.databaseId) return node.kind === "workspace" ? node.title : "No value";
  const value = node.values[property.id];
  const options = property.config.options as { id: string; name: string }[] | undefined;
  if (value === null || value === undefined || value === "") return "No value";
  if (Array.isArray(value)) return value.map(v => options?.find(o => o.id === v)?.name ?? String(v)).join(", ") || "No value";
  return options?.find(o => o.id === value)?.name ?? String(value);
}

export function neighborhood(data: MapData, id: string, hops: number): Set<string> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of data.edges) {
    if (edge.source.startsWith("workspace:") || edge.target.startsWith("workspace:")) continue;
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)?.add(edge.target); adjacency.get(edge.target)?.add(edge.source);
  }
  const seen = new Set([id]); let frontier = [id];
  for (let depth = 0; depth < hops; depth++) { const next: string[] = []; for (const node of frontier) for (const other of adjacency.get(node) ?? []) if (!seen.has(other)) { seen.add(other); next.push(other); } frontier = next; }
  return seen;
}

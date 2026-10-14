export type NodeKind = "workspace" | "page" | "database" | "record" | "dashboard";
export type EdgeKind = "contains" | "membership" | "reference" | "relation";
export interface MapNode {
  id: string; workspaceId: string; parentId: string | null; title: string; kind: NodeKind;
  icon: string | null; favorite: boolean; archived: boolean; createdAt: string; updatedAt: string;
  count: number; recordId: string | null; databaseId: string | null; tags: string[]; values: Record<string, unknown>;
}
export interface MapEdge { id: string; source: string; target: string; kind: EdgeKind; label: string; propertyId: string | null; count: number }
export interface MapProperty { id: string; databaseId: string; name: string; kind: string; config: Record<string, unknown> }
export interface MapData { nodes: MapNode[]; edges: MapEdge[]; properties: MapProperty[]; totalNodes: number; truncated: boolean }
export interface MapQuery { workspaceIds: string[]; pageId?: string; hops?: number; search?: string; includeRecords?: boolean; limit?: number }
export type Layout = "clusters" | "hierarchy" | "organic" | "property" | "timeline";
export interface Position { x: number; y: number; z: number }
export interface CameraState { position: [number, number, number]; target: [number, number, number]; zoom: number }
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
    const anchor = { x: Math.cos(angle) * spread, y: Math.sin(angle) * spread };
    const seed = hash(node.id), theta = seed / 0xffffffff * Math.PI * 2, radius = 70 + ((seed >>> 9) % 180);
    let depth = 0, parent = node.parentId; const visited = new Set([node.id]);
    while (parent && at.has(parent) && !visited.has(parent)) { visited.add(parent); depth++; parent = at.get(parent)?.parentId ?? null; }
    const p = node.kind === "workspace" ? { x: anchor.x, y: anchor.y + 180, z: 0 }
      : { x: anchor.x + Math.cos(theta) * radius, y: anchor.y + Math.sin(theta) * radius, z: flat ? 0 : ((seed >>> 18) % 160) - 80 };
    if (layout === "hierarchy" && node.kind !== "workspace") { p.y = 80 - depth * 130; p.x = anchor.x + Math.cos(theta) * radius; }
    if (layout === "timeline" && node.kind !== "workspace") {
      const parsed = dateOf(node);
      const t = Number.isFinite(parsed) ? ((parsed - minDate) / Math.max(1, maxDate - minDate)) * 1000 - 500 : 650;
      if (flat) p.y = t; else p.z = t;
    }
    positions[node.id] = p;
  }
  return positions;
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

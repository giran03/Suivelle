import { neighborhood, workspaceNode, type MapData, type MapEdge, type MapNode, type MapQuery } from "../../src/features/node-map/model";
import type { Store } from "./seed";

/** Mirrors the read-only graph query; references come from sample content rather than invented links. */
export function nodeMapSnapshot(db: Store, input: MapQuery): MapData {
  const pages = db.pages.filter(p => !p.deletedAt);
  const all: MapNode[] = db.workspaces.map(w => ({ id: workspaceNode(w.id), workspaceId: w.id, parentId: null, title: w.name, kind: "workspace", icon: w.icon, count: pages.filter(p => p.workspaceId === w.id).length, favorite: false, archived: false, createdAt: w.createdAt, updatedAt: w.updatedAt, recordId: null, databaseId: null, tags: [], values: {} }));
  for (const p of pages) {
    const record = db.records.find(r => r.pageId === p.id || r.id === p.id);
    const blocks = db.blocks.filter(b => b.pageId === p.id);
    const tags = [...new Set<string>(blocks.flatMap(b => Array.from(b.dataJson.matchAll(/(?:^|[^\p{L}\p{N}#/&_])#(\p{L}[\p{L}\p{N}_\-/]*)/gu), (m: RegExpMatchArray) => m[1].toLowerCase())))];
    all.push({ ...p, parentId: p.parentPageId, count: 0, recordId: record?.id ?? null, databaseId: record?.databaseId ?? null, tags, values: record?.values ?? {} });
  }
  const edges: MapEdge[] = [];
  for (const n of all.filter(n=>n.kind!=="workspace")) if (!n.parentId || all.some(p=>p.id===n.parentId)) edges.push({id:`contains:${n.id}`,source:n.parentId??workspaceNode(n.workspaceId),target:n.id,kind:n.kind==="record"?"membership":"contains",label:n.kind==="record"?"Record of":"Contains",propertyId:null,count:1});
  const visit = (value: unknown, source: string) => {
    if (!value || typeof value !== "object") return;
    const v = value as { type?: string; attrs?: { pageId?: string; href?: string } };
    const target = v.type === "pageMention" ? v.attrs?.pageId : v.type === "link" && v.attrs?.href?.startsWith("suivelle://page/") ? v.attrs.href.slice(16) : null;
    if (target && target!==source && all.some(n=>n.id===target) && !edges.some(e=>e.kind==="reference"&&e.source===source&&e.target===target)) edges.push({id:`reference:${source}:${target}`,source,target,kind:"reference",label:"References",propertyId:null,count:1});
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(c=>visit(c,source)); else visit(child,source);
  };
  for (const block of db.blocks) { try {visit(JSON.parse(block.dataJson),block.pageId);} catch { /* Legacy sample block. */ } }
  const overview = !input.workspaceIds.length && !input.pageId && !input.search;
  let wanted = overview ? all.filter(n=>n.kind==="workspace") : all.filter(n=>n.kind!=="workspace" && (input.includeRecords || n.kind!=="record") && (!input.workspaceIds.length || input.workspaceIds.includes(n.workspaceId)) && (!input.search || n.title.toLowerCase().includes(input.search.toLowerCase())));
  if (input.pageId) {const seen=neighborhood({nodes:all,edges,properties:[],totalNodes:all.length,truncated:false},input.pageId,input.hops??1);wanted=wanted.filter(n=>seen.has(n.id));}
  const totalNodes=wanted.length;wanted=wanted.slice(0,input.limit??1000);
  const owners=new Set(wanted.map(n=>n.workspaceId));
  const nodes=overview?wanted:[...all.filter(n=>n.kind==="workspace"&&(!input.pageId||owners.has(n.workspaceId)||input.workspaceIds.includes(n.workspaceId))),...wanted];
  const ids=new Set(nodes.map(n=>n.id));const visible=edges.filter(e=>ids.has(e.source)&&ids.has(e.target));
  for(const edge of visible)for(const id of [edge.source,edge.target]) {const node=nodes.find(n=>n.id===id);if(node&&node.kind!=="workspace")node.count++;}
  return {nodes,edges:visible,properties:db.properties.map(p=>({...p,kind:p.type})),totalNodes,truncated:totalNodes>wanted.length};
}

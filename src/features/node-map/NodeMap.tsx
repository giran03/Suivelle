import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { Loading } from "../../components/Loading";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { PagePreview } from "../../types";
import { PageGlyph } from "../pages/PageGlyph";
import { usePeek } from "../peek/store";
import { propertyGroup, type Layout, type MapData, type MapNode, type CameraState } from "./model";
import type { CanvasApi, MapTool } from "./MapCanvas";
import { scopeKey, useNodeMap } from "./store";
import { usePositions } from "./usePositions";
import "./node-map.css";
const MapCanvas = lazy(() => import("./MapCanvas").then(m => ({ default: m.MapCanvas })));

export function NodeMap() {
  const scope = useNodeMap(s => s.scope), layout = useNodeMap(s => s.layout), flat = useNodeMap(s => s.flat), records = useNodeMap(s => s.records);
  const selected = useNodeMap(s => s.selected), pins = useNodeMap(s => s.pins), propertyId = useNodeMap(s => s.propertyId), refresh = useNodeMap(s => s.refresh);
  const workspaces = useWorkspace(s => s.workspaces), workspaceId = useWorkspace(s => s.workspace?.id), dataEpoch = useWorkspace(s => s.dataEpoch);
  const previous = useNodeMap(s => s.previous);
  const follow = useNodeMap(s => s.follow), bookmarks = useNodeMap(s => s.bookmarks);
  const activePage = useWorkspace(s => s.selectedPageId), peekPage = usePeek(s => s.pageId);
  const [bookmarkName,setBookmarkName]=useState("");
  const [data, setData] = useState<MapData | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(""), [query, setQuery] = useState(""), [limit, setLimit] = useState(1000), [asList, setAsList] = useState(false), [webglFailed, setWebglFailed] = useState(false);
  const [preview, setPreview] = useState<PagePreview | null>(null), [previewError, setPreviewError] = useState("");
  const [tool,setTool] = useState<MapTool>("navigate");
  const api = useRef<CanvasApi | null>(null);
  const key = scopeKey(scope, flat), cameras = useRef<Record<string, CameraState>>({});
  useEffect(() => { const timeout = setTimeout(() => setQuery(search.trim()), 200); return () => clearTimeout(timeout); }, [search]);
  const reload = useCallback(() => useNodeMap.setState(s => ({ refresh: s.refresh + 1 })), []);
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const schedule = () => { clearTimeout(timeout); timeout = setTimeout(reload, 150); };
    const stop = useWorkspace.subscribe((s,prev) => { if (s.children !== prev.children || s.workspaces !== prev.workspaces || s.pageTitles !== prev.pageTitles) schedule(); });
    window.addEventListener("focus", schedule); window.addEventListener("suivelle:graph-changed", schedule);
    return () => { stop(); clearTimeout(timeout); window.removeEventListener("focus", schedule); window.removeEventListener("suivelle:graph-changed", schedule); };
  }, [reload]);
  useEffect(() => {
    let alive = true; setBusy(true); setError("");
    void ipc.nodeMapSnapshot({ ...scope, ...(query ? { workspaceIds: [], pageId: undefined, search: query } : {}), includeRecords: records, limit }).then(result => {
      if (!alive) return; setData(result); setBusy(false);
    }, e => { if (alive) { setError(toAppError(e).message); setBusy(false); } });
    return () => { alive = false; };
  }, [scope,query,records,limit,refresh,dataEpoch]);
  const {positions,working:layoutWorking,failed:layoutFailed} = usePositions(data,layout,flat,propertyId,pins,`${key}:${propertyId}`);
  const propertyGroups = useMemo(()=>{const groups=new Map<string,number>();for(const n of data?.nodes??[])if(n.kind!=="workspace"){const group=propertyGroup(n,data?.properties.find(p=>p.id===propertyId));groups.set(group,(groups.get(group)??0)+1);}return [...groups].sort(([a],[b])=>a.localeCompare(b));},[data,propertyId]);
  useEffect(()=>{ const id=peekPage??activePage;if(follow && id && data?.nodes.some(n=>n.id===id)){useNodeMap.getState().select([id]);api.current?.focus(id);} },[follow,peekPage,activePage]);
  const node = data?.nodes.find(n => n.id === selected[0]);
  useEffect(() => {
    let alive = true;setPreview(null);setPreviewError("");
    if (node && node.kind !== "workspace") void ipc.pagePreview(node.id).then(p => { if (alive) setPreview(p); }, e => { if (alive) setPreviewError(toAppError(e).message); });
    return () => { alive = false; };
  }, [node?.id,node?.updatedAt]);
  const scopeTo = (workspaceIds: string[], pageId?: string, hops?: number) => { setSearch("");setQuery("");useNodeMap.getState().scopeTo({ workspaceIds, pageId, hops }); };
  const openNode = useCallback(async (n: MapNode, main = false) => {
    if (n.kind === "workspace") { setSearch("");setQuery("");useNodeMap.getState().scopeTo({ workspaceIds: [n.workspaceId] }); return; }
    try {
      if (main) await useWorkspace.getState().openPage(n.id);
      else {
        if (useWorkspace.getState().workspace?.id !== n.workspaceId) { await useWorkspace.getState().switchWorkspace(n.workspaceId);useWorkspace.setState({view:"node-map"}); }
        usePeek.getState().show(n.id);
      }
    } catch (e) { setError(toAppError(e).message); }
  }, []);
  const rememberCamera = useCallback((camera: CameraState) => { cameras.current[key] = camera; useNodeMap.getState().camera(key,camera); }, [key]);
  const initialCamera = useNodeMap.getState().cameras[key] ?? cameras.current[key];
  const relationships = data?.edges.filter(e => selected.includes(e.source) || selected.includes(e.target)) ?? [];
  const title = query ? `Results for “${query}”` : scope.pageId ? "Page neighborhood" : scope.workspaceIds.length ? workspaces.filter(w => scope.workspaceIds.includes(w.id)).map(w => w.name).join(", ") : "All workspaces";
  return <section className="node-map" aria-label="Node Map">
    <header className="map-header">
      <div className="map-heading"><h1>Node Map</h1><span>{title}</span></div>
      <div className="map-actions">
        <button type="button" className="btn ghost" disabled={!previous.length} onClick={() => { setSearch("");setQuery("");useNodeMap.getState().back(); }}><Icon name="back" />Back</button>
        <button type="button" className="btn ghost" onClick={() => scopeTo([])}>All workspaces</button>
        <button type="button" className="btn ghost" disabled={!workspaceId} onClick={() => scopeTo(workspaceId ? [workspaceId] : [])}>Current workspace</button>
      </div>
    </header>
    <div className="map-toolbar">
      <label className="map-search"><Icon name="search" size={16} /><input type="search" aria-label="Search pages in all workspaces" placeholder="Search all workspaces…" value={search} maxLength={200} onChange={e => setSearch(e.target.value)} /></label>
      <label>Layout<select value={layout} onChange={e => {const value=e.target.value as Layout;useNodeMap.getState().configure({layout:value,propertyId:"",...(["property","timeline"].includes(value)?{records:true}:{})});}}><option value="clusters">Workspace clusters</option><option value="hierarchy">Hierarchy</option><option value="organic">Organic links</option><option value="property">Property groups</option><option value="timeline">Timeline</option></select></label>
      {["property","timeline"].includes(layout) && <label>{layout==="timeline"?"Date":"Group by"}<select value={propertyId} onChange={e=>useNodeMap.getState().configure({propertyId:e.target.value})}><option value="">{layout==="timeline"?"Creation date":"Choose a property"}</option>{data?.properties.filter(p=>layout==="timeline"?p.kind==="date":["status","select","multi_select","text","checkbox"].includes(p.kind)).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      <button type="button" className="btn ghost" aria-pressed={flat} onClick={() => useNodeMap.getState().configure({flat:!flat})}>{flat ? "2D" : "3D"}</button>
      <button type="button" className="btn ghost" aria-pressed={asList} onClick={() => setAsList(!asList)}>{asList ? "Show map" : "Show list"}</button>
      <label className="map-check"><input type="checkbox" checked={records} onChange={e => useNodeMap.getState().configure({records:e.target.checked})} />Records</label>
      <button type="button" className="btn ghost" onClick={() => api.current?.fit()} disabled={asList || webglFailed}>Fit view</button>
      <button type="button" className="btn ghost" disabled={busy} onClick={reload}>Refresh</button>
    </div>
    <div className="map-toolbar map-explore-tools">
      <label>Tool<select value={tool} onChange={e=>setTool(e.target.value as MapTool)}><option value="navigate">Navigate</option><option value="move">Move and pin</option><option value="select">Box select</option></select></label>
      <label className="map-check"><input type="checkbox" checked={follow} onChange={e=>useNodeMap.getState().configure({follow:e.target.checked})}/>Follow active page</label>
      <button type="button" className="btn ghost" disabled={!activePage} onClick={()=>{if(activePage&&workspaceId)scopeTo([workspaceId],activePage,1);}}>Return to active page</button>
      <label>Saved view<select aria-label="Restore saved view" value="" onChange={e=>useNodeMap.getState().restore(e.target.value)}><option value="">Choose…</option>{bookmarks.map(b=><option key={b.name} value={b.name}>{b.name}</option>)}</select></label>
      <input className="map-bookmark-name" aria-label="Saved view name" placeholder="Name this view…" maxLength={80} value={bookmarkName} onChange={e=>setBookmarkName(e.target.value)} />
      <button type="button" className="btn ghost" disabled={!bookmarkName.trim()} onClick={()=>{useNodeMap.getState().save(bookmarkName,key);setBookmarkName("");}}>Save view</button>
    </div>
    {layoutFailed && <p className="map-notice" role="status">Organic layout could not run. Showing the stable cluster layout; choose another layout or refresh.</p>}
    {layout==="timeline" && <p className="map-notice">Time runs {flat?"from top to bottom":"along the depth axis"}; oldest to newest. Items without a date sit beyond the newest items.</p>}
    {layout==="property" && <div className="map-notice" aria-label="Property groups">{propertyGroups.map(([name,count])=><span key={name}>{name} · {count}</span>)}</div>}
    {tool!=="navigate" && <p className="map-notice">{tool==="move"?"Drag a node in the camera plane to pin its position. Unpin it from its details.":"Drag a box around visible nodes to select them. Ctrl+click adds or removes a node."}</p>}
    {error && <p className="map-notice field-error" role="alert">{error} <button className="btn ghost" type="button" onClick={reload}>Retry</button></p>}
    {data?.truncated && <div className="map-notice" role="status">Showing a bounded selection of {data.totalNodes.toLocaleString()} matching pages. Narrow the scope or search.{limit < 5000 && <button type="button" className="btn ghost" onClick={() => setLimit(5000)}>Show up to 5,000</button>}</div>}
    {webglFailed && <p className="map-notice" role="status">3D rendering is unavailable. The list provides the same navigation.</p>}
    <div className="map-body" aria-busy={busy}>
      <div className="map-stage">
        {busy ? <Loading label="Loading map…" /> : !data || !data.nodes.length ? <p className="empty">No pages match. Try another search or workspace.</p> : asList || webglFailed ?
          <ul className="map-list" aria-label="Map nodes">{data.nodes.map(n => <li key={n.id}><button type="button" aria-pressed={selected.includes(n.id)} onClick={() => useNodeMap.getState().select([n.id])} onDoubleClick={() => void openNode(n)}><PageGlyph page={{icon:n.icon,kind:n.kind === "workspace" ? "page" : n.kind}} /><span>{n.title || "Untitled"}</span><small>{n.kind === "workspace" ? `${n.count} pages` : `${workspaces.find(w=>w.id===n.workspaceId)?.name ?? "Workspace"} · ${n.kind}`}</small></button><button type="button" className="btn ghost" aria-label={`Open ${n.title || "Untitled"}`} onClick={() => void openNode(n)}>Open</button></li>)}</ul>
          : <Suspense fallback={<Loading label="Loading renderer…" />}><MapCanvas data={data} positions={positions} flat={flat} selected={selected} tool={tool} initialCamera={initialCamera} api={api} onSelect={ids => useNodeMap.getState().select(ids)} onOpen={n => void openNode(n)} onPin={(id,p) => useNodeMap.getState().pin(id,p)} onConnect={() => {}} onCamera={rememberCamera} onError={() => setWebglFailed(true)} /></Suspense>}
        <div className="map-legend" aria-label="Relationship legend"><span>Solid: contains / record of</span><span>Dashed: references</span><span>Arrow: direction</span></div>
      </div>
      <aside className="map-inspector" aria-label="Selected node">
        {node ? <>
          <small>{node.kind}</small><h2>{node.title || "Untitled"}</h2>
          <p>{workspaces.find(w=>w.id===node.workspaceId)?.name}</p>
          <div className="map-inspector-actions"><button type="button" className="btn primary" onClick={() => void openNode(node)}>{node.kind === "workspace" ? "Explore workspace" : "Open beside"}</button>{node.kind !== "workspace" && <button type="button" className="btn ghost" onClick={() => void openNode(node,true)}>Open in main view</button>}</div>
          {node.kind !== "workspace" && <button type="button" className="btn ghost" onClick={() => scopeTo([node.workspaceId],node.id,1)}>Show neighborhood</button>}
          {node.kind==="workspace" && !scope.workspaceIds.includes(node.workspaceId) && scope.workspaceIds.length>0 && <button type="button" className="btn ghost" onClick={()=>scopeTo([...scope.workspaceIds,node.workspaceId])}>Expand alongside</button>}
          {pins[node.id] && <button type="button" className="btn ghost" onClick={()=>useNodeMap.getState().pin(node.id,null)}>Unpin position</button>}
          {node.tags.length>0 && <p>{node.tags.map(tag=>`#${tag}`).join(" · ")}</p>}
          {scope.pageId && <label>Neighborhood depth<select value={scope.hops ?? 1} onChange={e => scopeTo(scope.workspaceIds,scope.pageId,Number(e.target.value))}><option value={1}>1 hop</option><option value={2}>2 hops</option><option value={3}>3 hops</option></select></label>}
          {node.kind === "workspace" ? <p>{node.count.toLocaleString()} pages and records</p> : previewError ? <p className="field-error">{previewError}</p> : preview ? <div className="map-preview">{preview.lines.slice(0,4).map((line,i)=><p key={i}>{line.text}</p>)}{!preview.lines.length && <p>No text preview</p>}</div> : <p role="status">Loading preview…</p>}
          <h3>Connections</h3><ul className="map-connections">{relationships.slice(0,40).map(edge => {const other=data!.nodes.find(n=>n.id===(edge.source===node.id?edge.target:edge.source));return other && <li key={edge.id}><button type="button" onClick={()=>{useNodeMap.getState().select([other.id]);api.current?.focus(other.id);}}><span>{edge.source===node.id ? "→" : "←"} {other.title || "Untitled"}</span><small>{edge.label}{edge.count>1?` (${edge.count})`:""}</small></button></li>;})}</ul>
        </> : <><h2>Explore your workspace</h2><p>Select a node to see its preview and connections. Double-click to open it beside the map.</p><p>Drag to orbit. Scroll to zoom. Home fits the view. The list supports keyboard navigation.</p></>}
      </aside>
    </div>
    <footer className="map-status" role="status">{busy ? "Loading…" : `${data?.nodes.length ?? 0} nodes · ${data?.edges.length ?? 0} connections`}{selected.length>1 && ` · ${selected.length} selected`}{layoutWorking && " · Settling layout…"}</footer>
  </section>;
}

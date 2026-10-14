import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { Loading } from "../../components/Loading";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { PagePreview } from "../../types";
import { PageGlyph } from "../pages/PageGlyph";
import { usePeek } from "../peek/store";
import { coordinates, type Layout, type MapData, type MapNode, type CameraState } from "./model";
import type { CanvasApi, MapTool } from "./MapCanvas";
import { scopeKey, useNodeMap } from "./store";
import "./node-map.css";
const MapCanvas = lazy(() => import("./MapCanvas").then(m => ({ default: m.MapCanvas })));

export function NodeMap() {
  const scope = useNodeMap(s => s.scope), layout = useNodeMap(s => s.layout), flat = useNodeMap(s => s.flat), records = useNodeMap(s => s.records);
  const selected = useNodeMap(s => s.selected), pins = useNodeMap(s => s.pins), propertyId = useNodeMap(s => s.propertyId), refresh = useNodeMap(s => s.refresh);
  const workspaces = useWorkspace(s => s.workspaces), workspaceId = useWorkspace(s => s.workspace?.id), dataEpoch = useWorkspace(s => s.dataEpoch);
  const previous = useNodeMap(s => s.previous);
  const [data, setData] = useState<MapData | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(""), [query, setQuery] = useState(""), [limit, setLimit] = useState(1000), [asList, setAsList] = useState(false), [webglFailed, setWebglFailed] = useState(false);
  const [preview, setPreview] = useState<PagePreview | null>(null), [previewError, setPreviewError] = useState("");
  const [tool] = useState<MapTool>("navigate");
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
  const positions = useMemo(() => data ? coordinates(data, layout, flat, propertyId, pins) : {}, [data,layout,flat,propertyId,pins]);
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
  const initialCamera = cameras.current[key] ?? useNodeMap.getState().cameras[key];
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
      <label>Layout<select value={layout} onChange={e => useNodeMap.getState().configure({layout:e.target.value as Layout})}><option value="clusters">Workspace clusters</option><option value="hierarchy">Hierarchy</option></select></label>
      <button type="button" className="btn ghost" aria-pressed={flat} onClick={() => useNodeMap.getState().configure({flat:!flat})}>{flat ? "2D" : "3D"}</button>
      <button type="button" className="btn ghost" aria-pressed={asList} onClick={() => setAsList(!asList)}>{asList ? "Show map" : "Show list"}</button>
      <label className="map-check"><input type="checkbox" checked={records} onChange={e => useNodeMap.getState().configure({records:e.target.checked})} />Records</label>
      <button type="button" className="btn ghost" onClick={() => api.current?.fit()} disabled={asList || webglFailed}>Fit view</button>
      <button type="button" className="btn ghost" disabled={busy} onClick={reload}>Refresh</button>
    </div>
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
          {scope.pageId && <label>Neighborhood depth<select value={scope.hops ?? 1} onChange={e => scopeTo(scope.workspaceIds,scope.pageId,Number(e.target.value))}><option value={1}>1 hop</option><option value={2}>2 hops</option><option value={3}>3 hops</option></select></label>}
          {node.kind === "workspace" ? <p>{node.count.toLocaleString()} pages and records</p> : previewError ? <p className="field-error">{previewError}</p> : preview ? <div className="map-preview">{preview.lines.slice(0,4).map((line,i)=><p key={i}>{line.text}</p>)}{!preview.lines.length && <p>No text preview</p>}</div> : <p role="status">Loading preview…</p>}
          <h3>Connections</h3><ul className="map-connections">{relationships.slice(0,40).map(edge => {const other=data!.nodes.find(n=>n.id===(edge.source===node.id?edge.target:edge.source));return other && <li key={edge.id}><button type="button" onClick={()=>{useNodeMap.getState().select([other.id]);api.current?.focus(other.id);}}><span>{edge.source===node.id ? "→" : "←"} {other.title || "Untitled"}</span><small>{edge.label}{edge.count>1?` (${edge.count})`:""}</small></button></li>;})}</ul>
        </> : <><h2>Explore your workspace</h2><p>Select a node to see its preview and connections. Double-click to open it beside the map.</p><p>Drag to orbit. Scroll to zoom. Home fits the view. The list supports keyboard navigation.</p></>}
      </aside>
    </div>
    <footer className="map-status" role="status">{busy ? "Loading…" : `${data?.nodes.length ?? 0} nodes · ${data?.edges.length ?? 0} connections`}{selected.length>1 && ` · ${selected.length} selected`}</footer>
  </section>;
}

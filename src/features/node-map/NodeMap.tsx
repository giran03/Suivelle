import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { Loading } from "../../components/Loading";
import { Popover, anchorOf, type Anchor } from "../../components/Popover";
import { ipc, toAppError } from "../../lib/ipc";
import { READ_ONLY } from "../../lib/access";
import { thumbUrl } from "../../lib/attachments";
import { useWorkspace } from "../../stores/workspace";
import type { PagePreview, Workspace } from "../../types";
import { usePeek } from "../peek/store";
import { useShortcutScope } from "../shortcuts/runtime";
import { useShortcut } from "../shortcuts/useShortcut";
import { workspaceColor, workspaceOptions } from "../workspaces/model";
import { NODE_COLORS, propertyGroup, workspaceNode, type CameraState, type EdgeKind, type Layout, type MapData, type MapEdge, type MapNode } from "./model";
import type { OrbitState } from "./orbit";
import type { CanvasApi, MapTool, StepDirection } from "./MapCanvas";
import { scopeKey, useNodeMap, type Scope } from "./store";
import { usePositions } from "./usePositions";
import { MapEdits, MapHistory } from "./MapEdits";
import { MapList } from "./MapList";
import { useNodePalette } from "./useNodePalette";
import { nodeTones } from "./colors";
import "./node-map.css";
const MapCanvas = lazy(() => import("./MapCanvas").then(m => ({ default: m.MapCanvas })));

const LAYOUTS: { id: Layout; name: string; hint: string }[] = [
  { id: "clusters", name: "Workspace clusters", hint: "Each workspace gathers its pages around it." },
  { id: "hierarchy", name: "Hierarchy", hint: "Nesting depth runs from top to bottom." },
  { id: "organic", name: "Organic links", hint: "Connected pages pull together." },
  { id: "property", name: "Property groups", hint: "Records cluster by a property value." },
  { id: "timeline", name: "Timeline", hint: "Oldest to newest along one axis." },
];
const EDGES: { kind: EdgeKind; name: string; dashed?: boolean; strong?: boolean }[] = [
  { kind: "contains", name: "Contains" }, { kind: "membership", name: "Record of" }, { kind: "reference", name: "References", dashed: true },
  { kind: "relation", name: "Relations", strong: true }, { kind: "dependency", name: "Dependencies", strong: true },
];
const TOOLS: { id: MapTool; name: string; icon: IconName; shortcut: string; hint: string }[] = [
  { id: "navigate", name: "Navigate", icon: "cursor", shortcut: "map-tool-navigate", hint: "" },
  { id: "move", name: "Move and pin", icon: "move", shortcut: "map-tool-move", hint: "Drag a node to pin it. Unpin it from its details." },
  { id: "select", name: "Box select", icon: "marquee", shortcut: "map-tool-select", hint: "Drag a box around nodes. Ctrl+click adds or removes one." },
  { id: "connect", name: "Connect", icon: "connect", shortcut: "map-tool-connect", hint: "Drag from one node to another, then apply the connection in the details." },
];
const typing = (target: Element) => !!target.closest("input, textarea, select, [contenteditable='true'], [data-popover]");
const mergeData = (base: MapData, ...extras: (MapData | null)[]): MapData => {
  const nodes = new Map(base.nodes.map(n => [n.id, n])), edges = new Map(base.edges.map(e => [e.id, e])), properties = new Map(base.properties.map(p => [p.id, p]));
  let added = false;
  for (const extra of extras) if (extra) {
    for (const n of extra.nodes) if (!nodes.has(n.id)) { nodes.set(n.id, n); added = true; }
    for (const e of extra.edges) if (!edges.has(e.id)) { edges.set(e.id, e); added = true; }
    for (const p of extra.properties) if (!properties.has(p.id)) { properties.set(p.id, p); added = true; }
  }
  return added ? { ...base, nodes: [...nodes.values()], edges: [...edges.values()], properties: [...properties.values()] } : base;
};

/** Refreshes (window focus, graph events) usually return the same graph; keeping the old object skips a rebuild. */
const unchanged = (next: MapData) => (prev: MapData | null) => prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;

/** A CSS colour (such as a theme variable) as the browser resolves it, for the WebGL renderer. */
function resolveColor(css: string): string {
  const probe = document.createElement("span");
  probe.style.color = css;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || "#888";
}

function IconButton({ icon, label, shortcut, pressed, disabled, onClick, className = "" }: { icon: IconName; label: string; shortcut?: string; pressed?: boolean; disabled?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; className?: string }) {
  const keys = useShortcut(shortcut ?? "");
  const hint = shortcut && keys.label ? `${label} (${keys.label})` : label;
  return <button type="button" className={`map-icon-btn ${className}`} aria-label={label} title={hint} aria-pressed={pressed} aria-keyshortcuts={shortcut ? keys.aria : undefined} disabled={disabled} onClick={onClick}><Icon name={icon} /></button>;
}

function ToolButton({ tool, active, onSelect }: { tool: (typeof TOOLS)[number]; active: boolean; onSelect: () => void }) {
  const keys = useShortcut(tool.shortcut);
  return <button type="button" role="radio" aria-checked={active} className="map-icon-btn" aria-label={tool.name} title={keys.label ? `${tool.name} (${keys.label})` : tool.name} aria-keyshortcuts={keys.aria} onClick={onSelect}><Icon name={tool.icon} /></button>;
}

/**
 * Workspace chips that never scroll or wrap: as many as fit are shown, the rest fold into a `+N` chip
 * that opens a list. The focused workspace always stays on the bar. A hidden copy measures each chip.
 */
function WorkspaceChips({ workspaces, colors, focusedId, hidden, onChip }: { workspaces: Workspace[]; colors: Record<string, string>; focusedId: string | null; hidden: string[]; onChip: (id: string, alt: boolean) => void }) {
  const bar = useRef<HTMLDivElement>(null), measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(workspaces.length), [more, setMore] = useState<Anchor | null>(null);
  useLayoutEffect(() => {
    const box = bar.current, ruler = measure.current; if (!box || !ruler) return;
    const compute = () => {
      const room = box.clientWidth, gap = 4, chips = [...ruler.children] as HTMLElement[];
      const widths = chips.slice(0, -1).map(c => c.offsetWidth), plus = chips[chips.length - 1]?.offsetWidth ?? 48;
      let used = 0, count = 0;
      for (let i = 0; i < widths.length; i++) {
        const next = used + (i ? gap : 0) + widths[i], reserve = i < widths.length - 1 ? gap + plus : 0;
        if (next + reserve > room) break; used = next; count = i + 1;
      }
      setFit(count);
    };
    compute(); const observer = new ResizeObserver(compute); observer.observe(box); return () => observer.disconnect();
  }, [workspaces]);
  let shown = workspaces.slice(0, fit);
  const focused = workspaces.find(w => w.id === focusedId);
  if (focused && !shown.includes(focused)) shown = fit ? [...shown.slice(0, fit - 1), focused] : [focused];
  const overflow = workspaces.filter(w => !shown.includes(w));
  const chip = (w: Workspace, measuring = false) => {
    const off = hidden.includes(w.id), pressed = w.id === focusedId;
    return <button key={w.id} type="button" className="map-chip" tabIndex={measuring ? -1 : undefined} aria-pressed={pressed} data-hidden={off || undefined} title={`${off ? "Hidden. " : ""}Click to ${pressed ? "show all workspaces" : "focus"}, Alt+click to ${off ? "show" : "hide"}`} onClick={e => onChip(w.id, e.altKey)}>
      <span className="map-chip-dot" style={{ background: colors[w.id] }} />{w.name}</button>;
  };
  return <div className="map-chips" ref={bar} role="group" aria-label="Workspaces. Click to focus, Alt+click to hide or show.">
    {shown.map(w => chip(w))}
    {overflow.length > 0 && <button type="button" className="map-chip map-chip-more" aria-haspopup="dialog" aria-expanded={!!more} aria-label={`${overflow.length} more workspaces`} title={overflow.map(w => w.name).join(", ")} onClick={e => { const anchor = anchorOf(e.currentTarget); setMore(m => m ? null : anchor); }}>+{overflow.length}</button>}
    <div className="map-chips-measure" ref={measure} aria-hidden="true">{workspaces.map(w => chip(w, true))}<span className="map-chip map-chip-more">+{workspaces.length}</span></div>
    {more && overflow.length > 0 && <Popover anchor={more} onClose={() => setMore(null)} label="More workspaces" className="map-popover">
      <div className="map-pop-section" role="group" aria-label="More workspaces">
        {overflow.map(w => { const off = hidden.includes(w.id);
          return <button key={w.id} type="button" className="map-pop-option map-pop-workspace" data-hidden={off || undefined} title={`${off ? "Hidden. " : ""}Click to focus, Alt+click to ${off ? "show" : "hide"}`} onClick={e => { onChip(w.id, e.altKey); if (!e.altKey) setMore(null); }}>
            <span className="map-chip-dot" style={{ background: colors[w.id] }} /><span><strong>{w.name}</strong>{off && <small>Hidden</small>}</span></button>; })}
      </div>
    </Popover>}
  </div>;
}

export function NodeMap() {
  const autoOrbit = useNodeMap(s => s.autoOrbit);
  const [orbitState, setOrbitState] = useState<OrbitState>("paused");
  const nodePalettes = useNodePalette();
  const scope = useNodeMap(s => s.scope), layout = useNodeMap(s => s.layout), flat = useNodeMap(s => s.flat), records = useNodeMap(s => s.records);
  const selected = useNodeMap(s => s.selected), pins = useNodeMap(s => s.pins), propertyId = useNodeMap(s => s.propertyId), refresh = useNodeMap(s => s.refresh);
  const showAll = useNodeMap(s => s.showAll), showLabels = useNodeMap(s => s.labels), hiddenEdges = useNodeMap(s => s.hiddenEdges), hiddenWorkspaces = useNodeMap(s => s.hiddenWorkspaces), inspectorOpen = useNodeMap(s => s.inspector);
  const workspaces = useWorkspace(s => s.workspaces), dataEpoch = useWorkspace(s => s.dataEpoch);
  const workspaceColors = useMemo(() => Object.fromEntries(workspaces.map(w => [w.id, workspaceColor(workspaceOptions(w).accent)])), [workspaces]);
  const workspaceNames = useMemo(() => Object.fromEntries(workspaces.map(w => [w.id, w.name])), [workspaces]);
  const follow = useNodeMap(s => s.follow), bookmarks = useNodeMap(s => s.bookmarks);
  const activePage = useWorkspace(s => s.selectedPageId), peekPage = usePeek(s => s.pageId);
  const dependencyProperties = useNodeMap(s => s.dependencyProperties);
  const [pair, setPair] = useState<[string, string] | null>(null);
  const [universe, setUniverse] = useState<MapData | null>(null), [scoped, setScoped] = useState<MapData | null>(null), [found, setFound] = useState<MapData | null>(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(0), [searching, setSearching] = useState(false);
  const [search, setSearch] = useState(""), [query, setQuery] = useState(""), [match, setMatch] = useState(0), [limit, setLimit] = useState(1000), [asList, setAsList] = useState(false), [webglFailed, setWebglFailed] = useState(false);
  const [preview, setPreview] = useState<PagePreview | null>(null), [previewError, setPreviewError] = useState("");
  const [tool, setTool] = useState<MapTool>("navigate"), [zoom, setZoom] = useState(100);
  const [popover, setPopover] = useState<{ kind: "layout" | "views" | "layers"; anchor: Anchor } | null>(null);
  const [viewName, setViewName] = useState("");
  const api = useRef<CanvasApi | null>(null), section = useRef<HTMLElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const key = scopeKey(scope, flat), cameras = useRef<Record<string, CameraState>>({});
  const allWorkspaces = useMemo(() => workspaces.map(w => w.id).slice(0, 64), [workspaces]);
  const global = !scope.pageId && !scope.workspaceIds.length;
  useEffect(() => { const timeout = setTimeout(() => setQuery(search.trim()), 200); return () => clearTimeout(timeout); }, [search]);
  const reload = useCallback(() => useNodeMap.setState(s => ({ refresh: s.refresh + 1 })), []);
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const schedule = () => { clearTimeout(timeout); timeout = setTimeout(reload, 150); };
    const stop = useWorkspace.subscribe((s,prev) => { if (s.children !== prev.children || s.workspaces !== prev.workspaces || s.pageTitles !== prev.pageTitles) schedule(); });
    window.addEventListener("focus", schedule); window.addEventListener("suivelle:graph-changed", schedule);
    return () => { stop(); clearTimeout(timeout); window.removeEventListener("focus", schedule); window.removeEventListener("suivelle:graph-changed", schedule); };
  }, [reload]);
  // The universe: every page of every workspace, bounded. Scope never filters it; it only sets the focus.
  useEffect(() => {
    if (!allWorkspaces.length) return;
    let alive = true; setLoading(n => n + 1); setError("");
    void ipc.nodeMapSnapshot({ workspaceIds: allWorkspaces, includeRecords: records, limit }).then(result => { if (alive) setUniverse(unchanged(result)); }, e => { if (alive) setError(toAppError(e).message); }).finally(() => setLoading(n => n - 1));
    return () => { alive = false; };
  }, [allWorkspaces, records, limit, refresh, dataEpoch]);
  // The focus, fetched on its own so it is complete even when the universe is truncated; missing nodes merge in.
  useEffect(() => {
    if (global) { setScoped(null); return; }
    let alive = true; setLoading(n => n + 1);
    void ipc.nodeMapSnapshot({ ...scope, includeRecords: records, limit }).then(result => { if (alive) setScoped(unchanged(result)); }, e => { if (alive) setError(toAppError(e).message); }).finally(() => setLoading(n => n - 1));
    return () => { alive = false; };
  }, [scope, global, records, limit, refresh, dataEpoch]);
  // Search highlights in place: matches light up and the camera visits them.
  useEffect(() => {
    if (!query) { setFound(null); setSearching(false); return; }
    let alive = true; setSearching(true);
    void ipc.nodeMapSnapshot({ workspaceIds: [], search: query, includeRecords: records, limit: 300 }).then(result => { if (alive) { setFound(unchanged(result)); setMatch(0); setSearching(false); } }, e => { if (alive) { setError(toAppError(e).message); setSearching(false); } });
    return () => { alive = false; };
  }, [query, records, refresh, dataEpoch]);
  const data = useMemo(() => universe ? mergeData(universe, scoped, found) : null, [universe, scoped, found]);
  const {positions, working: layoutWorking, failed: layoutFailed} = usePositions(data, layout, flat, propertyId, pins, `${key}:${propertyId}`);
  const displayData = useMemo(() => data ? {...data, edges: data.edges.map(e => e.kind === "relation" && e.propertyId && dependencyProperties.includes(e.propertyId) ? {...e, kind: "dependency" as const, label: `Blocks · ${e.label}`} : e)} : null, [data, dependencyProperties]);
  const at = useMemo(() => new Map((data?.nodes ?? []).map(n => [n.id, n])), [data]);
  const baseTones = useMemo(() => nodeTones(data?.nodes ?? [], nodePalettes), [data, nodePalettes]);
  // The agent lens greys out everything people made, so agent-created pages stand out.
  const [agentLens, setAgentLens] = useState(false);
  const agentPages = useMemo(() => (data?.nodes ?? []).filter(n => n.createdBy).length, [data]);
  const tones = useMemo(() => {
    if (!agentLens) return baseTones;
    const dim = resolveColor("var(--tone-gray)");
    const out = { ...baseTones };
    for (const n of data?.nodes ?? []) if (n.kind !== "workspace" && !n.createdBy) out[n.id] = dim;
    return out;
  }, [agentLens, baseTones, data]);
  const matches = useMemo(() => (found?.nodes ?? []).filter(n => n.kind !== "workspace" && at.has(n.id)).sort((a, b) => (a.title || "Untitled").localeCompare(b.title || "Untitled")), [found, at]);
  const scopeFocus = useMemo(() => {
    if (global || !data) return null;
    const ids = scope.pageId ? (scoped?.nodes ?? []).filter(n => n.kind !== "workspace").map(n => n.id) : data.nodes.filter(n => scope.workspaceIds.includes(n.workspaceId)).map(n => n.id);
    if (!ids.length) return null;
    const set = new Set(ids); for (const id of ids) { const n = at.get(id); if (n) set.add(workspaceNode(n.workspaceId)); }
    return set;
  }, [global, data, scope, scoped, at]);
  const focus = useMemo(() => matches.length ? new Set([...matches.map(n => n.id), ...matches.map(n => workspaceNode(n.workspaceId))]) : scopeFocus, [matches, scopeFocus]);
  const focusKey = matches.length ? `search:${query}:${matches.length}` : scopeFocus ? key : "";
  // Fly to a new focus once its nodes have positions.
  const framed = useRef("");
  useEffect(() => {
    if (!focusKey) { framed.current = ""; return; }
    if (framed.current === focusKey || !focus || asList) return;
    const ids = [...focus].filter(id => positions[id]);
    if (ids.length && api.current) { framed.current = focusKey; api.current.frame(ids); }
  }, [focusKey, focus, positions, asList]);
  useEffect(() => { const id = peekPage ?? activePage; if (follow && id) { useNodeMap.getState().select([id]); if (at.has(id)) api.current?.focus(id); else useNodeMap.getState().scopeTo({ workspaceIds: [], pageId: id, hops: 1 }); } }, [follow, peekPage, activePage]);
  const node = at.get(selected[0]);
  useEffect(() => {
    let alive = true; setPreview(null); setPreviewError("");
    if (node && node.kind !== "workspace") void ipc.pagePreview(node.id).then(p => { if (alive) setPreview(p); }, e => { if (alive) setPreviewError(toAppError(e).message); });
    return () => { alive = false; };
  }, [node?.id, node?.updatedAt]);

  const scopeTo = useCallback((next: Scope) => { useNodeMap.getState().scopeTo(next); }, []);
  const parentScope = (): Scope | null => {
    if (scope.pageId) { const ws = at.get(scope.pageId)?.workspaceId; return { workspaceIds: ws ? [ws] : [] }; }
    return scope.workspaceIds.length ? { workspaceIds: [] } : null;
  };
  const stepOut = () => { const parent = parentScope(); if (parent) scopeTo(parent); };
  const dive = useCallback((n: MapNode) => {
    if (n.kind === "workspace") scopeTo({ workspaceIds: [n.workspaceId] });
    else scopeTo({ workspaceIds: [], pageId: n.id, hops: useNodeMap.getState().scope.hops ?? 1 });
    setSearch(""); setQuery("");
  }, [scopeTo]);
  const openNode = useCallback(async (n: MapNode, main = false) => {
    if (n.kind === "workspace") { dive(n); return; }
    try {
      if (main) await useWorkspace.getState().openPage(n.id);
      else {
        if (useWorkspace.getState().workspace?.id !== n.workspaceId) { await useWorkspace.getState().switchWorkspace(n.workspaceId); useWorkspace.setState({ view: "node-map" }); }
        usePeek.getState().show(n.id);
      }
    } catch (e) { setError(toAppError(e).message); }
  }, [dive]);
  const selectAndShow = (id: string) => { useNodeMap.getState().select([id]); api.current?.focus(id); };
  const cycle = (delta: number) => { if (!matches.length) return; const next = (match + delta + matches.length) % matches.length; setMatch(next); selectAndShow(matches[next].id); };
  const configure = useNodeMap.getState().configure;
  const toggleFlat = (next: boolean) => { setWebglFailed(false); if (next !== flat) configure({ flat: next }); };
  const toggleList = () => { setWebglFailed(false); setAsList(v => !v); };
  const followActive = () => {
    if (follow) { configure({ follow: false }); return; }
    configure({ follow: true, ...(useWorkspace.getState().selectedPage?.kind === "record" ? { records: true } : {}) });
  };
  useShortcutScope(section, "map", {
    "map-search": target => { if (typing(target)) return false; searchInput.current?.focus(); searchInput.current?.select(); },
    "map-fit": target => { if (typing(target) || asList) return false; api.current?.fit(); },
    "map-dive": target => { if (!target.closest(".map-canvas") || !node) return false; dive(node); },
    "map-out": target => { if (typing(target) || !parentScope()) return false; stepOut(); },
    "map-open": target => { if (typing(target) || !node) return false; void openNode(node); },
    "map-open-main": target => { if (typing(target) || !node || node.kind === "workspace") return false; void openNode(node, true); },
    "map-2d": target => { if (typing(target)) return false; toggleFlat(true); },
    "map-3d": target => { if (typing(target)) return false; toggleFlat(false); },
    "map-show-all": target => { if (typing(target)) return false; configure({ showAll: !showAll }); },
    "map-list": target => { if (typing(target)) return false; toggleList(); },
    ...Object.fromEntries(TOOLS.filter(t => t.id !== "connect" || !READ_ONLY).map(t => [t.shortcut, (target: Element) => { if (typing(target)) return false; setTool(t.id); }])),
  });
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as Element;
    if (e.defaultPrevented || typing(target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      if (selected.length) useNodeMap.getState().select([]); else if (parentScope()) stepOut(); else return;
      e.preventDefault(); return;
    }
    const direction = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as Record<string, StepDirection>)[e.key];
    if (direction && target.closest(".map-canvas") && selected[0]) { e.preventDefault(); const next = api.current?.step(selected[0], direction); if (next) selectAndShow(next); }
  };
  const rememberCamera = useCallback((camera: CameraState) => { cameras.current[key] = camera; useNodeMap.getState().camera(key, camera); }, [key]);
  const initialCamera = useNodeMap.getState().cameras[key] ?? cameras.current[key];
  const open = (kind: "layout" | "views" | "layers") => (e: React.MouseEvent<HTMLButtonElement>) => { const anchor = anchorOf(e.currentTarget); setPopover(p => p?.kind === kind ? null : { kind, anchor }); };
  const relationships = displayData?.edges.filter(e => node && (e.source === node.id || e.target === node.id)) ?? [];
  const grouped = EDGES.map(g => ({ ...g, edges: relationships.filter(e => e.kind === g.kind) })).filter(g => g.edges.length);
  const propertyGroups = useMemo(() => { const groups = new Map<string, number>(); for (const n of data?.nodes ?? []) if (n.kind !== "workspace") { const group = propertyGroup(n, data?.properties.find(p => p.id === propertyId)); groups.set(group, (groups.get(group) ?? 0) + 1); } return [...groups].sort(([a], [b]) => a.localeCompare(b)); }, [data, propertyId]);
  const visibleCount = useMemo(() => (data?.nodes ?? []).filter(n => !hiddenWorkspaces.includes(n.workspaceId) && (focus ? focus.has(n.id) || showAll : showAll || n.kind === "workspace")).length, [data, focus, showAll, hiddenWorkspaces]);
  const pageCrumb = scope.pageId ? at.get(scope.pageId) : undefined;
  const crumbWorkspace = pageCrumb?.workspaceId ?? (scope.workspaceIds.length === 1 ? scope.workspaceIds[0] : undefined);
  const activeTool = TOOLS.find(t => t.id === tool)!;
  const firstLoad = !universe && !error;
  const canvasOff = asList || webglFailed;
  const empty = !!data && !data.nodes.some(n => n.kind !== "workspace");

  return <section ref={section} className="node-map" aria-label="Node Map" onKeyDown={onKeyDown}>
    <header className="map-header">
      <div className="map-heading">
        <h1>Node Map</h1>
        <nav className="map-crumbs" aria-label="Map focus"><ol>
          <li>{global ? <span aria-current="location">All workspaces</span> : <button type="button" onClick={() => scopeTo({ workspaceIds: [] })}>All workspaces</button>}</li>
          {crumbWorkspace && <li><Icon name="chevron" size={12} />{scope.pageId ? <button type="button" onClick={() => scopeTo({ workspaceIds: [crumbWorkspace] })}>{workspaceNames[crumbWorkspace] ?? "Workspace"}</button> : <span aria-current="location">{workspaceNames[crumbWorkspace] ?? "Workspace"}</span>}</li>}
          {!crumbWorkspace && scope.workspaceIds.length > 1 && <li><Icon name="chevron" size={12} /><span aria-current="location">{scope.workspaceIds.map(id => workspaceNames[id]).filter(Boolean).join(", ")}</span></li>}
          {scope.pageId && <li><Icon name="chevron" size={12} /><span aria-current="location">{pageCrumb?.title || "Untitled"}</span>
            <select className="map-hops" aria-label="Neighborhood depth" value={scope.hops ?? 1} onChange={e => scopeTo({ ...scope, hops: Number(e.target.value) })}><option value={1}>1 hop</option><option value={2}>2 hops</option><option value={3}>3 hops</option></select></li>}
        </ol></nav>
      </div>
      <div className="map-header-tools">
        <label className="map-search" data-searching={searching || undefined}>
          <Icon name="search" size={16} />
          <input ref={searchInput} type="search" aria-label="Search pages in all workspaces" placeholder="Search all workspaces…" value={search} maxLength={200}
            onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); } }} />
          {query && !searching && <span className="map-search-count" role="status">{matches.length ? `${match + 1} of ${matches.length}` : "No matches"}</span>}
          {matches.length > 1 && <><button type="button" className="map-icon-btn small" aria-label="Previous match" title="Previous match (Shift+Enter)" onClick={() => cycle(-1)}><Icon name="arrowUp" size={14} /></button><button type="button" className="map-icon-btn small" aria-label="Next match" title="Next match (Enter)" onClick={() => cycle(1)}><Icon name="arrowDown" size={14} /></button></>}
        </label>
        <IconButton icon="agent" label={agentLens ? "Show every page in colour" : agentPages ? `Highlight the ${agentPages} page${agentPages === 1 ? "" : "s"} agents created` : "No pages were created by agents"} pressed={agentLens} disabled={!agentPages && !agentLens} onClick={() => setAgentLens(v => !v)} />
        <IconButton icon="target" label={follow ? "Stop following the active page" : "Follow the active page"} pressed={follow} disabled={!activePage && !follow} onClick={followActive} />
        <IconButton icon="sidebar" label={inspectorOpen ? "Hide details" : "Show details"} pressed={inspectorOpen} onClick={() => configure({ inspector: !inspectorOpen })} />
      </div>
    </header>
    {error && <p className="map-notice field-error" role="alert">{error} <button className="btn ghost" type="button" onClick={reload}>Retry</button></p>}
    {webglFailed && <p className="map-notice" role="status">3D rendering is unavailable. The list provides the same navigation. <button type="button" className="btn ghost" onClick={() => setWebglFailed(false)}>Try the map again</button></p>}
    <div className="map-body" aria-busy={loading > 0}>
      <div className="map-stage">
        {firstLoad ? <Loading label="Loading map…" /> : !data ? null : empty ? <p className="empty">No pages yet. Pages and records you create appear here, grouped by workspace.</p> : canvasOff ?
          <MapList nodeTones={tones} nodes={data.nodes.filter(n => !hiddenWorkspaces.includes(n.workspaceId) && (!focus || showAll || focus.has(n.id)))} selected={selected} workspaces={workspaces} onSelect={ids => useNodeMap.getState().select(ids)} onOpen={n => dive(n)} />
          : <Suspense fallback={<Loading label="Loading renderer…" />}><MapCanvas autoOrbit={autoOrbit} onOrbitState={setOrbitState} nodeTones={tones} data={displayData!} workspaceColors={workspaceColors} workspaceNames={workspaceNames} positions={positions} flat={flat} selected={selected} tool={tool}
              focus={focus} showAll={showAll} labels={showLabels} hiddenEdges={hiddenEdges} hiddenWorkspaces={hiddenWorkspaces} initialCamera={initialCamera} api={api}
              onSelect={ids => useNodeMap.getState().select(ids)} onOpen={dive} onPin={(id, p) => useNodeMap.getState().pin(id, p)} onConnect={(a, b) => { useNodeMap.getState().select([a, b]); setPair([a, b]); configure({ inspector: true }); }}
              onCamera={rememberCamera} onZoom={setZoom} onError={() => setWebglFailed(true)} /></Suspense>}
        {data && !empty && <>
          {!canvasOff && <div className="map-rail" role="toolbar" aria-label="Map tools" aria-orientation="vertical">
            <div className="map-rail-group map-segment" role="radiogroup" aria-label="Pointer tool">
              {TOOLS.filter(t => t.id !== "connect" || !READ_ONLY).map(t => <ToolButton key={t.id} tool={t} active={tool === t.id} onSelect={() => setTool(t.id)} />)}
            </div>
            <MapHistory />
          </div>}
          {!canvasOff && activeTool.hint && <p className="map-tool-hint" role="status">{activeTool.hint}</p>}
          {workspaces.length > 1 && <WorkspaceChips workspaces={workspaces} colors={workspaceColors} hidden={hiddenWorkspaces}
            focusedId={scope.workspaceIds.length === 1 && !scope.pageId ? scope.workspaceIds[0] : null}
            onChip={(id, alt) => {
              if (alt) { configure({ hiddenWorkspaces: hiddenWorkspaces.includes(id) ? hiddenWorkspaces.filter(w => w !== id) : [...hiddenWorkspaces, id] }); return; }
              const focused = scope.workspaceIds.length === 1 && scope.workspaceIds[0] === id && !scope.pageId;
              scopeTo({ workspaceIds: focused ? [] : [id] });
            }} />}
          <div className="map-view" role="toolbar" aria-label="View">
            <div className="map-rail-group">
              <IconButton icon="dashboard" label="Layout" onClick={open("layout")} pressed={popover?.kind === "layout"} />
              <IconButton icon="star" label="Saved views" onClick={open("views")} pressed={popover?.kind === "views"} />
              <IconButton icon="layers" label="Layers and legend" onClick={open("layers")} pressed={popover?.kind === "layers"} />
            </div>
            <div className="map-rail-group">
              <IconButton icon="zoomOut" label="Zoom out" disabled={canvasOff} onClick={() => api.current?.zoom(1 / 1.4)} />
              <button type="button" className="map-zoom" title="Fit to view" aria-label={`Zoom ${zoom}%. Fit to view`} disabled={canvasOff} onClick={() => api.current?.fit()}>{zoom}%</button>
              <IconButton icon="zoomIn" label="Zoom in" disabled={canvasOff} onClick={() => api.current?.zoom(1.4)} />
              <IconButton icon="orbit" label={!autoOrbit ? "Enable auto-orbit" : flat || canvasOff ? "Auto-orbit enabled · paused outside 3D" : orbitState === "reduced" ? "Auto-orbit paused · reduced motion" : orbitState === "running" ? "Stop auto-orbit" : "Auto-orbit enabled"} pressed={autoOrbit} onClick={() => configure({ autoOrbit: !autoOrbit })} />
              <IconButton icon="fit" label="Fit to view" shortcut="map-fit" disabled={canvasOff} onClick={() => api.current?.fit()} />
            </div>
            <div className="map-rail-group map-segment" role="radiogroup" aria-label="Dimensions">
              <button type="button" role="radio" aria-checked={!flat} className="map-icon-btn" aria-label="3D" title="3D (3)" onClick={() => toggleFlat(false)}><Icon name="cube" /></button>
              <button type="button" role="radio" aria-checked={flat} className="map-icon-btn" aria-label="2D" title="2D (2)" onClick={() => toggleFlat(true)}><Icon name="square" /></button>
            </div>
            <div className="map-rail-group">
              <IconButton icon={showAll ? "eye" : "eyeOff"} label={showAll ? "Showing all nodes. Hide nodes outside the focus" : "Showing the focus only. Show all nodes"} shortcut="map-show-all" pressed={showAll} onClick={() => configure({ showAll: !showAll })} />
              <IconButton icon={asList ? "canvas" : "list"} label={asList ? "Show map" : "Show list"} shortcut="map-list" pressed={asList} onClick={toggleList} />
            </div>
          </div>
        </>}
      </div>
      {inspectorOpen && node && <aside className="map-inspector" aria-label="Selected node">
        <div className="map-inspector-head">
          <small><span className="map-chip-dot" style={{ background: workspaceColors[node.workspaceId] }} />{node.kind === "workspace" ? "Workspace" : `${node.kind[0].toUpperCase()}${node.kind.slice(1)} · ${workspaceNames[node.workspaceId] ?? "Workspace"}${node.createdBy ? ` · created by ${node.createdBy}` : ""}`}</small>
          <IconButton icon="close" label="Hide details" onClick={() => configure({ inspector: false })} />
        </div>
        <h2>{node.title || "Untitled"}</h2>
        {selected.length > 1 && <p className="map-inspector-note">{selected.length} selected. Details show the first.</p>}
        <div className="map-inspector-actions">
          {node.kind === "workspace" ? <button type="button" className="btn primary" onClick={() => dive(node)}>Explore workspace</button> : <>
            <button type="button" className="btn primary" onClick={() => void openNode(node)} title="Open beside (O)">Open beside</button>
            <button type="button" className="btn ghost" onClick={() => void openNode(node, true)} title="Open in main view (Shift+O)">Open in main view</button>
            {scope.pageId !== node.id && <button type="button" className="btn ghost" onClick={() => dive(node)} title="Dive in (Enter or double-click)">Show neighborhood</button>}
          </>}
          {pins[node.id] && <button type="button" className="btn ghost" onClick={() => useNodeMap.getState().pin(node.id, null)}><Icon name="pin" />Unpin</button>}
        </div>
        {node.tags.length > 0 && <p className="map-tags">{node.tags.map(tag => `#${tag}`).join(" · ")}</p>}
        {node.kind === "workspace" ? <p>{node.count.toLocaleString()} pages and records</p> : previewError ? <p className="field-error">{previewError}</p> : preview ? <div className="map-preview">{preview.imageHash && <img className="map-preview-image" src={thumbUrl(preview.imageHash, 320)} alt="" loading="lazy" />}{preview.lines.slice(0, 4).map((line, i) => <p key={i}>{line.text}</p>)}{!preview.lines.length && !preview.imageHash && <p>No text preview</p>}</div> : <p role="status" className="map-preview-loading">Loading preview…</p>}
        {grouped.length > 0 && <div className="map-connections">{grouped.map(g => <section key={g.kind}>
          <h3>{g.name} <span>{g.edges.length}</span></h3>
          <ul>{g.edges.slice(0, 40).map((edge: MapEdge) => { const other = at.get(edge.source === node.id ? edge.target : edge.source); return other && <li key={edge.id}>
            <button type="button" onClick={() => selectAndShow(other.id)} onPointerEnter={() => api.current?.highlight(other.id)} onPointerLeave={() => api.current?.highlight(null)} onFocus={() => api.current?.highlight(other.id)} onBlur={() => api.current?.highlight(null)}>
              <Icon name={edge.source === node.id ? "forward" : "back"} size={14} /><span>{other.title || "Untitled"}</span>{edge.count > 1 && <small>{edge.count}</small>}
            </button></li>; })}</ul>
        </section>)}</div>}
        <MapEdits data={data} selected={selected} pair={pair} />
      </aside>}
    </div>
    <footer className="map-status" role="status">
      <span>{firstLoad ? "Loading…" : `${visibleCount.toLocaleString()} nodes · ${(data?.edges.length ?? 0).toLocaleString()} connections`}{selected.length > 1 && ` · ${selected.length} selected`}</span>
      {loading > 0 && !firstLoad && <span className="map-status-working">Updating…</span>}
      {autoOrbit && !canvasOff && !flat && orbitState === "running" && <span>Auto-orbiting</span>}
      {layoutWorking && <span className="map-status-working">Settling layout…</span>}
      {layoutFailed && <span>Organic layout could not run. Showing clusters instead.</span>}
      {layout === "timeline" && <span>Time runs {flat ? "top to bottom" : "along the depth axis"}, oldest first. Undated items sit past the newest.</span>}
      {data?.truncated && <span>Showing {data.nodes.length.toLocaleString()} of {data.totalNodes.toLocaleString()} pages.{limit < 5000 && <button type="button" className="map-status-action" onClick={() => setLimit(5000)}>Show up to 5,000</button>}</span>}
    </footer>
    {popover && <Popover anchor={popover.anchor} onClose={() => setPopover(null)} label={popover.kind === "layout" ? "Layout" : popover.kind === "views" ? "Saved views" : "Layers and legend"} className="map-popover">
      {popover.kind === "layout" && <div className="map-pop-section">
        <div role="radiogroup" aria-label="Layout">{LAYOUTS.map(l => <button key={l.id} type="button" role="radio" aria-checked={layout === l.id} className="map-pop-option" onClick={() => configure({ layout: l.id, propertyId: "", ...(["property", "timeline"].includes(l.id) ? { records: true } : {}) })}>
          <Icon name="check" /><span><strong>{l.name}</strong><small>{l.hint}</small></span></button>)}</div>
        {["property", "timeline"].includes(layout) && <label className="map-pop-field">{layout === "timeline" ? "Date" : "Group by"}<select value={propertyId} onChange={e => configure({ propertyId: e.target.value })}><option value="">{layout === "timeline" ? "Creation date" : "Choose a property"}</option>{data?.properties.filter(p => layout === "timeline" ? p.kind === "date" : ["status", "select", "multi_select", "text", "checkbox"].includes(p.kind)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
        {layout === "property" && propertyGroups.length > 0 && <ul className="map-pop-groups" aria-label="Property groups">{propertyGroups.map(([name, count]) => <li key={name}><span>{name}</span><small>{count}</small></li>)}</ul>}
      </div>}
      {popover.kind === "views" && <div className="map-pop-section">
        {bookmarks.length ? <ul className="map-pop-views">{bookmarks.map(b => <li key={b.name}>
          <button type="button" className="map-pop-view" onClick={() => { setSearch(b.search ?? ""); setQuery(b.search ?? ""); useNodeMap.getState().restore(b.name); setPopover(null); }}>{b.name}</button>
          <button type="button" className="map-icon-btn small" aria-label={`Delete saved view ${b.name}`} title="Delete" onClick={() => useNodeMap.getState().remove(b.name)}><Icon name="close" size={14} /></button>
        </li>)}</ul> : <p className="map-pop-empty">No saved views yet. Save the current focus, layout and camera to come back to them.</p>}
        <form className="map-pop-save" onSubmit={e => { e.preventDefault(); if (!viewName.trim()) return; useNodeMap.getState().save(viewName, key, search); setViewName(""); }}>
          <input aria-label="Saved view name" placeholder="Name this view…" maxLength={80} value={viewName} onChange={e => setViewName(e.target.value)} />
          <button type="submit" className="btn" disabled={!viewName.trim()}>Save</button>
        </form>
      </div>}
      {popover.kind === "layers" && <div className="map-pop-section">
        <label className="map-pop-check"><input type="checkbox" checked={records} onChange={e => configure({ records: e.target.checked })} />Database records</label>
        <label className="map-pop-check"><input type="checkbox" checked={showLabels} onChange={e => configure({ labels: e.target.checked })} />Labels</label>
        <p className="map-pop-label">Node types</p>
        <div className="map-node-types">{Object.entries(NODE_COLORS).map(([kind, token]) => <span key={kind}><i aria-hidden="true" style={{ background: `var(${token})` }} />{kind[0].toUpperCase() + kind.slice(1)}</span>)}</div>
        <p className="map-pop-hint">Each type has nearby shades. Workspaces keep their chosen colors.</p>
        <p className="map-pop-label">Connections</p>
        {EDGES.map(g => <label key={g.kind} className="map-pop-check"><input type="checkbox" checked={!hiddenEdges.includes(g.kind)} onChange={e => configure({ hiddenEdges: e.target.checked ? hiddenEdges.filter(k => k !== g.kind) : [...hiddenEdges, g.kind] })} />
          <span className="map-line" data-dashed={g.dashed || undefined} data-strong={g.strong || undefined} aria-hidden="true" />{g.name}</label>)}
        <p className="map-pop-hint">Arrows point from source to target. The accent marks the selection and its links.</p>
      </div>}
    </Popover>}
  </section>;
}

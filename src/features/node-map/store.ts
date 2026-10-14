import { create } from "zustand";
import { useWorkspace } from "../../stores/workspace";
import type { CameraState, Layout, Position, MapEdit } from "./model";
export interface Scope { workspaceIds: string[]; pageId?: string; hops?: number }
export interface SavedView { name: string; scope: Scope; layout: Layout; flat: boolean; records: boolean; propertyId: string; camera?: CameraState; search?: string }
interface Preferences { layout: Layout; flat: boolean; records: boolean; follow: boolean; pins: Record<string, Position>; cameras: Record<string, CameraState>; bookmarks: SavedView[]; dependencyProperties: string[] }
const KEY = "suivelle.node-map";
const defaults: Preferences = { layout: "clusters", flat: false, records: false, follow: false, pins: {}, cameras: {}, bookmarks: [], dependencyProperties: [] };
function read(): Preferences {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const point = (p: unknown): p is Position => !!p && typeof p === "object" && ["x", "y", "z"].every(k => typeof (p as Record<string, unknown>)[k] === "number" && Number.isFinite((p as Record<string, number>)[k]) && Math.abs((p as Record<string, number>)[k]) < 1e6);
    return { ...defaults, layout: ["clusters", "hierarchy", "organic", "property", "timeline"].includes(v.layout) ? v.layout : defaults.layout, flat: v.flat === true, records: v.records === true, follow: v.follow === true,
      pins: Object.fromEntries(Object.entries(v.pins ?? {}).filter((entry): entry is [string, Position] => point(entry[1]))), cameras: {},
      bookmarks: Array.isArray(v.bookmarks) ? v.bookmarks.filter((b: SavedView) => typeof b.name === "string" && b.scope && Array.isArray(b.scope.workspaceIds)).slice(0, 30) : [],
      dependencyProperties: Array.isArray(v.dependencyProperties) ? v.dependencyProperties.filter((id:unknown)=>typeof id==="string").slice(0,100) : [],
    };
  } catch { return defaults; }
}
interface MapState extends Preferences {
  scope: Scope; previous: Scope[]; selected: string[]; propertyId: string; refresh: number;
  undo: MapEdit[]; redo: MapEdit[];
  scopeTo: (scope: Scope) => void; back: () => void; show: () => void; select: (ids: string[]) => void;
  configure: (patch: Partial<Preferences> & { propertyId?: string }) => void;
  pin: (id: string, position: Position | null) => void; camera: (key: string, state: CameraState) => void;
  save: (name: string, key: string, search?:string) => void; restore: (name: string) => void;
}
export const scopeKey = (scope: Scope, flat: boolean) => `${scope.workspaceIds.slice().sort().join(",")}:${scope.pageId ?? ""}:${scope.hops ?? ""}:${flat ? "2d" : "3d"}`;
export const useNodeMap = create<MapState>((set, get) => {
  const persist = () => { try { const { layout, flat, records, follow, pins, bookmarks, dependencyProperties } = get(); localStorage.setItem(KEY, JSON.stringify({ layout, flat, records, follow, pins, bookmarks, dependencyProperties })); } catch { /* Preferences remain usable for this session. */ } };
  return { ...read(), scope: { workspaceIds: [] }, previous: [], selected: [], propertyId: "", refresh: 0, undo: [], redo: [],
    scopeTo: scope => set(s => ({ scope, selected: scope.pageId ? [scope.pageId] : [], previous: [...s.previous.slice(-29), s.scope] })),
    back: () => { const prev = get().previous; if (prev.length) set({ scope: prev[prev.length - 1], previous: prev.slice(0, -1), selected: [] }); },
    show: () => useWorkspace.setState({ view: "node-map" }), select: selected => set({ selected }),
    configure: patch => { set(patch); persist(); },
    pin: (id, position) => { const pins = { ...get().pins }; if (position) pins[id] = position; else delete pins[id]; set({ pins }); persist(); },
    camera: (key, state) => set(s => ({ cameras: { ...s.cameras, [key]: state } })),
    save: (name, key, search="") => { const s = get(); const bookmark: SavedView = { name: name.trim().slice(0, 80), scope: s.scope, layout: s.layout, flat: s.flat, records: s.records, propertyId: s.propertyId, camera: s.cameras[key], search }; if (!bookmark.name) return; set({ bookmarks: [...s.bookmarks.filter(b => b.name !== bookmark.name), bookmark].slice(-30) }); persist(); },
    restore: name => { const b = get().bookmarks.find(b => b.name === name); if (!b) return; get().scopeTo(b.scope); get().configure({ layout: b.layout, flat: b.flat, records: b.records, propertyId: b.propertyId }); if (b.camera) get().camera(scopeKey(b.scope, b.flat), b.camera); set(s => ({ refresh: s.refresh + 1 })); },
  };
});

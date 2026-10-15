import { useEffect, useRef, type RefObject } from "react";
import { BoxGeometry, BufferGeometry, Color, ConeGeometry, Float32BufferAttribute, Fog, InstancedMesh, LineBasicMaterial, LineDashedMaterial, LineSegments, Matrix4, MeshBasicMaterial, OctahedronGeometry, OrthographicCamera, PerspectiveCamera, Plane, Quaternion, Raycaster, Scene, SphereGeometry, Vector2, Vector3, WebGLRenderer } from "three";
import { createOrbit, type OrbitState } from "./orbit";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { bezier, readProfile } from "../../lib/motion";
import { NODE_COLORS, type CameraState, type EdgeKind, type MapData, type MapEdge, type MapNode, type Position } from "./model";

export type MapTool = "navigate" | "move" | "connect" | "select";
export type StepDirection = "left" | "right" | "up" | "down";
export interface CanvasApi {
  fit: () => void; focus: (id: string) => void; frame: (ids: string[]) => void; zoom: (factor: number) => void;
  step: (from: string, direction: StepDirection) => string | null; highlight: (id: string | null) => void; camera: () => CameraState;
}
interface Props {
  data: MapData; positions: Record<string, Position>; flat: boolean; selected: string[]; tool: MapTool;
  /** The lit set. Everything else is dimmed, or hidden when `showAll` is off. */
  focus: Set<string> | null; showAll: boolean; labels: boolean; hiddenEdges: EdgeKind[]; hiddenWorkspaces: string[];
  autoOrbit?: boolean; onOrbitState?: (state: OrbitState) => void;
  initialCamera?: CameraState; api: RefObject<CanvasApi | null>;
  onSelect: (ids: string[]) => void; onOpen: (node: MapNode) => void; onPin: (id: string, p: Position) => void;
  onConnect: (source: string, target: string) => void; onCamera: (state: CameraState) => void; onZoom: (percent: number) => void; onError: () => void;
  /** Resolved colour per node (family by kind, shade by branch); kinds fall back to their theme tone. */
  nodeTones?: Record<string, string>; workspaceColors?: Record<string,string>; workspaceNames?: Record<string,string>;
}
type NodeState = "lit" | "dim" | "hidden";
const KINDS = ["workspace", "page", "database", "record", "dashboard"] as const;
const EDGE_KINDS: EdgeKind[] = ["contains", "membership", "reference", "relation", "dependency"];
const edgeToken = (kind: EdgeKind) => kind === "relation" || kind === "dependency" ? "--text-muted" : "--border-strong";

/**
 * One WebGL context for the life of the map. Data, layout, 2D/3D and focus changes rebuild buffers in place,
 * so switching views never creates a context. Instanced nodes and batched lines; no loop runs at rest.
 */
type DisplayOptions = "focus" | "showAll" | "labels" | "hiddenEdges" | "hiddenWorkspaces" | "onZoom";
export function MapCanvas(input: Omit<Props, DisplayOptions> & Partial<Pick<Props, DisplayOptions>>) {
  const props: Props = { focus: null, showAll: true, labels: true, hiddenEdges: [], hiddenWorkspaces: [], onZoom: () => {}, ...input };
  const host = useRef<HTMLDivElement>(null), labels = useRef<HTMLDivElement>(null);
  const current = useRef(props); current.current = props;
  const engine = useRef<{ build: () => void; setFlat: (flat: boolean) => boolean; restore: () => void; request: () => void; cancelDrag: () => void; refreshColors: () => void; recolor: () => void; orbitChanged: () => void } | null>(null);
  useEffect(() => {
    const el = host.current!, layer = labels.current!;
    let renderer: WebGLRenderer;
    try { renderer = new WebGLRenderer({ antialias: true, alpha: false }); } catch { current.current.onError(); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    const canvas = renderer.domElement; canvas.tabIndex = 0; canvas.setAttribute("aria-label", "Node map. Drag to orbit, scroll to zoom, arrow keys follow connections. Use the list for full keyboard navigation.");
    el.prepend(canvas);
    const scene = new Scene();
    const perspective = new PerspectiveCamera(45, 1, 1, 50000), orthographic = new OrthographicCamera(-500, 500, 500, -500, 1, 50000);
    let flat = current.current.flat, camera: PerspectiveCamera | OrthographicCamera = flat ? orthographic : perspective;
    camera.position.set(0, 120, 1000);
    const controls = new OrbitControls(camera, canvas); controls.enableDamping = false; controls.enableRotate = !flat; controls.minDistance = 30; controls.maxDistance = 30000;
    let orbit: ReturnType<typeof createOrbit> | undefined, orbitFrame = false;
    let motionAllowed = readProfile().loops > 0;
    controls.minPolarAngle = 0.1; controls.maxPolarAngle = Math.PI - 0.1;
    // Separate probes: a transition duration on the colour probe would make token reads return in-between colours.
    const probe = document.createElement("span"), timer = document.createElement("span"); probe.hidden = timer.hidden = true; el.append(probe, timer);
    const palette = new Map<string, Color>();
    const nodeColors = new Map<string, Color>();
    const color = (token: string): Color => {
      const cached = palette.get(token); if (cached) return cached;
      probe.style.color = token.startsWith("--") ? `var(${token})` : token;
      const css = getComputedStyle(probe).color, rgba = /^rgba\(([^,]+),([^,]+),([^,]+),\s*([\d.]+)\s*\)$/.exec(css);
      const value = new Color(rgba ? `rgb(${rgba[1]},${rgba[2]},${rgba[3]})` : css);
      // WebGL colours are opaque: translucent tokens (hairlines) are composited over the canvas colour.
      if (rgba && token !== "--background") value.lerp(color("--background"), 1 - Number(rgba[4]));
      palette.set(token, value); return value;
    };
    const hovercard = document.createElement("div"); hovercard.className = "map-hovercard"; hovercard.hidden = true; hovercard.setAttribute("aria-hidden", "true"); el.append(hovercard);
    const box = document.createElement("div"); box.className = "map-selection-box"; box.hidden = true; el.append(box);
    const connection = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    connection.classList.add("map-connect-preview"); connection.setAttribute("aria-hidden", "true"); connection.style.display = "none";
    const connectionLine = document.createElementNS(connection.namespaceURI, "line"); connection.append(connectionLine); el.append(connection);

    // Scene contents, rebuilt by build().
    let data: MapData = current.current.data, positions: Record<string, Position> = {};
    let meshes: InstancedMesh[] = [], nodesByMesh = new Map<InstancedMesh, MapNode[]>(), slot = new Map<string, { mesh: InstancedMesh; index: number; size: number }>();
    let at = new Map<string, MapNode>(), degree = new Map<string, number>(), adjacency = new Map<string, MapEdge[]>();
    let lines: { line: LineSegments<BufferGeometry, LineBasicMaterial | LineDashedMaterial>; heads: InstancedMesh<ConeGeometry, MeshBasicMaterial> | null; token: string; role: "normal" | "dim" | "lit" }[] = [];
    let states = new Map<string, NodeState>();
    let stateInputs: unknown[] = [], litKey = "", labelKey = "";
    let raf = 0, tween = 0, dead = false, themeDirty = true, fitReference = 1000, lastZoom = -1;
    // Instance colours are rewritten only when something that colours a node changes, never for camera moves alone.
    let nodeColorsDirty = true, colorsDirty = true, colorKey = "", colorSources: unknown = null;
    let hover: string | null = null;
    const labelElements = new Map<string, HTMLButtonElement>();
    let baseLabels = new Set<string>(), baseKey = "", ranked: MapNode[] = [], hovercardKey = "";

    const disposeLines = (role?: string) => { lines = lines.filter(l => { if (role && l.role !== role) return true; scene.remove(l.line); l.line.geometry.dispose(); l.line.material.dispose(); if (l.heads) { scene.remove(l.heads); l.heads.material.dispose(); l.heads.dispose(); } return false; }); };
    // Filled arrowheads: one shared cone, instanced per line batch. A cone reads as a solid triangle from
    // every angle, where a flat triangle would vanish when seen edge-on in 3D.
    const HEAD_LENGTH = 10, head = new ConeGeometry(3.6, HEAD_LENGTH, 10);
    type Batch = { vertices: number[]; heads: number[] };
    const batch = (): Batch => ({ vertices: [], heads: [] });
    // Scratch vectors: line batches are rebuilt on every focus change, so arrowheads must not allocate per edge.
    const a = new Vector3(), dir = new Vector3(), tip = new Vector3(), base = new Vector3(), coneAxis = new Vector3(0, 1, 0), turn = new Quaternion(), place = new Matrix4(), unit = new Vector3(1, 1, 1);
    const pushEdge = (into: Batch, edge: MapEdge) => {
      const p = positions[edge.source], q = positions[edge.target]; if (!p || !q) return;
      // Arrowheads encode direction with geometry, including in 2D mode; the line stops at the head's base.
      a.set(p.x, p.y, p.z); tip.set(q.x, q.y, q.z); dir.subVectors(tip, a);
      const length = dir.length(); if (!length) return; dir.divideScalar(length);
      tip.addScaledVector(dir, -(slot.get(edge.target)?.size ?? 5) - 2); base.copy(tip).addScaledVector(dir, -HEAD_LENGTH);
      if (length < (slot.get(edge.target)?.size ?? 5) + HEAD_LENGTH + 4) { into.vertices.push(p.x, p.y, p.z, q.x, q.y, q.z); return; }
      into.vertices.push(p.x, p.y, p.z, base.x, base.y, base.z);
      into.heads.push(tip.x - dir.x * HEAD_LENGTH / 2, tip.y - dir.y * HEAD_LENGTH / 2, tip.z - dir.z * HEAD_LENGTH / 2, dir.x, dir.y, dir.z);
    };
    const addLines = ({ vertices, heads: points }: Batch, kind: EdgeKind | "lit", role: "normal" | "dim" | "lit") => {
      if (!vertices.length) return;
      const geometry = new BufferGeometry(); geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
      const token = kind === "lit" ? "--accent-ui" : edgeToken(kind);
      const material = kind === "reference" ? new LineDashedMaterial({ dashSize: 6, gapSize: 4, transparent: role === "dim" }) : new LineBasicMaterial({ transparent: role === "dim" });
      // Colour from the cached palette; a theme change recolours every batch at paint time.
      material.color.copy(color(token)); material.opacity = role === "dim" ? .28 : 1;
      const line = new LineSegments(geometry, material); line.computeLineDistances(); line.renderOrder = role === "lit" ? 2 : role === "normal" ? 1 : 0;
      let heads: InstancedMesh<ConeGeometry, MeshBasicMaterial> | null = null;
      if (points.length) {
        heads = new InstancedMesh(head, new MeshBasicMaterial({ transparent: role === "dim", opacity: material.opacity, color: material.color }), points.length / 6);
        for (let i = 0; i < points.length / 6; i++) {
          const o = i * 6; dir.set(points[o + 3], points[o + 4], points[o + 5]); turn.setFromUnitVectors(coneAxis, dir);
          heads.setMatrixAt(i, place.compose(a.set(points[o], points[o + 1], points[o + 2]), turn, unit));
        }
        heads.instanceMatrix.needsUpdate = true; heads.computeBoundingSphere(); heads.renderOrder = line.renderOrder; scene.add(heads);
      }
      scene.add(line); lines.push({ line, heads, token, role });
    };
    const edgeState = (edge: MapEdge): NodeState => {
      if (current.current.hiddenEdges.includes(edge.kind)) return "hidden";
      const a = states.get(edge.source) ?? "hidden", b = states.get(edge.target) ?? "hidden";
      return a === "hidden" || b === "hidden" ? "hidden" : a === "dim" || b === "dim" ? "dim" : "lit";
    };
    const stateOf = (n: MapNode): NodeState => {
      const { focus, showAll, hiddenWorkspaces } = current.current;
      if (hiddenWorkspaces.includes(n.workspaceId)) return "hidden";
      if (focus) return focus.has(n.id) ? "lit" : showAll ? "dim" : "hidden";
      return showAll || n.kind === "workspace" ? "lit" : "hidden";
    };
    /** Visibility and dimming: instance scale 0 hides a node; context lines are batched separately so they can recede. */
    const applyStates = () => {
      states = new Map(data.nodes.map(n => [n.id, stateOf(n)]));
      const matrix = new Matrix4();
      for (const [id, s] of slot) { const p = positions[id]; if (!p) continue; const size = states.get(id) === "hidden" ? 0 : s.size; matrix.makeScale(size, size, size); matrix.setPosition(p.x, p.y, p.z); s.mesh.setMatrixAt(s.index, matrix); }
      for (const mesh of meshes) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); }
      disposeLines("normal"); disposeLines("dim");
      for (const kind of EDGE_KINDS) {
        const normal = batch(), dim = batch();
        for (const edge of data.edges) if (edge.kind === kind) { const s = edgeState(edge); if (s !== "hidden") pushEdge(s === "lit" ? normal : dim, edge); }
        addLines(normal, kind, "normal"); addLines(dim, kind, "dim");
      }
      litKey = ""; labelKey = ""; baseKey = ""; colorsDirty = true;
    };
    const updateLit = () => {
      const selected = current.current.selected, key = `${selected.join(",")}|${hover ?? ""}`;
      if (key === litKey) return; litKey = key;
      disposeLines("lit");
      const vertices = batch(), seen = new Set<string>();
      for (const id of [...selected.slice(0, 50), ...(hover ? [hover] : [])]) for (const edge of adjacency.get(id) ?? []) if (!seen.has(edge.id) && edgeState(edge) !== "hidden") { seen.add(edge.id); pushEdge(vertices, edge); }
      addLines(vertices, "lit", "lit");
    };
    const addLabel = (n: MapNode) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "map-label"; button.textContent = n.title || "Untitled"; button.tabIndex = -1;
      button.onclick = e => { e.stopPropagation(); current.current.onSelect([n.id]); };
      button.ondblclick = e => { e.stopPropagation(); current.current.onOpen(n); };
      button.onpointerenter = () => { hover = n.id; request(); };
      button.onpointerleave = () => { if (hover === n.id) { hover = null; request(); } };
      layer.append(button); labelElements.set(n.id, button);
    };
    /** Bounded DOM labels: the biggest lit nodes, plus whatever is selected or hovered. */
    const updateLabels = () => {
      const { selected, labels: showLabels } = current.current, key = `${showLabels}|${selected.slice(0, 30).join(",")}|${hover ?? ""}`;
      if (key === labelKey) return; labelKey = key;
      // The base set depends only on visibility, so hovering and selecting never re-rank the whole graph.
      if (baseKey !== String(showLabels)) {
        baseKey = String(showLabels); baseLabels = new Set();
        if (showLabels) for (const n of ranked) { if (states.get(n.id) === "lit") baseLabels.add(n.id); if (baseLabels.size === 60) break; }
      }
      const wanted = new Set([...baseLabels, ...selected.slice(0, 30), ...(hover ? [hover] : [])].filter(id => states.get(id) !== "hidden"));
      for (const [id, button] of labelElements) if (!wanted.has(id)) { button.remove(); labelElements.delete(id); }
      for (const id of wanted) { const n = at.get(id); if (n && !labelElements.has(id)) addLabel(n); }
    };
    const build = () => {
      data = current.current.data; positions = { ...current.current.positions }; nodeColorsDirty = colorsDirty = true;
      disposeLines(); slot = new Map();
      at = new Map(data.nodes.map(n => [n.id, n])); degree = new Map(); adjacency = new Map();
      for (const edge of data.edges) for (const id of [edge.source, edge.target]) { degree.set(id, (degree.get(id) ?? 0) + 1); const list = adjacency.get(id) ?? []; list.push(edge); adjacency.set(id, list); }
      ranked = [...data.nodes].sort((a, b) => Number(b.kind === "workspace") - Number(a.kind === "workspace") || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || b.count - a.count);
      // A mesh survives when its kind holds the same nodes in the same order (2D/3D, layout and refreshes);
      // applyStates then rewrites its matrices in place.
      const previous = new Map(meshes.map(m => [nodesByMesh.get(m)![0].kind, m] as const)), kept = new Set<InstancedMesh>();
      meshes = []; const owners = new Map<InstancedMesh, MapNode[]>();
      for (const kind of KINDS) {
        const nodes = data.nodes.filter(n => n.kind === kind && positions[n.id]); if (!nodes.length) continue;
        const old = previous.get(kind), before = old && nodesByMesh.get(old)!;
        let mesh: InstancedMesh;
        if (old && before!.length === nodes.length && nodes.every((n, i) => before![i].id === n.id)) { mesh = old; kept.add(old); }
        else {
          const geometry = kind === "database" ? new BoxGeometry(1.5, 1.5, 1.5) : kind === "record" ? new OctahedronGeometry(1) : new SphereGeometry(1, 12, 8);
          mesh = new InstancedMesh(geometry, new MeshBasicMaterial(), nodes.length); scene.add(mesh);
        }
        nodes.forEach((n, index) => slot.set(n.id, { mesh, index, size: kind === "workspace" ? 18 : 5 + Math.min(6, Math.sqrt(Math.max(n.count, degree.get(n.id) ?? 0))) }));
        meshes.push(mesh); owners.set(mesh, nodes);
      }
      for (const m of previous.values()) if (!kept.has(m)) { scene.remove(m); m.geometry.dispose(); (m.material as MeshBasicMaterial).dispose(); m.dispose(); }
      nodesByMesh = owners;
      for (const [id, button] of labelElements) if (!at.has(id)) { button.remove(); labelElements.delete(id); }
      for (const [id, button] of labelElements) button.textContent = at.get(id)!.title || "Untitled";
      if (hover && !at.has(hover)) hover = null;
      stateInputs = []; request(); orbit?.refresh();
    };
    const capture = (): CameraState => ({ position: camera.position.toArray() as [number,number,number], target: controls.target.toArray() as [number,number,number], zoom: camera.zoom });
    const zoomPercent = () => camera instanceof OrthographicCamera ? camera.zoom / (fitReference || 1) : (fitReference || 1) / Math.max(1, camera.position.distanceTo(controls.target));
    const draw = () => {
      raf = 0; if (dead || document.hidden || !el.clientWidth || !el.clientHeight) return;
      const { selected, focus, showAll, hiddenEdges, hiddenWorkspaces, workspaceColors, workspaceNames } = current.current;
      const inputs = [focus, showAll, hiddenEdges, hiddenWorkspaces];
      if (inputs.some((v, i) => v !== stateInputs[i])) { stateInputs = inputs; applyStates(); }
      updateLit(); updateLabels();
      // Resolve tokens at paint time, after batched theme writes and system scheme changes.
      if (themeDirty) {
        palette.clear();
        const background = color("--background");
        renderer.setClearColor(background);
        scene.fog = new Fog(background, 3000, 12000);
        for (const l of lines) { l.line.material.color.copy(color(l.token)); l.line.material.opacity = l.role === "dim" ? .28 : 1; l.heads?.material.color.copy(l.line.material.color); }
        themeDirty = false; nodeColorsDirty = true;
      }
      if (nodeColorsDirty) {
        nodeColors.clear();
        const tones = current.current.nodeTones;
        for (const n of data.nodes) if (n.kind !== "workspace") nodeColors.set(n.id, color(tones?.[n.id] ?? NODE_COLORS[n.kind]));
        nodeColorsDirty = false; colorsDirty = true;
      }
      const key = `${selected.join(",")}|${hover ?? ""}`;
      if (colorsDirty || key !== colorKey || workspaceColors !== colorSources) {
        colorsDirty = false; colorKey = key; colorSources = workspaceColors;
        const background = color("--background"), picked = new Set(selected), shade = new Color();
        for (const mesh of meshes) {
          nodesByMesh.get(mesh)!.forEach((n, i) => {
            const lit = picked.has(n.id) || n.id === hover;
            const value = lit ? color("--accent-ui") : n.kind === "workspace" ? color(workspaceColors?.[n.workspaceId] ?? "--text-secondary") : nodeColors.get(n.id)!;
            mesh.setColorAt(i, states.get(n.id) === "dim" && !lit ? shade.copy(value).lerp(background, .72) : value);
          });
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
      }
      renderer.render(scene, camera);
      const occupied: { x: number; y: number; w: number }[] = [];
      const ordering = [...labelElements].sort(([a],[b]) => Number(selected.includes(b) || b === hover) - Number(selected.includes(a) || a === hover));
      for (const [id, button] of ordering) {
        const p = positions[id], n = at.get(id); if (!p || !n) { button.hidden = true; continue; }
        const v = new Vector3(p.x, p.y, p.z).project(camera);
        const x = (v.x + 1) * el.clientWidth / 2 + 10, y = (1 - v.y) * el.clientHeight / 2 - 8;
        const important = selected.includes(id) || id === hover || n.kind === "workspace";
        const close = camera.position.distanceTo(new Vector3(p.x,p.y,p.z)) < 900 / camera.zoom;
        const w = Math.min(180, button.textContent!.length * 7 + 12);
        const visible = Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95 && v.z > -1 && v.z < 1 && (important || close || n.count >= 4 || (degree.get(id) ?? 0) >= 4 || !!focus) && (important || !occupied.some(o => Math.abs(o.y-y)<22 && x<o.x+o.w && x+w>o.x));
        button.hidden = !visible;
        if (visible) { occupied.push({x,y,w}); button.style.transform = `translate(${x}px,${y}px)`; button.dataset.selected = String(selected.includes(id)); button.dataset.dim = String(states.get(id) === "dim" && !important); }
      }
      const hovered = hover ? at.get(hover) : undefined, hp = hover ? positions[hover] : undefined;
      if (hovered && hp && states.get(hovered.id) !== "hidden") {
        const v = new Vector3(hp.x, hp.y, hp.z).project(camera);
        const connections = degree.get(hovered.id) ?? 0;
        const hoverKey = `${hovered.id}|${hovered.title}|${hovered.kind}|${hovered.count}|${connections}|${workspaceNames?.[hovered.workspaceId]}`;
        if (hoverKey !== hovercardKey) { hovercardKey = hoverKey; hovercard.replaceChildren(Object.assign(document.createElement("strong"), { textContent: hovered.title || "Untitled" }),
          Object.assign(document.createElement("span"), { textContent: hovered.kind === "workspace" ? `Workspace · ${hovered.count.toLocaleString()} pages and records` : `${hovered.kind[0].toUpperCase()}${hovered.kind.slice(1)} · ${workspaceNames?.[hovered.workspaceId] ?? "Workspace"}` }),
          Object.assign(document.createElement("span"), { textContent: `${connections} ${connections === 1 ? "connection" : "connections"}` })); }
        const x = (v.x + 1) * el.clientWidth / 2, y = (1 - v.y) * el.clientHeight / 2;
        hovercard.hidden = false;
        const flipX = x + 236 > el.clientWidth, flipY = y + 90 > el.clientHeight;
        hovercard.style.transform = `translate(${flipX ? x - 16 - hovercard.offsetWidth : x + 16}px,${flipY ? y - 12 - hovercard.offsetHeight : y + 14}px)`;
      } else hovercard.hidden = true;
      const percent = Math.round(zoomPercent() * 100);
      if (percent !== lastZoom) { lastZoom = percent; current.current.onZoom(percent); }
      updateConnection();
      if (!orbitFrame) current.current.onCamera(capture());
    };
    const request = () => { if (!raf && !dead && !orbitFrame && !document.hidden) raf = requestAnimationFrame(draw); };
    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return;
      renderer.setSize(w, h);
      perspective.aspect = w/h; perspective.updateProjectionMatrix();
      orthographic.left = -500*w/h; orthographic.right = 500*w/h; orthographic.top = 500; orthographic.bottom = -500; orthographic.updateProjectionMatrix();
      request(); orbit?.refresh();
    };
    const theme = () => {
      themeDirty = true; request();
      const allowed = readProfile().loops > 0;
      if (motionAllowed !== allowed) { motionAllowed = allowed; orbit?.refresh(); }
    };
    const fly = (target: Vector3, distance: number, zoom?: number) => {
      cancelAnimationFrame(tween);
      const from = camera.position.clone(), startTarget = controls.target.clone(), startZoom = camera.zoom;
      const direction = flat ? new Vector3(0,0,1) : from.clone().sub(startTarget).normalize();
      const to = target.clone().addScaledVector(direction, distance);
      timer.style.transitionDuration = "var(--duration-slow, var(--duration-fast))";
      const duration = readProfile().dist === 0 ? 0 : parseFloat(getComputedStyle(timer).transitionDuration) * 1000;
      const ease = bezier(getComputedStyle(document.documentElement).getPropertyValue("--ease-smooth-out"));
      const start = performance.now();
      const step = (now: number) => {
        const t = duration ? Math.min(1,(now-start)/duration) : 1; const eased = ease(t);
        camera.position.lerpVectors(from,to,eased); controls.target.lerpVectors(startTarget,target,eased);
        if (zoom !== undefined) { camera.zoom = startZoom + (zoom - startZoom) * eased; camera.updateProjectionMatrix(); }
        controls.update(); request(); if (t<1 && !dead) tween=requestAnimationFrame(step);
      };
      step(start);
    };
    const frame = (ids: string[]) => {
      const ps = ids.map(id => positions[id]).filter((p): p is Position => !!p); if (!ps.length) return;
      const min = new Vector3(Infinity,Infinity,Infinity), max = new Vector3(-Infinity,-Infinity,-Infinity);
      for (const p of ps) {min.min(new Vector3(p.x,p.y,p.z));max.max(new Vector3(p.x,p.y,p.z));}
      const center = min.clone().add(max).multiplyScalar(.5), extent = Math.max(240, max.x-min.x, max.y-min.y, max.z-min.z);
      const distance = extent * 1.8;
      if (camera instanceof OrthographicCamera) { fitReference = 700/extent; fly(center, 1000, fitReference); }
      else { fitReference = distance; fly(center, distance); }
    };
    const fit = () => frame(data.nodes.filter(n => states.get(n.id) !== "hidden").map(n => n.id));
    const focus = (id: string) => { const p = positions[id]; if (p) fly(new Vector3(p.x,p.y,p.z), camera.position.distanceTo(controls.target)); };
    const zoom = (factor: number) => {
      if (camera instanceof OrthographicCamera) { const next = Math.min(40, Math.max(.02, camera.zoom * factor)); fly(controls.target.clone(), camera.position.distanceTo(controls.target), next); }
      else fly(controls.target.clone(), Math.min(controls.maxDistance, Math.max(controls.minDistance, camera.position.distanceTo(controls.target) / factor)));
    };
    const project = (id: string) => { const p = positions[id]; if (!p) return null; const v = new Vector3(p.x, p.y, p.z).project(camera); return { x: v.x * el.clientWidth / 2, y: -v.y * el.clientHeight / 2 }; };
    /** The connected node that best matches an arrow direction on screen. */
    const step = (from: string, direction: StepDirection) => {
      const origin = project(from); if (!origin) return null;
      const want = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[direction];
      let best: string | null = null, score = Infinity;
      for (const edge of adjacency.get(from) ?? []) {
        if (edgeState(edge) === "hidden") continue;
        const other = edge.source === from ? edge.target : edge.source, p = project(other); if (!p) continue;
        const dx = p.x - origin.x, dy = p.y - origin.y, length = Math.hypot(dx, dy) || 1;
        const cos = (dx * want[0] + dy * want[1]) / length; if (cos < .35) continue;
        const value = length * (2 - cos); if (value < score) { score = value; best = other; }
      }
      return best;
    };
    const setFlat = (next: boolean) => {
      if (next === flat) return false; flat = next; cancelAnimationFrame(tween);
      const target = controls.target.clone();
      camera = flat ? orthographic : perspective; controls.object = camera; controls.enableRotate = !flat;
      if (flat) { camera.position.set(target.x, target.y, target.z + 1000); camera.up.set(0, 1, 0); }
      controls.target.copy(target); camera.lookAt(target); camera.updateProjectionMatrix(); controls.update(); request(); return true;
    };
    const highlight = (id: string | null) => { if (hover !== id) { hover = id && at.has(id) ? id : null; request(); } };
    current.current.api.current = { fit, focus, frame, zoom, step, highlight, camera: capture };
    /** The remembered camera for this view, or a fit when there is none. */
    const restore = () => {
      applyStates(); stateInputs = [current.current.focus, current.current.showAll, current.current.hiddenEdges, current.current.hiddenWorkspaces];
      const saved = current.current.initialCamera;
      if (saved && [...saved.position, ...saved.target, saved.zoom].every(Number.isFinite)) { cancelAnimationFrame(tween); camera.position.fromArray(saved.position); controls.target.fromArray(saved.target); camera.zoom = saved.zoom; camera.updateProjectionMatrix(); controls.update(); request(); }
      else fit();
    };


    const ray = new Raycaster(), pointer = new Vector2();
    const pick = (e: PointerEvent | MouseEvent) => { const r=canvas.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2);ray.setFromCamera(pointer,camera);const hit=ray.intersectObjects(meshes)[0];const n=hit && hit.instanceId !== undefined ? nodesByMesh.get(hit.object as InstancedMesh)?.[hit.instanceId] : undefined;return n && states.get(n.id) !== "hidden" ? n : undefined; };
    let drag: { x:number; y:number; cursorX:number; cursorY:number; node?: MapNode; plane?:Plane; moved:boolean } | null=null;
    const updateConnection = () => {
      const origin = drag?.node && current.current.tool === "connect" ? positions[drag.node.id] : undefined;
      connection.style.display = origin ? "block" : "none";
      if (!origin || !drag) return;
      const r = canvas.getBoundingClientRect(), v = new Vector3(origin.x, origin.y, origin.z).project(camera);
      connection.setAttribute("viewBox", `0 0 ${el.clientWidth} ${el.clientHeight}`);
      connectionLine.setAttribute("x1", String((v.x + 1) * el.clientWidth / 2));
      connectionLine.setAttribute("y1", String((1 - v.y) * el.clientHeight / 2));
      connectionLine.setAttribute("x2", String((drag.cursorX - r.left) * el.clientWidth / r.width));
      connectionLine.setAttribute("y2", String((drag.cursorY - r.top) * el.clientHeight / r.height));
    };
    const cancelDrag = () => { drag = null; box.hidden = true; controls.enabled = true; updateConnection(); };
    const cancelKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelDrag(); };
    engine.current = { build, setFlat, restore, request, cancelDrag, refreshColors: theme, recolor: () => { nodeColorsDirty = true; request(); }, orbitChanged: () => orbit?.refresh() };
    const moveNode = (id: string, p: Position) => {
      positions[id] = p; const s = slot.get(id);
      if (s) { const matrix = new Matrix4(); matrix.makeScale(s.size, s.size, s.size); matrix.setPosition(p.x, p.y, p.z); s.mesh.setMatrixAt(s.index, matrix); s.mesh.instanceMatrix.needsUpdate = true; s.mesh.computeBoundingSphere(); }
      request();
    };
    const down = (e: PointerEvent) => {
      cancelAnimationFrame(tween); if(e.button!==0) return;
      const node=pick(e);drag={x:e.clientX,y:e.clientY,cursorX:e.clientX,cursorY:e.clientY,node,moved:false};
      if(current.current.tool!=="navigate") {
        controls.enabled=false;canvas.setPointerCapture(e.pointerId);
        if (current.current.tool === "connect") updateConnection();
        if(node && current.current.tool==="move") {const p=positions[node.id];drag.plane=new Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new Vector3()),new Vector3(p.x,p.y,p.z));}
      }
    };
    const move = (e: PointerEvent) => {
      if(drag) {
        drag.cursorX = e.clientX; drag.cursorY = e.clientY;
        drag.moved ||= Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>4;
        if(current.current.tool==="move" && drag.node && drag.plane) { pick(e); const p=ray.ray.intersectPlane(drag.plane,new Vector3()); if(p) moveNode(drag.node.id,{x:p.x,y:p.y,z:flat?0:p.z}); }
        if(current.current.tool==="select") { const r=el.getBoundingClientRect();box.hidden=false;Object.assign(box.style,{left:`${Math.min(e.clientX,drag.x)-r.left}px`,top:`${Math.min(e.clientY,drag.y)-r.top}px`,width:`${Math.abs(e.clientX-drag.x)}px`,height:`${Math.abs(e.clientY-drag.y)}px`}); }
        if(current.current.tool==="connect" && drag.node) { updateConnection(); const next=pick(e)?.id??null; if(hover!==next){hover=next;request();} }
      } else { const next=pick(e)?.id??null;if(hover!==next){hover=next;canvas.style.cursor=hover?"pointer":current.current.tool==="navigate"?"grab":"crosshair";request();} }
    };
    const up = (e: PointerEvent) => {
      if(!drag) return;const start=drag;cancelDrag();
      if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
      const node=pick(e), tool=current.current.tool;
      if(tool==="connect" && start.node && node && node.id!==start.node.id) current.current.onConnect(start.node.id,node.id);
      else if(tool==="move" && start.node && start.plane && start.moved) {const p=ray.ray.intersectPlane(start.plane,new Vector3());if(p)current.current.onPin(start.node.id,{x:p.x,y:p.y,z:flat?0:p.z});}
      else if(tool==="select" && start.moved) {const r=canvas.getBoundingClientRect();current.current.onSelect(data.nodes.filter(n=>{const p=positions[n.id];if(!p||states.get(n.id)==="hidden")return false;const v=new Vector3(p.x,p.y,p.z).project(camera);const x=r.left+(v.x+1)*r.width/2,y=r.top+(1-v.y)*r.height/2;return v.z>=-1&&v.z<=1&&x>=Math.min(start.x,e.clientX)&&x<=Math.max(start.x,e.clientX)&&y>=Math.min(start.y,e.clientY)&&y<=Math.max(start.y,e.clientY);}).map(n=>n.id));}
      else if(!start.moved) {if(node){const ids=current.current.selected;const additive=e.ctrlKey||e.metaKey;current.current.onSelect(additive?ids.includes(node.id)?ids.filter(id=>id!==node.id):[...ids,node.id]:[node.id]);if(!additive)focus(node.id);}else current.current.onSelect([]);}
    };
    const leave = () => { if (hover && !drag) { hover = null; request(); } };
    const double = (e: MouseEvent) => {const n=pick(e);if(n)current.current.onOpen(n);};
    const lost = (e: Event) => {e.preventDefault();if(!dead)current.current.onError();};
    canvas.addEventListener("pointerdown",down,true);canvas.addEventListener("pointermove",move);canvas.addEventListener("pointerup",up);canvas.addEventListener("pointerleave",leave);canvas.addEventListener("dblclick",double);canvas.addEventListener("webglcontextlost",lost);
    canvas.addEventListener("pointercancel",cancelDrag);canvas.addEventListener("lostpointercapture",cancelDrag);window.addEventListener("keydown",cancelKey);
    orbit = createOrbit({
      blocked: () => {
        if (!current.current.autoOrbit) return "off";
        if (!motionAllowed) return "reduced";
        return flat || dead || document.hidden || !el.clientWidth || !el.clientHeight ? "paused" : null;
      },
      tick: seconds => {
        orbitFrame = true;
        try { controls.rotateLeft(Math.PI / 60 * seconds); controls.update(); if (raf) cancelAnimationFrame(raf); draw(); }
        finally { orbitFrame = false; }
      },
      stopped: () => { if (!dead) current.current.onCamera(capture()); },
      status: state => current.current.onOrbitState?.(state),
    });
    const visibility = () => { request(); orbit?.refresh(); };
    const reduced = matchMedia("(prefers-reduced-motion: reduce)"); reduced.addEventListener("change", theme);
    controls.addEventListener("change",request);
    const observer=new ResizeObserver(resize);observer.observe(el);
    const themeObserver=new MutationObserver(theme);themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:["style","class","data-theme","data-motion"]});
    document.addEventListener("visibilitychange",visibility);
    const scheme=window.matchMedia("(prefers-color-scheme: dark)");scheme.addEventListener("change",theme);
    resize(); build(); restore(); orbit.refresh();
    return () => {
      current.current.onCamera(capture()); dead=true; orbit?.dispose();
      reduced.removeEventListener("change", theme);
      cancelAnimationFrame(raf);cancelAnimationFrame(tween);current.current.api.current=null;engine.current=null;
      canvas.removeEventListener("pointerdown",down,true);canvas.removeEventListener("pointermove",move);canvas.removeEventListener("pointerup",up);canvas.removeEventListener("pointerleave",leave);canvas.removeEventListener("dblclick",double);canvas.removeEventListener("webglcontextlost",lost);
      canvas.removeEventListener("pointercancel",cancelDrag);canvas.removeEventListener("lostpointercapture",cancelDrag);window.removeEventListener("keydown",cancelKey);
      controls.removeEventListener("change",request);
      observer.disconnect();themeObserver.disconnect();document.removeEventListener("visibilitychange",visibility);scheme.removeEventListener("change",theme);controls.dispose();
      meshes.forEach(m=>{m.geometry.dispose();(m.material as MeshBasicMaterial).dispose();m.dispose();});disposeLines();head.dispose();renderer.dispose();
      // dispose() keeps the GL context alive; release it so a remount never accumulates contexts.
      renderer.forceContextLoss();canvas.remove();probe.remove();timer.remove();box.remove();connection.remove();hovercard.remove();layer.replaceChildren();
    };
  }, []);
  useEffect(() => engine.current?.orbitChanged(), [props.autoOrbit, props.flat]);
  useEffect(() => engine.current?.cancelDrag(), [props.tool]);
  const mounted = useRef(false);
  useEffect(() => {
    const e = engine.current; if (!e) return;
    // The mount effect already built the first scene.
    if (!mounted.current) { mounted.current = true; return; }
    const swapped = e.setFlat(props.flat); e.build(); if (swapped) e.restore();
  }, [props.data, props.positions, props.flat]);
  useEffect(() => engine.current?.recolor(), [props.nodeTones]);
  useEffect(() => engine.current?.request(), [props.selected, props.workspaceColors, props.focus, props.showAll, props.labels, props.hiddenEdges, props.hiddenWorkspaces]);
  return <div className="map-canvas" ref={host}><div className="map-labels" ref={labels} /></div>;
}

import { useEffect, useRef, type RefObject } from "react";
import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Fog, InstancedMesh, LineBasicMaterial, LineDashedMaterial, LineSegments, Matrix4, MeshBasicMaterial, OctahedronGeometry, OrthographicCamera, PerspectiveCamera, Plane, Raycaster, Scene, SphereGeometry, Vector2, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { readProfile } from "../../lib/motion";
import type { CameraState, MapData, MapNode, Position } from "./model";

export type MapTool = "navigate" | "move" | "connect" | "select";
export interface CanvasApi { fit: () => void; focus: (id: string) => void; camera: () => CameraState }
interface Props {
  data: MapData; positions: Record<string, Position>; flat: boolean; selected: string[]; tool: MapTool;
  initialCamera?: CameraState; api: RefObject<CanvasApi | null>;
  onSelect: (ids: string[]) => void; onOpen: (node: MapNode) => void; onPin: (id: string, p: Position) => void;
  onConnect: (source: string, target: string) => void; onCamera: (state: CameraState) => void; onError: () => void;
}

/** Instanced nodes and batched lines. No animation loop runs when the camera is at rest. */
export function MapCanvas(props: Props) {
  const host = useRef<HTMLDivElement>(null), labels = useRef<HTMLDivElement>(null);
  const current = useRef(props); current.current = props;
  const paint = useRef<() => void>(() => {});
  useEffect(() => {
    const el = host.current!, layer = labels.current!;
    let renderer: WebGLRenderer;
    try { renderer = new WebGLRenderer({ antialias: true, alpha: false }); } catch { current.current.onError(); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    const canvas = renderer.domElement; canvas.tabIndex = 0; canvas.setAttribute("aria-label", "Node map. Drag to orbit, scroll to zoom. Use the list for keyboard navigation.");
    el.prepend(canvas);
    const scene = new Scene();
    const camera = props.flat ? new OrthographicCamera(-500, 500, 400, -400, 1, 50000) : new PerspectiveCamera(45, 1, 1, 50000);
    camera.position.set(0, 120, 1000);
    const controls = new OrbitControls(camera, canvas); controls.enableDamping = false; controls.enableRotate = !props.flat; controls.minDistance = 30; controls.maxDistance = 30000;
    controls.minPolarAngle = 0.1; controls.maxPolarAngle = Math.PI - 0.1;
    const meshes: InstancedMesh[] = [], nodesByMesh = new Map<InstancedMesh, MapNode[]>();
    const at = new Map(props.data.nodes.map(n => [n.id, n]));
    const localPositions = { ...props.positions };
    const probe = document.createElement("span"); el.append(probe);
    const palette = new Map<string, Color>();
    const color = (token: string) => { const cached = palette.get(token); if (cached) return cached; probe.style.color = `var(${token})`; const value = new Color(getComputedStyle(probe).color); palette.set(token, value); return value; };
    const groups = ["workspace", "page", "database", "record", "dashboard"] as const;
    for (const kind of groups) {
      const nodes = props.data.nodes.filter(n => n.kind === kind); if (!nodes.length) continue;
      const geometry = kind === "database" ? new BoxGeometry(1.5, 1.5, 1.5) : kind === "record" ? new OctahedronGeometry(1) : new SphereGeometry(1, 12, 8);
      const mesh = new InstancedMesh(geometry, new MeshBasicMaterial(), nodes.length);
      const matrix = new Matrix4();
      nodes.forEach((n, i) => { const p = props.positions[n.id]; if (!p) return; const size = kind === "workspace" ? 18 : 5 + Math.min(6, Math.sqrt(n.count)); matrix.makeScale(size, size, size); matrix.setPosition(p.x, p.y, p.z); mesh.setMatrixAt(i, matrix); mesh.setColorAt(i, color("--text-muted")); });
      mesh.computeBoundingSphere(); scene.add(mesh); meshes.push(mesh); nodesByMesh.set(mesh, nodes);
    }
    const lines: LineSegments<BufferGeometry, LineBasicMaterial | LineDashedMaterial>[] = [];
    for (const kind of ["contains", "membership", "reference", "relation"]) {
      const vertices: number[] = [];
      for (const edge of props.data.edges.filter(e => e.kind === kind)) {
        const p = props.positions[edge.source], q = props.positions[edge.target]; if (!p || !q) continue;
        vertices.push(p.x, p.y, p.z, q.x, q.y, q.z);
        // Arrowheads encode direction with geometry, including in 2D mode.
        const a = new Vector3(p.x, p.y, p.z), b = new Vector3(q.x, q.y, q.z), dir = b.clone().sub(a).normalize();
        const side = dir.clone().cross(Math.abs(dir.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
        const tip = b.clone().addScaledVector(dir, -10), tail = tip.clone().addScaledVector(dir, -7);
        for (const sign of [-1, 1]) { const end = tail.clone().addScaledVector(side, sign * 3); vertices.push(tip.x, tip.y, tip.z, end.x, end.y, end.z); }
      }
      const geometry = new BufferGeometry(); geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
      const material = kind === "reference" ? new LineDashedMaterial({ color: color("--border-strong"), dashSize: 6, gapSize: 4 }) : new LineBasicMaterial({ color: color(kind === "relation" ? "--accent-ui" : "--border-strong") });
      const line = new LineSegments(geometry, material); line.computeLineDistances(); scene.add(line); lines.push(line);
    }
    let raf = 0, tween = 0, dead = false;
    let hover: string | null = null;
    const labelElements = new Map<string, HTMLButtonElement>();
    // Reuse bounded DOM labels; canvas content itself is not an accessible navigation tree.
    const labelNodes = [...props.data.nodes].sort((a,b) => Number(b.kind === "workspace") - Number(a.kind === "workspace") || b.count - a.count).slice(0, 60);
    for (const n of labelNodes) {
      const button = document.createElement("button"); button.type = "button"; button.className = "map-label"; button.textContent = n.title || "Untitled"; button.title = `${n.kind}: ${n.title || "Untitled"}`; button.tabIndex = -1;
      button.onclick = e => { e.stopPropagation(); current.current.onSelect([n.id]); };
      button.ondblclick = e => { e.stopPropagation(); current.current.onOpen(n); };
      layer.append(button); labelElements.set(n.id, button);
    }
    const capture = (): CameraState => ({ position: camera.position.toArray() as [number,number,number], target: controls.target.toArray() as [number,number,number], zoom: camera.zoom });
    const draw = () => {
      raf = 0; if (dead || document.hidden || !el.clientWidth || !el.clientHeight) return;
      for (const mesh of meshes) {
        nodesByMesh.get(mesh)!.forEach((n,i) => { const selected = current.current.selected.includes(n.id); mesh.setColorAt(i, color(selected || n.id === hover ? "--accent-ui" : n.kind === "workspace" ? "--text-secondary" : "--text-muted")); });
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      renderer.render(scene, camera);
      const occupied: { x: number; y: number; w: number }[] = [];
      const ordering = [...labelElements].sort(([a],[b]) => Number(current.current.selected.includes(b)) - Number(current.current.selected.includes(a)));
      for (const [id, button] of ordering) {
        const p = localPositions[id], n = at.get(id)!; const v = new Vector3(p.x, p.y, p.z).project(camera);
        const x = (v.x + 1) * el.clientWidth / 2 + 10, y = (1 - v.y) * el.clientHeight / 2 - 8;
        const important = current.current.selected.includes(id) || id === hover || n.kind === "workspace";
        const close = camera.position.distanceTo(new Vector3(p.x,p.y,p.z)) < 900 / camera.zoom;
        const w = Math.min(180, button.textContent!.length * 7 + 12);
        const visible = Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95 && v.z > -1 && v.z < 1 && (important || close || n.count >= 4) && (important || !occupied.some(o => Math.abs(o.y-y)<22 && x<o.x+o.w && x+w>o.x));
        button.hidden = !visible; if (visible) { occupied.push({x,y,w}); button.style.transform = `translate(${x}px,${y}px)`; button.dataset.selected = String(current.current.selected.includes(id)); }
      }
      current.current.onCamera(capture());
    };
    const request = () => { if (!raf && !dead && !document.hidden) raf = requestAnimationFrame(draw); };
    paint.current = request;
    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return;
      renderer.setSize(w, h);
      if (camera instanceof PerspectiveCamera) camera.aspect = w/h;
      else { camera.left = -500*w/h; camera.right = 500*w/h; camera.top = 500; camera.bottom = -500; }
      camera.updateProjectionMatrix(); request();
    };
    const theme = () => { palette.clear(); const background = color("--background"); renderer.setClearColor(background); scene.fog = new Fog(background, 3000, 12000); lines.forEach((l,i) => l.material.color.copy(color(i === 3 ? "--accent-ui" : "--border-strong"))); request(); };
    const fly = (target: Vector3, distance: number) => {
      cancelAnimationFrame(tween);
      const from = camera.position.clone(), startTarget = controls.target.clone();
      const direction = props.flat ? new Vector3(0,0,1) : from.clone().sub(startTarget).normalize();
      const to = target.clone().addScaledVector(direction, distance);
      const duration = readProfile().dist === 0 ? 0 : 250 * readProfile().time;
      const start = performance.now();
      const step = (now: number) => { const t = duration ? Math.min(1,(now-start)/duration) : 1; const eased = 1-Math.pow(1-t,3); camera.position.lerpVectors(from,to,eased); controls.target.lerpVectors(startTarget,target,eased); controls.update(); request(); if (t<1 && !dead) tween=requestAnimationFrame(step); };
      step(start);
    };
    const fit = () => {
      const ps = Object.values(props.positions); if (!ps.length) return;
      const min = new Vector3(Infinity,Infinity,Infinity), max = new Vector3(-Infinity,-Infinity,-Infinity);
      for (const p of ps) {min.min(new Vector3(p.x,p.y,p.z));max.max(new Vector3(p.x,p.y,p.z));}
      const center = min.clone().add(max).multiplyScalar(.5), extent = Math.max(240, max.x-min.x, max.y-min.y, max.z-min.z);
      if (camera instanceof OrthographicCamera) {camera.zoom=700/extent;camera.updateProjectionMatrix();}
      fly(center, extent*1.8);
    };
    const focus = (id: string) => {const p=props.positions[id];if(p) fly(new Vector3(p.x,p.y,p.z), Math.min(650,camera.position.distanceTo(controls.target)));};
    props.api.current = { fit, focus, camera: capture };
    const ray = new Raycaster(), pointer = new Vector2();
    const pick = (e: PointerEvent | MouseEvent) => { const r=canvas.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2);ray.setFromCamera(pointer,camera);const hit=ray.intersectObjects(meshes)[0];return hit && hit.instanceId !== undefined ? nodesByMesh.get(hit.object as InstancedMesh)?.[hit.instanceId] : undefined; };
    let drag: { x:number; y:number; node?: MapNode; point?:Vector3; plane?:Plane; moved:boolean } | null=null;
    const box = document.createElement("div"); box.className="map-selection-box";box.hidden=true;el.append(box);
    const down = (e: PointerEvent) => {
      cancelAnimationFrame(tween); if(e.button!==0) return;
      const node=pick(e);drag={x:e.clientX,y:e.clientY,node,moved:false};
      if(current.current.tool!=="navigate") {
        controls.enabled=false;canvas.setPointerCapture(e.pointerId);
        if(node && current.current.tool==="move") {const p=props.positions[node.id];drag.point=new Vector3(p.x,p.y,p.z);drag.plane=new Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new Vector3()),drag.point);}
      }
    };
    const move = (e: PointerEvent) => {
      if(drag) {
        drag.moved ||= Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>4;
        if(current.current.tool==="move" && drag.node && drag.plane) {
          pick(e); const p=ray.ray.intersectPlane(drag.plane,new Vector3());
          if(p) {localPositions[drag.node.id]={x:p.x,y:p.y,z:props.flat?0:p.z};for(const mesh of meshes){const index=nodesByMesh.get(mesh)!.findIndex(n=>n.id===drag!.node!.id);if(index>=0){const matrix=new Matrix4();mesh.getMatrixAt(index,matrix);matrix.setPosition(p.x,p.y,props.flat?0:p.z);mesh.setMatrixAt(index,matrix);mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();}}request();}
        }
        if(current.current.tool==="select") { const r=el.getBoundingClientRect();box.hidden=false;Object.assign(box.style,{left:`${Math.min(e.clientX,drag.x)-r.left}px`,top:`${Math.min(e.clientY,drag.y)-r.top}px`,width:`${Math.abs(e.clientX-drag.x)}px`,height:`${Math.abs(e.clientY-drag.y)}px`}); }
      } else { const n=pick(e);if(hover!==n?.id){hover=n?.id??null;canvas.style.cursor=hover?"pointer":"grab";request();} }
    };
    const up = (e: PointerEvent) => {
      if(!drag) return;const start=drag;drag=null;box.hidden=true;controls.enabled=true;
      if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
      const node=pick(e);
      if(current.current.tool==="connect" && start.node && node && node.id!==start.node.id) current.current.onConnect(start.node.id,node.id);
      else if(current.current.tool==="move" && start.node && start.plane && start.moved) {const p=ray.ray.intersectPlane(start.plane,new Vector3());if(p)current.current.onPin(start.node.id,{x:p.x,y:p.y,z:props.flat?0:p.z});}
      else if(current.current.tool==="select" && start.moved) {const r=canvas.getBoundingClientRect();current.current.onSelect(props.data.nodes.filter(n=>{const p=props.positions[n.id],v=new Vector3(p.x,p.y,p.z).project(camera);const x=r.left+(v.x+1)*r.width/2,y=r.top+(1-v.y)*r.height/2;return v.z>=-1&&v.z<=1&&x>=Math.min(start.x,e.clientX)&&x<=Math.max(start.x,e.clientX)&&y>=Math.min(start.y,e.clientY)&&y<=Math.max(start.y,e.clientY);}).map(n=>n.id));}
      else if(!start.moved) {if(node){const ids=current.current.selected;current.current.onSelect(e.ctrlKey||e.metaKey?ids.includes(node.id)?ids.filter(id=>id!==node.id):[...ids,node.id]:[node.id]);focus(node.id);}else current.current.onSelect([]);}
    };
    const double = (e: MouseEvent) => {const n=pick(e);if(n)current.current.onOpen(n);};
    const key = (e: KeyboardEvent) => {if(e.key==="Home"){e.preventDefault();fit();}if(e.key==="Escape"){drag=null;box.hidden=true;controls.enabled=true;current.current.onSelect([]);}if(e.key==="Enter"){const n=at.get(current.current.selected[0]);if(n)current.current.onOpen(n);}};
    const lost = (e: Event) => {e.preventDefault();current.current.onError();};
    canvas.addEventListener("pointerdown",down,true);canvas.addEventListener("pointermove",move);canvas.addEventListener("pointerup",up);canvas.addEventListener("dblclick",double);canvas.addEventListener("keydown",key);canvas.addEventListener("webglcontextlost",lost);
    controls.addEventListener("change",request);
    const observer=new ResizeObserver(resize);observer.observe(el);
    const themeObserver=new MutationObserver(theme);themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:["style","data-theme","data-motion"]});
    document.addEventListener("visibilitychange",request);
    const scheme=window.matchMedia("(prefers-color-scheme: dark)");scheme.addEventListener("change",theme);
    resize();theme();
    const saved=props.initialCamera;
    if(saved && [...saved.position,...saved.target,saved.zoom].every(Number.isFinite)) {camera.position.fromArray(saved.position);controls.target.fromArray(saved.target);camera.zoom=saved.zoom;camera.updateProjectionMatrix();controls.update();request();}else fit();
    return () => {
      dead=true;cancelAnimationFrame(raf);cancelAnimationFrame(tween);props.api.current=null;
      observer.disconnect();themeObserver.disconnect();document.removeEventListener("visibilitychange",request);scheme.removeEventListener("change",theme);controls.dispose();
      meshes.forEach(m=>{m.geometry.dispose();(m.material as MeshBasicMaterial).dispose();m.dispose();});lines.forEach(l=>{l.geometry.dispose();l.material.dispose();});renderer.dispose();canvas.remove();probe.remove();box.remove();layer.replaceChildren();
    };
  }, [props.data,props.positions,props.flat]);
  useEffect(() => paint.current(), [props.selected]);
  return <div className="map-canvas" ref={host}><div className="map-labels" ref={labels} /></div>;
}

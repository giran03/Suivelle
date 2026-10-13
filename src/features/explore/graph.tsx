import { useEffect, useMemo, useRef, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { LinkGraph } from "../../types";
import { useExplore } from "./store";

export interface Point { id: string; title: string; x: number; y: number; degree: number }

/**
 * A small force-directed layout: nodes push apart, links pull together, everything drifts to
 * the centre. Deterministic (nodes start on a circle), so the same workspace looks the same.
 */
export function layout(graph: LinkGraph, iterations = 220): Point[] {
  const n = graph.nodes.length;
  const index = new Map(graph.nodes.map((p, i) => [p.id, i]));
  const edges = graph.edges.map(([a, b]) => [index.get(a), index.get(b)]).filter((e): e is [number, number] => e[0] !== undefined && e[1] !== undefined);
  const degree = new Array(n).fill(0);
  for (const [a, b] of edges) { degree[a]++; degree[b]++; }
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = (i / Math.max(1, n)) * Math.PI * 2; const r = 120 + (i % 7) * 18; x[i] = Math.cos(a) * r; y[i] = Math.sin(a) * r; }
  const steps = n > 600 ? Math.min(iterations, 60) : iterations;
  for (let step = 0; step < steps; step++) {
    const heat = 1 - step / steps;
    const dx = new Float64Array(n), dy = new Float64Array(n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const ox = x[i] - x[j], oy = y[i] - y[j];
      const d2 = ox * ox + oy * oy + 0.01;
      const f = 1800 / d2;
      dx[i] += ox * f; dy[i] += oy * f; dx[j] -= ox * f; dy[j] -= oy * f;
    }
    for (const [a, b] of edges) {
      const ox = x[b] - x[a], oy = y[b] - y[a];
      const d = Math.sqrt(ox * ox + oy * oy) + 0.01;
      const f = (d - 70) * 0.04;
      dx[a] += (ox / d) * f; dy[a] += (oy / d) * f; dx[b] -= (ox / d) * f; dy[b] -= (oy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      dx[i] -= x[i] * 0.01; dy[i] -= y[i] * 0.01;
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const cap = 12 * heat + 0.5;
      x[i] += (dx[i] / len) * Math.min(len, cap); y[i] += (dy[i] / len) * Math.min(len, cap);
    }
  }
  return graph.nodes.map((p, i) => ({ id: p.id, title: p.title || "Untitled", x: x[i], y: y[i], degree: degree[i] }));
}

/** A theme token as a colour a canvas understands (tokens use light-dark(), which canvas cannot parse). */
const color = (name: string) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value || "#888";
};

/** The link graph of the workspace. Click a page to open it; drag to pan; scroll to zoom. A list view gives the same links without a pointer. */
export function GraphPanel() {
  const workspaceId = useWorkspace((s) => s.workspace?.id);
  const current = useWorkspace((s) => s.selectedPageId);
  const [graph, setGraph] = useState<LinkGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asList, setAsList] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ x: 0, y: 0, scale: 1, hover: -1 });
  useEffect(() => { if (workspaceId) ipc.linkGraph(workspaceId).then(setGraph, (e) => setError(toAppError(e).message)); }, [workspaceId]);
  const points = useMemo(() => (graph ? layout(graph) : []), [graph]);
  const edges = useMemo(() => {
    const at = new Map(points.map((p, i) => [p.id, i]));
    return (graph?.edges ?? []).map(([a, b]) => [at.get(a), at.get(b)]).filter((e): e is [number, number] => e[0] !== undefined && e[1] !== undefined);
  }, [graph, points]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || asList || !points.length) return;
    const ctx = el.getContext("2d")!;
    const palette = { line: color("--border"), node: color("--text-muted"), accent: color("--accent"), text: color("--fg"), font: `12px ${getComputedStyle(document.body).fontFamily}` };
    // Start framed on the whole graph: centre its bounds and scale it to fit, with room for labels.
    let fitted = false;
    const frame = (w: number, h: number) => {
      const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      view.current.x = -(minX + maxX) / 2;
      view.current.y = -(minY + maxY) / 2;
      view.current.scale = Math.min(1.6, (w - 160) / Math.max(1, maxX - minX), (h - 60) / Math.max(1, maxY - minY));
      fitted = true;
    };
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth, h = el.clientHeight;
      if (!fitted && w && h) frame(w, h);
      el.width = w * dpr; el.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const v = view.current;
      const sx = (p: Point) => w / 2 + (p.x + v.x) * v.scale, sy = (p: Point) => h / 2 + (p.y + v.y) * v.scale;
      ctx.strokeStyle = palette.line; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [a, b] of edges) { ctx.moveTo(sx(points[a]), sy(points[a])); ctx.lineTo(sx(points[b]), sy(points[b])); }
      ctx.stroke();
      points.forEach((p, i) => {
        const r = 3 + Math.min(9, Math.sqrt(p.degree) * 2);
        ctx.fillStyle = p.id === current || i === v.hover ? palette.accent : palette.node;
        ctx.beginPath(); ctx.arc(sx(p), sy(p), r, 0, Math.PI * 2); ctx.fill();
        if (points.length <= 40 || p.degree >= 3 || i === v.hover || p.id === current || v.scale > 1.6) {
          ctx.fillStyle = palette.text; ctx.font = palette.font;
          ctx.fillText(p.title.slice(0, 40), sx(p) + r + 3, sy(p) + 4);
        }
      });
    };
    const pick = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect(), v = view.current;
      const px = (e.clientX - rect.left - rect.width / 2) / v.scale - v.x, py = (e.clientY - rect.top - rect.height / 2) / v.scale - v.y;
      let best = -1, bestD = (12 / v.scale) ** 2;
      points.forEach((p, i) => { const d = (p.x - px) ** 2 + (p.y - py) ** 2; if (d < bestD) { bestD = d; best = i; } });
      return best;
    };
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const down = (e: MouseEvent) => { drag = { x: e.clientX, y: e.clientY, moved: false }; };
    const move = (e: MouseEvent) => {
      if (drag) {
        const v = view.current;
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 2) drag.moved = true;
        v.x += (e.clientX - drag.x) / v.scale; v.y += (e.clientY - drag.y) / v.scale;
        drag.x = e.clientX; drag.y = e.clientY;
      } else {
        const hover = pick(e);
        if (hover === view.current.hover) return;
        view.current.hover = hover;
        el.style.cursor = hover >= 0 ? "pointer" : "grab";
      }
      draw();
    };
    const up = (e: MouseEvent) => {
      const clicked = drag && !drag.moved ? pick(e) : -1;
      drag = null;
      if (clicked >= 0) { useExplore.getState().hide(); void useWorkspace.getState().selectPage(points[clicked].id); }
    };
    const wheel = (e: WheelEvent) => { e.preventDefault(); view.current.scale = Math.min(4, Math.max(0.2, view.current.scale * (e.deltaY < 0 ? 1.1 : 0.9))); draw(); };
    const resize = new ResizeObserver(draw);
    resize.observe(el);
    el.addEventListener("mousedown", down); window.addEventListener("mousemove", move); window.addEventListener("mouseup", up); el.addEventListener("wheel", wheel, { passive: false });
    draw();
    return () => { resize.disconnect(); el.removeEventListener("mousedown", down); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); el.removeEventListener("wheel", wheel); };
  }, [points, edges, asList, current]);

  if (error) return <p className="field-error" role="alert">{error}</p>;
  if (!graph) return <p className="picker-muted" role="status">Drawing the graph…</p>;
  if (!graph.nodes.length) return <p className="picker-muted">No pages yet.</p>;
  const ranked = [...points].sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title));
  return <div className="explore-graph">
    <div className="explore-graph-bar">
      <span className="picker-muted">{points.length} pages · {edges.length} links</span>
      <button type="button" className="btn ghost" aria-pressed={asList} onClick={() => setAsList(!asList)}>{asList ? "Show graph" : "Show as list"}</button>
    </div>
    {asList
      ? <ul className="explore-list">{ranked.map((p) => <li key={p.id}>
          <button type="button" className="explore-row" onClick={() => { useExplore.getState().hide(); void useWorkspace.getState().selectPage(p.id); }}>
            <span className="explore-row-main">{p.title}</span><small>{p.degree} {p.degree === 1 ? "link" : "links"}</small>
          </button></li>)}</ul>
      : <canvas ref={canvas} className="graph-canvas" role="img" aria-label={`Link graph of ${points.length} pages. Use “Show as list” for a keyboard-friendly view.`} />}
  </div>;
}

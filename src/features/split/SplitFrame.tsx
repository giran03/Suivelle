import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { useLayout } from "../../stores/layout";
import { useDockHint } from "./dropOnSplit";
import { useSplit } from "./store";
import { dividers, MIN_PANE_H, MIN_PANE_W, normalize, rects, type Divider, type Rect } from "./tree";
import "./split.css";

const SplitPane = lazy(() => import("./SplitPane").then((m) => ({ default: m.SplitPane })));

const KEY_STEP = 0.05;
const SINGLE: Rect = { x: 0, y: 0, w: 1, h: 1 };

const place = (r: Rect = SINGLE): React.CSSProperties => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.w * 100}%`,
  height: `${r.h * 100}%`,
});

function DividerHandle({ handle, area }: { handle: Divider; area: React.RefObject<HTMLDivElement | null> }) {
  const col = handle.axis === "x";
  const now = useSplit((s) => {
    let node = s.tree;
    for (const i of handle.path) node = "kids" in node ? node.kids[i] : node;
    return "sizes" in node ? Math.round((normalize(node.sizes)[handle.index] ?? 0) * 100) : 0;
  });
  const resize = useSplit.getState().resizeAt;
  /** The least share of this split a pane may take: a fixed pixel size, never below the base minimum. */
  const minShare = () => {
    const box = area.current?.getBoundingClientRect();
    if (!box) return undefined;
    const total = col ? handle.node.w * box.width : handle.node.h * box.height;
    return total > 0 ? (col ? MIN_PANE_W : MIN_PANE_H) / total : undefined;
  };
  const frame = (el: HTMLElement | null) => el?.closest<HTMLElement>(".split-grid");
  return (
    <div
      className={`split-divider ${col ? "col" : "row"}`}
      role="separator"
      tabIndex={0}
      aria-orientation={col ? "vertical" : "horizontal"}
      aria-label={col ? "Resize panes horizontally" : "Resize panes vertically"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={now}
      style={{
        left: `${handle.x * 100}%`,
        top: `${handle.y * 100}%`,
        width: col ? undefined : `${handle.w * 100}%`,
        height: col ? `${handle.h * 100}%` : undefined,
      }}
      onDoubleClick={() => useSplit.getState().evenOut()}
      onKeyDown={(e) => {
        const keys = col ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
        if (!keys.includes(e.key)) return;
        e.preventDefault();
        resize(handle.path, handle.index, e.key === keys[0] ? -KEY_STEP : KEY_STEP, minShare());
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.active = "";
        frame(e.currentTarget)?.setAttribute("data-resizing", "");
      }}
      onPointerUp={(e) => { delete e.currentTarget.dataset.active; frame(e.currentTarget)?.removeAttribute("data-resizing"); }}
      onPointerCancel={(e) => { delete e.currentTarget.dataset.active; frame(e.currentTarget)?.removeAttribute("data-resizing"); }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId) || !area.current) return;
        const box = area.current.getBoundingClientRect();
        const n = handle.node;
        // Where the divider should be, as a share of the split it belongs to; its track meets the pointer.
        const target = col ? (e.clientX - box.left - n.x * box.width) / (n.w * box.width) : (e.clientY - box.top - n.y * box.height) / (n.h * box.height);
        let node = useSplit.getState().tree;
        for (const i of handle.path) node = "kids" in node ? node.kids[i] : node;
        if (!("sizes" in node)) return;
        const edge = normalize(node.sizes).slice(0, handle.index + 1).reduce((a, b) => a + b, 0);
        if (Math.abs(target - edge) > 0.0005) resize(handle.path, handle.index, target - edge, minShare());
      }}
    />
  );
}

const HINT: Record<string, { label: string; icon: IconName }> = {
  left: { label: "Open on the left", icon: "columns" },
  right: { label: "Open on the right", icon: "columns" },
  top: { label: "Open above", icon: "feed" },
  bottom: { label: "Open below", icon: "feed" },
  center: { label: "Swap panes", icon: "restore" },
};

/**
 * While a tab, page or pane is dragged: every pane edge pulses (see EdgeCues), and the edge under the
 * pointer lights up with a glow and a skeleton of the pane that would open there.
 */
function DockHint() {
  const live = useDockHint((s) => s.target);
  // Keep the last target while the hint fades out, so it dissolves where it was instead of sliding to the corner.
  const last = useRef(live);
  if (live) last.current = live;
  const target = live ?? last.current;
  // The first frame of a drag snaps into place; only moves between zones glide.
  const wasLive = useRef(false);
  const snap = !wasLive.current && Boolean(live);
  wasLive.current = Boolean(live);
  const info = target ? HINT[target.zone] : null;
  return (
    <div className="dock-hint" data-zone={target?.zone} data-on={live ? "" : undefined} data-snap={snap ? "" : undefined} aria-hidden="true" style={target ? { left: target.rect.left, top: target.rect.top, width: target.rect.width, height: target.rect.height } : undefined}>
      <span className="dock-edge" />
      <span className="dock-skel">
        <i className="dock-skel-tab" />
        <i className="dock-skel-bar" />
        <i style={{ width: "78%" }} /><i style={{ width: "62%" }} /><i style={{ width: "70%" }} /><i style={{ width: "44%" }} />
      </span>
      {info && <span className="dock-label"><Icon name={info.icon} size={20} />{info.label}</span>}
    </div>
  );
}

/** Four edge strips per pane; they only show while something is being dragged. */
function EdgeCues() {
  return <span className="dock-cues" aria-hidden="true"><i data-edge="left" /><i data-edge="right" /><i data-edge="top" /><i data-edge="bottom" /></span>;
}

/**
 * Lays the main view out beside the other panes. The main view always renders inside the frame so
 * opening or closing a split moves it instead of remounting it; narrow windows keep the split in
 * memory but show the main view alone.
 */
export function SplitFrame({ children }: { children: React.ReactNode }) {
  const tree = useSplit((s) => s.tree);
  const panes = useSplit((s) => s.panes);
  const compact = useLayout((s) => s.compact);
  const area = useRef<HTMLDivElement>(null);
  const spots = useMemo(() => rects(tree), [tree]);
  const seams = useMemo(() => dividers(tree), [tree]);

  // A closed pane leaves a ghost that shrinks and fades where it was, as in Octopolis.
  const [ghosts, setGhosts] = useState<{ key: number; rect: Rect }[]>([]);
  const before = useRef({ panes, spots });
  const ghostKey = useRef(0);
  useLayoutEffect(() => {
    const prev = before.current;
    before.current = { panes, spots };
    if (panes.length >= prev.panes.length || window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced") return;
    const remaining = [...panes];
    const made: { key: number; rect: Rect }[] = [];
    prev.panes.forEach((id, i) => {
      const at = remaining.indexOf(id);
      if (at >= 0) { remaining.splice(at, 1); return; }
      const rect = prev.spots.get(i + 1);
      if (rect) made.push({ key: ++ghostKey.current, rect });
    });
    if (!made.length) return;
    setGhosts((g) => [...g, ...made]);
    const keys = new Set(made.map((m) => m.key));
    window.setTimeout(() => setGhosts((g) => g.filter((x) => !keys.has(x.key))), 280);
  }, [panes, spots]);

  if (compact) return <>{children}</>;
  return (
    <div ref={area} className="split-grid" data-split={panes.length ? "" : undefined}>
      <div className="split-cell split-main" data-split-slot={0} style={place(spots.get(0))}>
        {children}
        <EdgeCues />
      </div>
      {panes.map((pageId, i) => (
        <div key={i} className="split-cell" data-split-slot={i + 1} style={place(spots.get(i + 1))}>
          <Suspense fallback={null}><SplitPane slot={i + 1} pageId={pageId} /></Suspense>
          <EdgeCues />
        </div>
      ))}
      {seams.map((h) => <DividerHandle key={`${h.path.join(".")}/${h.index}`} handle={h} area={area} />)}
      {ghosts.map((g) => <div key={g.key} className="split-ghost" style={place(g.rect)} aria-hidden="true"><div /></div>)}
      <DockHint />
    </div>
  );
}

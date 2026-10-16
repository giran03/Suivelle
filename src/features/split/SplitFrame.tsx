import { lazy, Suspense, useMemo, useRef } from "react";
import { useLayout } from "../../stores/layout";
import { useDockHint } from "./dropOnSplit";
import { useSplit } from "./store";
import { dividers, normalize, rects, type Divider, type Rect } from "./tree";
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
        resize(handle.path, handle.index, e.key === keys[0] ? -KEY_STEP : KEY_STEP);
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
        if (Math.abs(target - edge) > 0.0005) resize(handle.path, handle.index, target - edge);
      }}
    />
  );
}

/** Outlines where the dragged page would land while a tab, page or pane is being dragged over the split. */
function DockHint() {
  const target = useDockHint((s) => s.target);
  return (
    <div className="dock-hint" data-zone={target?.zone} data-on={target ? "" : undefined} aria-hidden="true" style={target ? { left: target.rect.left, top: target.rect.top, width: target.rect.width, height: target.rect.height } : undefined} />
  );
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

  if (compact) return <>{children}</>;
  return (
    <div ref={area} className="split-grid" data-split={panes.length ? "" : undefined}>
      <div className="split-cell split-main" data-split-slot={0} style={place(spots.get(0))}>
        {children}
      </div>
      {panes.map((pageId, i) => (
        <div key={i} className="split-cell" data-split-slot={i + 1} style={place(spots.get(i + 1))}>
          <Suspense fallback={null}><SplitPane slot={i + 1} pageId={pageId} /></Suspense>
        </div>
      ))}
      {seams.map((h) => <DividerHandle key={`${h.path.join(".")}/${h.index}`} handle={h} area={area} />)}
      <DockHint />
    </div>
  );
}

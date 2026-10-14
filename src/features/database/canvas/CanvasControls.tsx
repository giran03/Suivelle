import { useEffect, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../../../components/ContextMenu";
import { type Align, type Box, bounds, type Viewport } from "./viewport";

/** Stroke icons for the canvas controls, drawn on a 16 px grid like the app's own icon set. */
const PATHS = {
  select: "M3.5 2.5l8 4.2-3.4 1.1-1.1 3.4z",
  hand: "M5.5 8V4a1 1 0 0 1 2 0v3M7.5 7V3a1 1 0 0 1 2 0v4M9.5 7V4a1 1 0 0 1 2 0v5.5a4 4 0 0 1-4 4h-.5a4 4 0 0 1-3-1.4L2.5 9.5a1 1 0 0 1 1.6-1.2L5.5 10",
  note: "M3 3h10v7l-3 3H3zM10 13v-3h3",
  image: "M2.5 3.5h11v9h-11zM2.5 11l3.5-3.5 3 3 1.5-1.5 3 3M10.5 6h.01",
  undo: "M5.5 3L2.5 6l3 3M2.5 6h6a4 4 0 0 1 0 8H6",
  redo: "M10.5 3l3 3-3 3M13.5 6h-6a4 4 0 0 0 0 8H10",
  minus: "M3.5 8h9",
  plus: "M8 3.5v9M3.5 8h9",
  fit: "M2.5 6V3.5H5M11 3.5h2.5V6M13.5 10v2.5H11M5 12.5H2.5V10M5.5 6h5v4h-5z",
  focus: "M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M5.5 5.5h5v5h-5z",
  map: "M2.5 3.5h11v9h-11zM8 7.5h4.5v5H8z",
  alignLeft: "M2.5 2.5v11M5 4.5h8M5 9.5h5",
  alignCenter: "M8 2.5v11M3.5 4.5h9M5 9.5h6",
  alignRight: "M13.5 2.5v11M3 4.5h8M6 9.5h5",
  alignTop: "M2.5 2.5h11M4.5 5v8M9.5 5v5",
  alignMiddle: "M2.5 8h11M4.5 3.5v9M9.5 5v6",
  alignBottom: "M2.5 13.5h11M4.5 3v8M9.5 6v5",
  distributeX: "M2.5 2.5v11M13.5 2.5v11M6.5 5h3v6h-3z",
  distributeY: "M2.5 2.5h11M2.5 13.5h11M5 6.5h6v3H5z",
  front: "M6 6h7.5v7.5H6zM3.5 10.5V3.5h7",
  back: "M2.5 2.5h7.5v7.5H2.5zM12.5 6v7.5H6",
  duplicate: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  trash: "M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.6 9h5.8l.6-9M7 7v4M9 7v4",
  palette: "M8 2.5a5.5 5.5 0 1 0 0 11c1 0 1.5-.7 1.5-1.4 0-.9-.8-1.1-.8-1.9 0-.7.6-1.2 1.4-1.2h1.4a2.4 2.4 0 0 0 2.4-2.4C13.9 4.4 11.3 2.5 8 2.5zM5 8h.01M6.5 5.5h.01M9.5 5.5h.01",
  page: "M4 2.5h5.5L12.5 5.5v8h-8.5zM9.5 2.5v3h3M6 8.5h4.5M6 11h4.5",
  snap: "M3 3v10M13 3v10M3 8h10M6 5.5l2 2.5 2-2.5",
} as const;
export type CanvasIconName = keyof typeof PATHS;

export function CIcon({ name, size = 16 }: { name: CanvasIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** A palette button beside the presets that opens the system color picker; edits settle before they are saved. */
function CustomColor({ value, onChange }: { value: string | null; onChange: (c: string) => void }) {
  const hex = value && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <label className={`cv-tool cv-custom${hex ? " on" : ""}`} title="Custom color" style={hex ? ({ "--custom": hex } as React.CSSProperties) : undefined}>
      <CIcon name="palette" />
      <input
        type="color"
        aria-label="Custom note color"
        value={hex ?? "#fff4b8"}
        onChange={(e) => {
          const v = e.currentTarget.value;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => onChange(v), 200);
        }}
      />
    </label>
  );
}

/** The pills live inside the board, which starts selecting or panning on any press; keep presses on a control to the control. */
const own = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
  onContextMenu: (e: React.MouseEvent) => e.stopPropagation(),
};

export function Tool({ icon, label, hint, on, disabled, onClick, children }: { icon: CanvasIconName; label: string; hint?: string; on?: boolean; disabled?: boolean; onClick: () => void; children?: React.ReactNode }) {
  return (
    <button type="button" className={`cv-tool${on ? " on" : ""}`} aria-label={hint ? `${label} (${hint})` : label} title={hint ? `${label} (${hint})` : label} aria-pressed={on} disabled={disabled} onClick={onClick}>
      <CIcon name={icon} />
      {children}
    </button>
  );
}

export type CanvasTool = "select" | "hand";

/** The floating tool pill: choose Select or Hand, add things, undo and redo. */
export function ToolPill({ tool, onTool, readOnly, canUndo, canRedo, onNote, onImage, extraTools, onUndo, onRedo }: {
  tool: CanvasTool;
  onTool: (t: CanvasTool) => void;
  readOnly: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onNote: () => void;
  onImage: () => void;
  /** Source-specific tools placed after Note and Image. */
  extraTools?: React.ReactNode;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div className="cv-pill cv-tools" role="toolbar" aria-label="Canvas tools" {...own}>
      <Tool icon="select" label="Select" hint="V" on={tool === "select"} onClick={() => onTool("select")} />
      <Tool icon="hand" label="Hand: drag to pan" hint="H" on={tool === "hand"} onClick={() => onTool("hand")} />
      {!readOnly && (
        <>
          <span className="cv-sep" aria-hidden="true" />
          <Tool icon="note" label="Add note" hint="N" onClick={onNote} />
          <Tool icon="image" label="Add image" hint="I" onClick={onImage} />
          {extraTools}
          <span className="cv-sep" aria-hidden="true" />
          <Tool icon="undo" label="Undo" hint="Ctrl+Z" disabled={!canUndo} onClick={onUndo} />
          <Tool icon="redo" label="Redo" hint="Ctrl+Shift+Z" disabled={!canRedo} onClick={onRedo} />
        </>
      )}
    </div>
  );
}

/** Zoom out, the zoom readout with its menu, zoom in, and a one-click "fit everything". */
export function ZoomPill({ zoom, hasSelection, snapping, minimap, onZoomOut, onZoomIn, onZoomTo, onFit, onFitSelection, onToggleSnap, onToggleMinimap }: {
  zoom: number;
  hasSelection: boolean;
  snapping: boolean;
  minimap: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onZoomTo: (k: number) => void;
  onFit: () => void;
  onFitSelection: () => void;
  onToggleSnap: () => void;
  onToggleMinimap: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const items: MenuItem[] = [
    { label: "Zoom to fit (Shift+1)", onSelect: onFit },
    { label: "Zoom to selection (Shift+2)", onSelect: onFitSelection, disabled: !hasSelection },
    { label: "Zoom to 50%", onSelect: () => onZoomTo(0.5), separated: true },
    { label: "Zoom to 100% (Shift+0)", onSelect: () => onZoomTo(1) },
    { label: "Zoom to 200%", onSelect: () => onZoomTo(2) },
    { label: `${snapping ? "Turn off" : "Turn on"} alignment guides`, onSelect: onToggleSnap, separated: true },
    { label: `${minimap ? "Hide" : "Show"} minimap`, onSelect: onToggleMinimap },
  ];
  return (
    <div className="cv-pill cv-zoom-pill" role="toolbar" aria-label="Zoom" {...own}>
      <Tool icon="minus" label="Zoom out" hint="Ctrl+-" onClick={onZoomOut} />
      <button
        ref={ref}
        type="button"
        className="cv-readout"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title="Zoom options"
        onClick={() => {
          const r = ref.current!.getBoundingClientRect();
          setMenu({ x: r.left, y: r.top - 8 - items.length * 30 });
        }}
      >
        {Math.round(zoom * 100)}%
      </button>
      <Tool icon="plus" label="Zoom in" hint="Ctrl++" onClick={onZoomIn} />
      <span className="cv-sep" aria-hidden="true" />
      <Tool icon="fit" label="Fit canvas to view" hint="Shift+1" onClick={onFit} />
      <Tool icon="map" label={minimap ? "Hide minimap" : "Show minimap"} on={minimap} onClick={onToggleMinimap} />
      {menu && <ContextMenu x={menu.x} y={Math.max(8, menu.y)} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}

const ALIGN: { how: Align; icon: CanvasIconName; label: string }[] = [
  { how: "left", icon: "alignLeft", label: "Align left" },
  { how: "center", icon: "alignCenter", label: "Align horizontal centers" },
  { how: "right", icon: "alignRight", label: "Align right" },
  { how: "top", icon: "alignTop", label: "Align top" },
  { how: "middle", icon: "alignMiddle", label: "Align vertical centers" },
  { how: "bottom", icon: "alignBottom", label: "Align bottom" },
];

/** What can be done to the current selection, shown above the board while something is selected. */
export function SelectionBar({ count, onlyNote, color, colors, canDuplicate, canDelete, onAlign, onDistribute, onColor, onFront, onBack, onDuplicate, onDelete, onFitSelection }: {
  count: number;
  onlyNote: boolean;
  color: string | null;
  colors: readonly string[];
  canDuplicate: boolean;
  canDelete: boolean;
  onAlign: (how: Align) => void;
  onDistribute: (axis: "x" | "y") => void;
  onColor: (c: string) => void;
  onFront: () => void;
  onBack: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onFitSelection: () => void;
}) {
  return (
    <div className="cv-pill cv-selbar" role="toolbar" aria-label="Selection" {...own}>
      <span className="cv-count">{count} selected</span>
      {count > 1 && (
        <>
          <span className="cv-sep" aria-hidden="true" />
          {ALIGN.map((a) => (
            <Tool key={a.how} icon={a.icon} label={a.label} onClick={() => onAlign(a.how)} />
          ))}
          {count > 2 && (
            <>
              <Tool icon="distributeX" label="Space evenly across" onClick={() => onDistribute("x")} />
              <Tool icon="distributeY" label="Space evenly down" onClick={() => onDistribute("y")} />
            </>
          )}
        </>
      )}
      {onlyNote && (
        <>
          <span className="cv-sep" aria-hidden="true" />
          <span className="cv-swatches" role="group" aria-label="Note color">
            {colors.map((c) => (
              <button key={c} type="button" className={`cv-swatch tone-${c}${color === c ? " on" : ""}`} aria-label={c} aria-pressed={color === c} onClick={() => onColor(c)} />
            ))}
            <CustomColor value={color} onChange={onColor} />
          </span>
        </>
      )}
      <span className="cv-sep" aria-hidden="true" />
      <Tool icon="focus" label="Zoom to selection" hint="Shift+2" onClick={onFitSelection} />
      <Tool icon="front" label="Bring forward" hint="]" onClick={onFront} />
      <Tool icon="back" label="Send backward" hint="[" onClick={onBack} />
      {canDuplicate && <Tool icon="duplicate" label="Duplicate" hint="Ctrl+D" onClick={onDuplicate} />}
      {canDelete && <Tool icon="trash" label="Delete" hint="Delete" onClick={onDelete} />}
    </div>
  );
}

const MAP_W = 176;
const MAP_H = 116;

/** A small overview of the whole board with the visible area outlined; click or drag to move there. */
export function Minimap({ items, vp, size, onNavigate }: { items: (Box & { id: string; kind: string })[]; vp: Viewport; size: { w: number; h: number }; onNavigate: (worldX: number, worldY: number) => void }) {
  const view: Box = { x: -vp.x / vp.k, y: -vp.y / vp.k, w: size.w / vp.k, h: size.h / vp.k };
  const all = bounds([...items, view]) ?? view;
  const pad = Math.max(all.w, all.h) * 0.06;
  const world = { x: all.x - pad, y: all.y - pad, w: all.w + pad * 2, h: all.h + pad * 2 };
  const scale = Math.min(MAP_W / world.w, MAP_H / world.h);
  const ox = (MAP_W - world.w * scale) / 2 - world.x * scale;
  const oy = (MAP_H - world.h * scale) / 2 - world.y * scale;
  const dragging = useRef(false);
  const go = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onNavigate((e.clientX - r.left - ox) / scale, (e.clientY - r.top - oy) / scale);
  };
  return (
    <svg
      className="cv-minimap"
      width={MAP_W}
      height={MAP_H}
      role="img"
      aria-label="Minimap of the canvas"
      onPointerDown={(e) => {
        e.stopPropagation();
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        go(e);
      }}
      onPointerMove={(e) => dragging.current && go(e)}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {items.map((i) => (
        <rect key={i.id} className={`cv-map-item ${i.kind}`} x={i.x * scale + ox} y={i.y * scale + oy} width={Math.max(2, i.w * scale)} height={Math.max(2, i.h * scale)} rx={1.5} />
      ))}
      <rect className="cv-map-view" x={view.x * scale + ox} y={view.y * scale + oy} width={view.w * scale} height={view.h * scale} rx={2} />
    </svg>
  );
}

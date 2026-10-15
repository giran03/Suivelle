import { Icon, type IconName } from "../../../components/Icon";
import { useEffect, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../../../components/ContextMenu";
import { type Align, type Box, bounds, type Viewport } from "./viewport";

const CANVAS_ICONS = {
  "select": "cursor",
  "hand": "hand",
  "note": "stickyNote",
  "image": "image",
  "undo": "undo",
  "redo": "redo",
  "minus": "minus",
  "plus": "plus",
  "fit": "fit",
  "focus": "focus",
  "map": "minimap",
  "alignLeft": "alignObjectsLeft",
  "alignCenter": "alignObjectsCenter",
  "alignRight": "alignObjectsRight",
  "alignTop": "alignTop",
  "alignMiddle": "alignMiddle",
  "alignBottom": "alignBottom",
  "distributeX": "distributeX",
  "distributeY": "distributeY",
  "front": "front",
  "back": "sendBack",
  "duplicate": "duplicate",
  "trash": "trash",
  "palette": "palette",
  "page": "page",
  "snap": "snap"
} as const satisfies Record<string, IconName>;
export type CanvasIconName = keyof typeof CANVAS_ICONS;

export function CIcon({ name, size = 16 }: { name: CanvasIconName; size?: number }) {
  return <Icon name={CANVAS_ICONS[name]} size={size} />;
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

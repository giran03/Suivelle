import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../../../components/ContextMenu";
import { thumbUrl } from "../../../lib/attachments";
import { READ_ONLY } from "../../../lib/access";
import { newId } from "../../../lib/ids";
import { ipc, toAppError } from "../../../lib/ipc";
import { useWorkspace } from "../../../stores/workspace";
import type { CanvasData, CanvasEdge, CanvasItem, CanvasOp } from "../../../types";
import { type CanvasTool, Minimap, SelectionBar, ToolPill, ZoomPill } from "./CanvasControls";
import "./canvas.css";
import type { useCanvas } from "./useCanvas";
import { useViewportMotion } from "./useViewportMotion";
import {
  type Align,
  alignBoxes,
  arrowBetween,
  type Box,
  bounds,
  clampZoom,
  DEFAULT_VIEWPORT,
  distributeBoxes,
  fitViewport,
  type Guide,
  intersects,
  normalizeBox,
  snapMove,
  stepZoom,
  toWorld,
  type Viewport,
  zoomTo,
  zoomToBox,
} from "./viewport";

const NOTE_W = 200;
const NOTE_H = 120;
const MIN_W = 80;
const MIN_H = 48;
const SNAP_PX = 6;
const NOTE_COLORS = ["yellow", "blue", "green", "pink"] as const;

const storageKey = (viewId: string) => `suivelle.canvas.${viewId}`;
function readViewport(viewId: string): Viewport | null {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey(viewId)) ?? "null");
    return v && [v.x, v.y, v.k].every(Number.isFinite) ? { x: v.x, y: v.y, k: clampZoom(v.k) } : null;
  } catch {
    return null;
  }
}
const isHexColor = (c: string | null): c is string => !!c && /^#[0-9a-f]{6}$/i.test(c);
/** Dark or light text, whichever reads better on a custom note color. */
const inkFor = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#2b2a24" : "#fdfcf8";
};

const readPref = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(`suivelle.canvas.${key}`);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
};
const writePref = (key: string, on: boolean) => {
  try {
    localStorage.setItem(`suivelle.canvas.${key}`, on ? "1" : "0");
  } catch {
    // a per-viewer convenience only
  }
};

type Drag =
  | { mode: "pan"; sx: number; sy: number; origin: Viewport }
  | { mode: "marquee"; start: { x: number; y: number }; base: ReadonlySet<string> }
  | { mode: "move"; sx: number; sy: number; starts: Map<string, CanvasItem>; before: CanvasData | null; moved: boolean }
  | { mode: "resize"; sx: number; sy: number; start: CanvasItem; before: CanvasData | null; moved: boolean }
  | { mode: "connect"; from: string };

interface NodeProps {
  item: CanvasItem;
  card: unknown;
  label: string;
  selected: boolean;
  editing: boolean;
  readOnly: boolean;
  renderCard: BoardProps["renderCard"];
  onDown: (e: React.PointerEvent, item: CanvasItem, handle: "body" | "resize" | "connect") => void;
  onEdit: (item: CanvasItem | null, text?: string) => void;
  onOpen: (item: CanvasItem) => void;
  onMenu: (e: React.MouseEvent, item: CanvasItem) => void;
}

const isCard = (i: CanvasItem) => i.kind === "record" || i.kind === "page";
const cardKey = (i: CanvasItem) => (i.kind === "record" ? i.recordId : i.kind === "page" ? (i.pageId ?? null) : null);

const Node = memo(function Node({ item, card, label, selected, editing, readOnly, renderCard, onDown, onEdit, onOpen, onMenu }: NodeProps) {
  const style: React.CSSProperties = { left: item.x, top: item.y, width: item.w, height: item.h, zIndex: item.z };
  const custom = item.kind === "note" && isHexColor(item.color) ? item.color : null;
  if (custom) Object.assign(style, { "--note-bg": custom, "--note-ink": inkFor(custom) });
  return (
    <div
      className={`cv-item kind-${item.kind}${selected ? " selected" : ""}${item.color && !custom ? ` tone-${item.color}` : ""}`}
      style={style}
      data-item-id={item.id}
      tabIndex={0}
      role="group"
      aria-label={isCard(item) ? label : item.kind === "note" ? "Note" : "Image"}
      onPointerDown={(e) => onDown(e, item, "body")}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (item.kind === "page" && (e.target as Element).closest("[data-canvas-editor]")) return;
        if (isCard(item)) onOpen(item);
        else if (item.kind === "note" && !readOnly) onEdit(item);
      }}
      onContextMenu={(e) => { if (item.kind === "page" && (e.target as Element).closest("[data-canvas-editor]")) { e.stopPropagation(); return; } onMenu(e, item); }}
    >
      {isCard(item) && renderCard(card, item, () => onOpen(item))}
      {item.kind === "note" &&
        (editing ? (
          <textarea
            className="cv-note-edit"
            autoFocus
            defaultValue={item.text}
            aria-label="Note text"
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => onEdit(null, e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") onEdit(null);
            }}
          />
        ) : (
          <p className="cv-note-text">{item.text || <span className="cell-placeholder">Double-click to write</span>}</p>
        ))}
      {item.kind === "image" && item.attachmentHash && <img className="cv-image" src={thumbUrl(item.attachmentHash, 640)} alt="" draggable={false} />}
      {!readOnly && (
        <>
          <span className="cv-handle connect" data-handle="connect" title="Drag to another item to draw an arrow" onPointerDown={(e) => onDown(e, item, "connect")} />
          <span className="cv-handle resize" data-handle="resize" title="Resize" onPointerDown={(e) => onDown(e, item, "resize")} />
        </>
      )}
    </div>
  );
});

/** What a canvas needs from the thing it is a canvas of: where its cards come from and what they show. */
export interface BoardProps {
  /** The view or board id: keys the saved viewport and the arrowhead marker. */
  scopeId: string;
  canvas: ReturnType<typeof useCanvas>;
  /** False until the cards' source (records, pages) has loaded; framing and the empty hint wait for it. */
  ready: boolean;
  /** True while cards the source holds are about to be placed, so the first framing waits for them. */
  awaitingPlacement?: boolean;
  /** Live data for each card, keyed by record id or page id. A card with no entry is not drawn. */
  cards: ReadonlyMap<string, unknown>;
  renderCard: (card: unknown, item: CanvasItem, open: () => void) => React.ReactNode;
  cardLabel: (card: unknown) => string;
  openCard: (card: unknown, item: CanvasItem) => void;
  cardMenu: (card: unknown, item: CanvasItem) => MenuItem[];
  /** Whether a selected card can be taken off the canvas (a view's cards are its records, so they stay). */
  removableCards: boolean;
  notice?: string | null;
  emptyHint?: string;
  /** Extra entries for the empty-space context menu, given the world point that was clicked. */
  boardMenu?: (at: { x: number; y: number }) => MenuItem[];
  /** Extra tools in the tool pill, after Note and Image. */
  tools?: React.ReactNode;
  /** Lets the source place things where the user is looking and take drops. */
  apiRef?: React.MutableRefObject<BoardApi | null>;
}

export interface BoardApi {
  /** The world point at the middle of what is on screen. */
  center: () => { x: number; y: number };
  /** The world point under a screen position, or null when it is outside the board. */
  worldAt: (clientX: number, clientY: number) => { x: number; y: number } | null;
  select: (ids: string[]) => void;
  /** The next z to put a new item on top. */
  topZ: () => number;
}

/**
 * A freeform board: cards, notes and images placed anywhere, joined by arrows.
 *
 * Moving around: scroll, pinch or the zoom buttons to zoom; drag with the Hand tool (H) or Space, or
 * Shift/Alt + scroll, to pan (Shift+1 fits everything, Shift+2 the selection). Working on it: drag the
 * background to select several items, double-click it for a note, drag from an item's edge dot to draw
 * an arrow, and Ctrl+Z undoes.
 */
export function CanvasBoard({ scopeId, canvas, ready, awaitingPlacement, cards, renderCard, cardLabel, openCard, cardMenu, removableCards, notice, emptyHint, boardMenu, tools, apiRef }: BoardProps) {
  const readOnly = READ_ONLY;
  const boardRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const drag = useRef<Drag | null>(null);
  const stored = useRef(readViewport(scopeId));
  const { vp, vpRef, jump, animateTo, zoomBy, cancel } = useViewportMotion(stored.current ?? DEFAULT_VIEWPORT);
  const framed = useRef(!!stored.current);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tool, setTool] = useState<CanvasTool>("select");
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [edgeSel, setEdgeSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [ghost, setGhost] = useState<{ from: string; x: number; y: number } | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [snapping, setSnapping] = useState(() => readPref("snap", true));
  const [minimap, setMinimap] = useState(() => readPref("minimap", false));
  const setError = useWorkspace((s) => s.setError);

  const items = useMemo(() => (canvas.data?.items ?? []).filter((i) => !isCard(i) || cards.has(cardKey(i) ?? "")), [canvas.data, cards]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const edges = useMemo(() => (canvas.data?.edges ?? []).filter((e) => itemById.has(e.fromItem) && itemById.has(e.toItem)), [canvas.data, itemById]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selItems = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected]);
  const handMode = tool === "hand" || spaceDown;
  const cardOf = (i: CanvasItem) => cards.get(cardKey(i) ?? "");

  // ---- viewport ----

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Remember where the board was left.
  useEffect(() => {
    if (!framed.current) return;
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(storageKey(scopeId), JSON.stringify(vp));
      } catch {
        // a per-viewer convenience only
      }
    }, 300);
    return () => window.clearTimeout(id);
  }, [vp, scopeId]);

  const dims = () => ({ w: boardRef.current?.clientWidth ?? 0, h: boardRef.current?.clientHeight ?? 0 });
  const fitAll = useCallback(
    (instant = false) => {
      const w = boardRef.current?.clientWidth ?? 0;
      const h = boardRef.current?.clientHeight ?? 0;
      if (!w) return;
      const target = fitViewport(bounds(itemsRef.current), w, h);
      if (instant) jump(target);
      else animateTo(target);
    },
    [jump, animateTo],
  );
  const fitSelection = () => {
    const { w, h } = dims();
    const b = bounds(selItems);
    if (b && w) animateTo(zoomToBox(b, w, h));
  };
  const zoomStep = (dir: 1 | -1) => {
    const { w, h } = dims();
    animateTo(zoomTo(vpRef.current, w / 2, h / 2, stepZoom(vpRef.current.k, dir)), 180);
  };
  const zoomPreset = (k: number) => {
    const { w, h } = dims();
    animateTo(zoomTo(vpRef.current, w / 2, h / 2, k));
  };

  useEffect(() => {
    if (framed.current || !canvas.data || !ready || !boardRef.current?.clientWidth) return;
    // Wait for cards that are about to be placed before framing what is there.
    if (!items.length && awaitingPlacement) return;
    framed.current = true;
    fitAll(true);
  }, [canvas.data, ready, awaitingPlacement, items.length, fitAll]);

  // The wheel zooms at the pointer, easing to the new zoom (a pinch arrives the same way, as Ctrl + wheel).
  // Shift + wheel pans sideways and Alt + wheel pans up and down; dragging with Space or the Hand tool pans freely.
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented) return;
      const pageBody = (e.target as Element).closest("[data-canvas-editor]");
      if (!e.ctrlKey && !e.metaKey && pageBody?.closest(".canvas-view") === el) return;
      e.preventDefault();
      setMenu(null);
      const rect = el.getBoundingClientRect();
      const lines = e.deltaMode === 1 ? 33 : 1;
      if (e.shiftKey || e.altKey) {
        cancel();
        const v = vpRef.current;
        // Some systems turn Shift + wheel into a horizontal delta already.
        const d = (e.deltaX || e.deltaY) * lines;
        jump(e.shiftKey ? { ...v, x: v.x - d } : { ...v, y: v.y - d });
        return;
      }
      // A pinch or a trackpad scroll sends many small deltas, a mouse wheel notch one large one: scale each to a similar feel.
      const dy = Math.max(-240, Math.min(240, e.deltaY * lines));
      zoomBy(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-dy * (Math.abs(dy) >= 50 ? 0.0018 : 0.009)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy, jump, cancel, vpRef]);

  const worldAt = (clientX: number, clientY: number) => {
    const rect = boardRef.current!.getBoundingClientRect();
    return toWorld(vpRef.current, clientX - rect.left, clientY - rect.top);
  };
  const viewCenter = () => {
    const { w, h } = dims();
    return toWorld(vpRef.current, w / 2, h / 2);
  };

  // ---- editing actions (each is one undo step) ----

  const topZ = () => itemsRef.current.reduce((m, i) => Math.max(m, i.z), 0) + 1;

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      center: viewCenter,
      worldAt: (x, y) => {
        const r = boardRef.current?.getBoundingClientRect();
        return r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? worldAt(x, y) : null;
      },
      select: (ids) => {
        setEdgeSel(null);
        setSelected(new Set(ids));
      },
      topZ,
    };
    return () => {
      apiRef.current = null;
    };
  });

  const addNote = (at?: { x: number; y: number }) => {
    if (readOnly) return;
    const c = at ?? viewCenter();
    const item: CanvasItem = { id: newId(), kind: "note", recordId: null, text: "", attachmentHash: null, x: Math.round(c.x - NOTE_W / 2), y: Math.round(c.y - NOTE_H / 2), w: NOTE_W, h: NOTE_H, z: topZ(), color: "yellow" };
    canvas.commit([{ op: "upsert_item", item }]);
    setTool("select");
    setSelected(new Set([item.id]));
    setEditing(item.id);
  };

  const addImage = async (file: File, at?: { x: number; y: number }) => {
    const ws = useWorkspace.getState().workspace;
    if (readOnly || !ws || !file.type.startsWith("image/")) return;
    try {
      const att = await ipc.attachmentImportBytes(ws.id, file.name || "Image", await file.arrayBuffer());
      let ratio = 0.75;
      try {
        const bmp = await createImageBitmap(file);
        ratio = bmp.height / bmp.width;
        bmp.close();
      } catch {
        // an unreadable size falls back to 4:3
      }
      const w = 320;
      const h = Math.min(4000, Math.max(MIN_H, Math.round(w * ratio)));
      const c = at ?? viewCenter();
      const item: CanvasItem = { id: newId(), kind: "image", recordId: null, text: "", attachmentHash: att.hash, x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2), w, h, z: topZ(), color: null };
      canvas.commit([{ op: "upsert_item", item }]);
      setSelected(new Set([item.id]));
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  const deletable = selItems.filter((i) => removableCards || !isCard(i));
  const removeSelection = () => {
    if (readOnly) return;
    if (edgeSel) {
      canvas.commit([{ op: "delete_edge", id: edgeSel }]);
      setEdgeSel(null);
      return;
    }
    // A view's record cards stay: the record is still in the view. Delete the record itself to take its card away.
    canvas.commit(deletable.map((i) => ({ op: "delete_item", id: i.id }) as CanvasOp));
    setSelected(new Set(selItems.filter((i) => !deletable.includes(i)).map((i) => i.id)));
  };

  const duplicateSelection = () => {
    if (readOnly || !deletable.length) return;
    const ids = new Map(deletable.map((i) => [i.id, newId()]));
    let z = topZ();
    const copies = deletable.map((i): CanvasOp => ({ op: "upsert_item", item: { ...i, id: ids.get(i.id)!, x: i.x + 24, y: i.y + 24, z: z++ } }));
    const arrows = edges.filter((e) => ids.has(e.fromItem) && ids.has(e.toItem)).map((e): CanvasOp => ({ op: "upsert_edge", edge: { ...e, id: newId(), fromItem: ids.get(e.fromItem)!, toItem: ids.get(e.toItem)! } }));
    canvas.commit([...copies, ...arrows]);
    setSelected(new Set(ids.values()));
  };

  const moveTo = (pos: Map<string, { x: number; y: number }>) => {
    const ops = selItems
      .filter((i) => pos.has(i.id) && (pos.get(i.id)!.x !== i.x || pos.get(i.id)!.y !== i.y))
      .map((i): CanvasOp => ({ op: "upsert_item", item: { ...i, x: Math.round(pos.get(i.id)!.x), y: Math.round(pos.get(i.id)!.y) } }));
    canvas.commit(ops);
  };
  const align = (how: Align) => !readOnly && moveTo(alignBoxes(selItems, how));
  const distribute = (axis: "x" | "y") => !readOnly && moveTo(distributeBoxes(selItems, axis));

  /** Moves the selection one overlapping item up or down, or all the way with "front" / "back". */
  const restack = (dir: "front" | "back" | "forward" | "backward") => {
    if (readOnly || !selItems.length) return;
    const ids = new Set(selItems.map((i) => i.id));
    const order = [...itemsRef.current].sort((a, b) => a.z - b.z);
    if (dir === "front" || dir === "back") {
      const picked = order.filter((i) => ids.has(i.id));
      const rest = order.filter((i) => !ids.has(i.id));
      order.splice(0, order.length, ...(dir === "front" ? [...rest, ...picked] : [...picked, ...rest]));
    } else {
      const up = dir === "forward";
      const at = (i: number) => (up ? order.length - 1 - i : i);
      for (let n = 0; n < order.length; n++) {
        const i = at(n);
        const item = order[i];
        if (!ids.has(item.id)) continue;
        for (let j = i + (up ? 1 : -1); j >= 0 && j < order.length; j += up ? 1 : -1) {
          if (ids.has(order[j].id) || !intersects(item, order[j])) continue;
          order.splice(i, 1);
          order.splice(j, 0, item);
          break;
        }
      }
    }
    const ops: CanvasOp[] = [];
    order.forEach((item, z) => {
      if (item.z !== z) ops.push({ op: "upsert_item", item: { ...item, z } });
    });
    if (ops.length) canvas.commit(ops);
  };

  const setColor = (color: string) => {
    const only = selItems.length === 1 ? selItems[0] : null;
    if (only && !readOnly) canvas.commit([{ op: "upsert_item", item: { ...only, color } }]);
  };

  const nudge = (dx: number, dy: number) => !readOnly && canvas.commit(selItems.map((i): CanvasOp => ({ op: "upsert_item", item: { ...i, x: i.x + dx, y: i.y + dy } })));

  const selectAll = () => {
    setEdgeSel(null);
    setSelected(new Set(items.map((i) => i.id)));
  };

  // ---- pointer ----

  const startPan = (e: React.PointerEvent) => {
    boardRef.current?.setPointerCapture(e.pointerId);
    cancel();
    drag.current = { mode: "pan", sx: e.clientX, sy: e.clientY, origin: vpRef.current };
    setPanning(true);
  };

  const onNodeDown = useCallback(
    (e: React.PointerEvent, item: CanvasItem, handle: "body" | "resize" | "connect") => {
      if (e.button !== 0) return;
      // Hand tool or Space: the whole board is a pan surface, items included.
      if (handMode) return;
      const target = e.target as HTMLElement;
      if (handle === "body" && item.kind === "page" && target.closest("[data-canvas-editor]")) { e.stopPropagation(); return; }
      if (handle === "body" && target.closest("button, textarea, input, a")) { e.stopPropagation(); return; }
      e.stopPropagation();
      boardRef.current?.focus({ preventScroll: true });
      boardRef.current?.setPointerCapture(e.pointerId);
      setMenu(null);
      if (handle === "connect") {
        const rect = boardRef.current!.getBoundingClientRect();
        const w = toWorld(vpRef.current, e.clientX - rect.left, e.clientY - rect.top);
        drag.current = { mode: "connect", from: item.id };
        setGhost({ from: item.id, x: w.x, y: w.y });
        return;
      }
      if (readOnly) {
        setSelected(new Set([item.id]));
        return;
      }
      const before = canvas.snapshot();
      if (handle === "resize") {
        drag.current = { mode: "resize", sx: e.clientX, sy: e.clientY, start: item, before, moved: false };
        return;
      }
      const keep = selected.has(item.id) && !e.shiftKey;
      const next = keep ? selected : e.shiftKey ? new Set([...selected, item.id]) : new Set([item.id]);
      setEdgeSel(null);
      setSelected(next);
      const starts = new Map<string, CanvasItem>();
      for (const i of itemsRef.current) if (next.has(i.id)) starts.set(i.id, i);
      drag.current = { mode: "move", sx: e.clientX, sy: e.clientY, starts, before, moved: false };
    },
    [selected, canvas, readOnly, handMode, vpRef],
  );

  const onBoardDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    boardRef.current?.focus({ preventScroll: true });
    setMenu(null);
    if (e.button === 1 || handMode) {
      e.preventDefault();
      return startPan(e);
    }
    boardRef.current?.setPointerCapture(e.pointerId);
    const base: ReadonlySet<string> = e.shiftKey ? selected : new Set();
    if (!e.shiftKey) {
      setSelected(new Set());
      setEdgeSel(null);
    }
    drag.current = { mode: "marquee", start: worldAt(e.clientX, e.clientY), base };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const k = vpRef.current.k;
    if (d.mode === "pan") {
      jump({ ...d.origin, x: d.origin.x + e.clientX - d.sx, y: d.origin.y + e.clientY - d.sy });
    } else if (d.mode === "marquee") {
      const now = worldAt(e.clientX, e.clientY);
      const box = normalizeBox(d.start.x, d.start.y, now.x, now.y);
      setMarquee(box);
      const hit = itemsRef.current.filter((i) => intersects(box, i)).map((i) => i.id);
      setSelected(new Set([...d.base, ...hit]));
    } else if (d.mode === "move") {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
      d.moved = true;
      let dx = (e.clientX - d.sx) / k;
      let dy = (e.clientY - d.sy) / k;
      const group = bounds([...d.starts.values()]);
      if (snapping && !e.altKey && group) {
        const others = itemsRef.current.filter((i) => !d.starts.has(i.id));
        const s = snapMove({ ...group, x: group.x + dx, y: group.y + dy }, others, SNAP_PX / k);
        dx += s.dx;
        dy += s.dy;
        setGuides(s.guides);
      } else setGuides([]);
      canvas.apply([...d.starts.values()].map((s): CanvasOp => ({ op: "upsert_item", item: { ...s, x: Math.round(s.x + dx), y: Math.round(s.y + dy) } })));
    } else if (d.mode === "resize") {
      d.moved = true;
      const w = Math.min(4000, Math.max(MIN_W, Math.round(d.start.w + (e.clientX - d.sx) / k)));
      const h = Math.min(4000, Math.max(MIN_H, Math.round(d.start.h + (e.clientY - d.sy) / k)));
      // Images keep their proportions; Shift does the same for anything else.
      const keepRatio = e.shiftKey || d.start.kind === "image";
      canvas.apply([{ op: "upsert_item", item: { ...d.start, w, h: keepRatio ? Math.max(MIN_H, Math.round((w * d.start.h) / d.start.w)) : h } }]);
    } else {
      const w = worldAt(e.clientX, e.clientY);
      setGhost({ from: d.from, x: w.x, y: w.y });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setPanning(false);
    setMarquee(null);
    setGuides([]);
    if (boardRef.current?.hasPointerCapture(e.pointerId)) boardRef.current.releasePointerCapture(e.pointerId);
    if (!d) return;
    if ((d.mode === "move" || d.mode === "resize") && d.moved && d.before) {
      const ids = d.mode === "move" ? [...d.starts.keys()] : [d.start.id];
      const final = ids.map((id) => itemsRef.current.find((i) => i.id === id)).filter((i): i is CanvasItem => !!i);
      canvas.commitApplied(d.before, final.map((item): CanvasOp => ({ op: "upsert_item", item })));
      return;
    }
    if (d.mode !== "connect") return;
    setGhost(null);
    const to = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el instanceof HTMLElement && el.dataset.itemId && el.dataset.itemId !== d.from) as HTMLElement | undefined;
    const toId = to?.dataset.itemId;
    if (!toId || edges.some((x) => x.fromItem === d.from && x.toItem === toId)) return;
    const edge: CanvasEdge = { id: newId(), fromItem: d.from, toItem: toId, label: "" };
    canvas.commit([{ op: "upsert_edge", edge }]);
    setEdgeSel(edge.id);
    setSelected(new Set());
  };

  // ---- keyboard ----

  useEffect(() => {
    // Space pans while held, even when the pointer is over an item.
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("textarea, input, [contenteditable='true']");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e.target) && boardRef.current?.contains(document.activeElement)) {
        e.preventDefault();
        setSpaceDown(true);
      }
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpaceDown(false);
    const blur = () => setSpaceDown(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("textarea, input, [contenteditable='true']") || target.closest("[data-canvas-editor]")?.closest(".canvas-view") === e.currentTarget) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z") {
      e.preventDefault();
      return e.shiftKey ? canvas.redo() : canvas.undo();
    }
    if (mod && key === "y") {
      e.preventDefault();
      return canvas.redo();
    }
    if (mod && key === "a") {
      e.preventDefault();
      return selectAll();
    }
    if (mod && key === "d") {
      e.preventDefault();
      return duplicateSelection();
    }
    if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      return zoomStep(1);
    }
    if (mod && e.key === "-") {
      e.preventDefault();
      return zoomStep(-1);
    }
    if (mod && e.key === "0") {
      e.preventDefault();
      return zoomPreset(1);
    }
    if (e.shiftKey && e.code === "Digit1") return fitAll();
    if (e.shiftKey && e.code === "Digit2") return fitSelection();
    if (e.shiftKey && e.code === "Digit0") return zoomPreset(1);
    if (mod || e.altKey) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeSelection();
    } else if (e.key === "Escape") {
      setSelected(new Set());
      setEdgeSel(null);
      setMenu(null);
    } else if (key === "v") setTool("select");
    else if (key === "h") setTool("hand");
    else if (key === "n") addNote();
    else if (key === "i" && !readOnly) fileRef.current?.click();
    else if (e.key === "]") restack(e.ctrlKey || e.metaKey ? "front" : "forward");
    else if (e.key === "[") restack(e.ctrlKey || e.metaKey ? "back" : "backward");
    else if (e.key === "Enter" && selItems.length === 1 && !readOnly) {
      const item = selItems[0];
      if (item.kind === "note") setEditing(item.id);
      else if (isCard(item)) openItem(item);
    } else if (e.key.startsWith("Arrow") && selItems.length) {
      e.preventDefault();
      const step = e.shiftKey ? 50 : 10;
      nudge(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
    }
  };

  // ---- notes, menus ----

  const onEdit = useCallback(
    (item: CanvasItem | null, text?: string) => {
      if (item) return setEditing(item.id);
      const id = editing;
      setEditing(null);
      if (id === null || text === undefined) return;
      const cur = itemsRef.current.find((i) => i.id === id);
      if (cur && cur.text !== text) canvas.commit([{ op: "upsert_item", item: { ...cur, text } }]);
    },
    [editing, canvas],
  );

  const openItem = useCallback(
    (item: CanvasItem) => {
      const card = cards.get(cardKey(item) ?? "");
      if (card !== undefined) openCard(card, item);
    },
    [cards, openCard],
  );

  // Rebuilt on every right-click from the render that is current, so its actions see the live selection.
  const itemMenu = (e: React.MouseEvent, item: CanvasItem) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selected.has(item.id)) {
      setSelected(new Set([item.id]));
      setEdgeSel(null);
    }
    const common: MenuItem[] = readOnly
      ? []
      : [
          { label: "Bring forward", onSelect: () => restack("forward"), separated: true },
          { label: "Send backward", onSelect: () => restack("backward") },
          { label: "Bring to front", onSelect: () => restack("front") },
          { label: "Send to back", onSelect: () => restack("back") },
        ];
    const card = isCard(item) ? cardOf(item) : undefined;
    const own: MenuItem[] =
      card !== undefined
        ? cardMenu(card, item)
        : readOnly
          ? []
          : [...(item.kind === "note" ? [{ label: "Edit text", onSelect: () => setEditing(item.id) }] : []), { label: "Duplicate", onSelect: duplicateSelection }];
    const removable = removableCards || !isCard(item);
    const del: MenuItem[] = readOnly || !removable ? [] : [{ label: isCard(item) ? "Remove from canvas" : "Delete", onSelect: removeSelection, danger: true, separated: true }];
    setMenu({ x: e.clientX, y: e.clientY, items: [...own, ...common, ...del] });
  };
  const itemMenuRef = useRef(itemMenu);
  itemMenuRef.current = itemMenu;
  const onItemMenu = useCallback((e: React.MouseEvent, item: CanvasItem) => itemMenuRef.current(e, item), []);

  const onBoardMenu = (e: React.MouseEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const at = worldAt(e.clientX, e.clientY);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(readOnly ? [] : [{ label: "New note here", onSelect: () => addNote(at) }, { label: "Add image…", onSelect: () => fileRef.current?.click() }, ...(boardMenu?.(at) ?? [])]),
        { label: "Select all", onSelect: selectAll, separated: !readOnly },
        { label: "Zoom to fit", onSelect: () => fitAll() },
        { label: "Zoom to 100%", onSelect: () => zoomPreset(1) },
      ],
    });
  };

  const onlyNote = selItems.length === 1 && selItems[0].kind === "note" ? selItems[0] : null;
  const edge = edgeSel ? edges.find((x) => x.id === edgeSel) : undefined;
  const edgeBoxes = (x: CanvasEdge) => arrowBetween(itemById.get(x.fromItem)! as Box, itemById.get(x.toItem)! as Box);
  const navigate = (wx: number, wy: number) => {
    const { k } = vpRef.current;
    jump({ k, x: size.w / 2 - wx * k, y: size.h / 2 - wy * k });
  };

  return (
    <div className="canvas-wrap">
      {(canvas.error || notice) && (
        <p className="error-text" role="alert">
          {canvas.error ?? notice}{" "}
          {canvas.error && (
            <button type="button" className="link" onClick={canvas.clearError}>
              Dismiss
            </button>
          )}
        </p>
      )}
      <div
        ref={boardRef}
        className={`canvas-view${handMode ? " hand" : ""}${panning ? " panning" : ""}`}
        tabIndex={0}
        role="application"
        aria-label="Canvas. Scroll to zoom, hold Space and drag to pan, double-click to add a note. Press V for the select tool and H for the hand tool."
        onKeyDown={onKeyDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerDown={onBoardDown}
        onContextMenu={onBoardMenu}
        onDoubleClick={(e) => {
          // Pointer capture retargets the event to the board, so look at what is really under the pointer.
          const t = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null) ?? (e.target as HTMLElement);
          const hit = t.closest<HTMLElement>(".cv-item");
          if (hit) {
            // Captured presses deliver the double-click here rather than to the item, so do what the item would.
            const item = itemById.get(hit.dataset.itemId ?? "");
            if (item && isCard(item)) openItem(item);
            else if (item?.kind === "note" && !readOnly) onEdit(item);
            return;
          }
          const onBackground = t === e.currentTarget || t.classList.contains("cv-world");
          if (onBackground && !t.closest(".cv-item, .cv-edge, .cv-pill, .cv-minimap, .cv-edge-editor") && !handMode) addNote(worldAt(e.clientX, e.clientY));
        }}
        onPaste={(e) => {
          if (e.defaultPrevented || (e.target as Element).closest("[data-canvas-editor]")?.closest(".canvas-view") === e.currentTarget) return;
          const file = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
          if (file && !(e.target as HTMLElement).closest("textarea, input")) {
            e.preventDefault();
            void addImage(file);
          }
        }}
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (e.defaultPrevented || (e.target as Element).closest("[data-canvas-editor]")?.closest(".canvas-view") === e.currentTarget) return;
          const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
          if (!files.length) return;
          e.preventDefault();
          const at = worldAt(e.clientX, e.clientY);
          files.forEach((f, n) => void addImage(f, { x: at.x + n * 24, y: at.y + n * 24 }));
        }}
      >
        <div className="cv-world" style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.k})` }}>
          <svg className="cv-edges" width="1" height="1" aria-hidden="true">
            <defs>
              <marker id={`cv-arrow-${scopeId}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" className="cv-arrowhead" />
              </marker>
            </defs>
            {edges.map((x) => {
              const { a, b, mid } = edgeBoxes(x);
              return (
                <g key={x.id} className={x.id === edgeSel ? "cv-edge sel" : "cv-edge"}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} markerEnd={`url(#cv-arrow-${scopeId})`} />
                  <line
                    className="cv-edge-hit"
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    onPointerDown={(e) => {
                      if (handMode) return;
                      e.stopPropagation();
                      boardRef.current?.focus({ preventScroll: true });
                      setSelected(new Set());
                      setEdgeSel(x.id);
                    }}
                  />
                  {x.label && (
                    <text x={mid.x} y={mid.y - 6} textAnchor="middle" className="cv-edge-label">
                      {x.label}
                    </text>
                  )}
                </g>
              );
            })}
            {ghost && itemById.get(ghost.from) && (
              <line className="cv-ghost" x1={itemById.get(ghost.from)!.x + itemById.get(ghost.from)!.w / 2} y1={itemById.get(ghost.from)!.y + itemById.get(ghost.from)!.h / 2} x2={ghost.x} y2={ghost.y} />
            )}
            {guides.map((g, n) => (
              <line key={`${g.axis}${g.at}${n}`} className="cv-guide" x1={g.axis === "x" ? g.at : g.from} y1={g.axis === "x" ? g.from : g.at} x2={g.axis === "x" ? g.at : g.to} y2={g.axis === "x" ? g.to : g.at} />
            ))}
          </svg>
          {items.map((i) => {
            const card = isCard(i) ? cardOf(i) : undefined;
            return (
              <Node
                key={i.id}
                item={i}
                card={card}
                label={card === undefined ? "" : cardLabel(card)}
                selected={selected.has(i.id)}
                editing={editing === i.id}
                readOnly={readOnly}
                renderCard={renderCard}
                onDown={onNodeDown}
                onEdit={onEdit}
                onOpen={openItem}
                onMenu={onItemMenu}
              />
            );
          })}
          {marquee && <div className="cv-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, borderWidth: 1 / vp.k }} />}
        </div>

        {canvas.data && ready && items.length === 0 && <p className="cv-empty">{readOnly ? "This canvas is empty." : (emptyHint ?? "Double-click to add a note, or paste an image.")}</p>}

        {edge && !readOnly && (
          <EdgeEditor
            key={edge.id}
            edge={edge}
            at={(() => {
              const { mid } = edgeBoxes(edge);
              return { left: mid.x * vp.k + vp.x, top: mid.y * vp.k + vp.y };
            })()}
            onLabel={(label) => canvas.commit([{ op: "upsert_edge", edge: { ...edge, label } }])}
            onDelete={() => {
              canvas.commit([{ op: "delete_edge", id: edge.id }]);
              setEdgeSel(null);
            }}
          />
        )}

        {selItems.length > 0 && (
          <SelectionBar
            count={selItems.length}
            onlyNote={!!onlyNote && !readOnly}
            color={onlyNote?.color ?? null}
            colors={NOTE_COLORS}
            canDuplicate={!readOnly && deletable.length > 0}
            canDelete={!readOnly && deletable.length > 0}
            onAlign={align}
            onDistribute={distribute}
            onColor={setColor}
            onFront={() => restack("forward")}
            onBack={() => restack("backward")}
            onDuplicate={duplicateSelection}
            onDelete={removeSelection}
            onFitSelection={fitSelection}
          />
        )}

        <ToolPill tool={tool} onTool={setTool} readOnly={readOnly} canUndo={canvas.canUndo} canRedo={canvas.canRedo} onNote={() => addNote()} onImage={() => fileRef.current?.click()} extraTools={tools} onUndo={canvas.undo} onRedo={canvas.redo} />
        <ZoomPill
          zoom={vp.k}
          hasSelection={selItems.length > 0}
          snapping={snapping}
          minimap={minimap}
          onZoomOut={() => zoomStep(-1)}
          onZoomIn={() => zoomStep(1)}
          onZoomTo={zoomPreset}
          onFit={() => fitAll()}
          onFitSelection={fitSelection}
          onToggleSnap={() => setSnapping((s) => (writePref("snap", !s), !s))}
          onToggleMinimap={() => setMinimap((m) => (writePref("minimap", !m), !m))}
        />
        {minimap && size.w > 0 && <Minimap items={items} vp={vp} size={size} onNavigate={navigate} />}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void addImage(f);
          }}
        />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function EdgeEditor({ edge, at, onLabel, onDelete }: { edge: CanvasEdge; at: { left: number; top: number }; onLabel: (label: string) => void; onDelete: () => void }) {
  return (
    <div className="cv-edge-editor" style={at} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <input
        type="text"
        aria-label="Arrow label"
        placeholder="Label"
        maxLength={200}
        defaultValue={edge.label}
        onBlur={(e) => e.currentTarget.value !== edge.label && onLabel(e.currentTarget.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <button type="button" className="icon-btn" aria-label="Delete arrow" onClick={onDelete}>
        ×
      </button>
    </div>
  );
}

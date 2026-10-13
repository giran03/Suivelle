import type { Node as PMNode, Slice } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ID_TYPES } from "./extensions/blockId";

export interface BlockHit { node: PMNode; pos: number; dom: HTMLElement; rect: DOMRect }
interface BlockDrag { from: number; to: number; slice: Slice; height: number; target: number | null }
export const blockDragKey = new PluginKey<BlockDrag | null>("blockDrag");
const ITEMS = new Set(["listItem", "taskItem"]);

/** Resolve the rendered row, including the empty gutter, without asking for a text caret. */
export function blockAtPoint(view: EditorView, x: number, y: number): BlockHit | null {
  const docRect = view.dom.getBoundingClientRect();
  const gutter = x < docRect.left;
  function visit(parent: PMNode, start: number): BlockHit | null {
    let nearest: BlockHit | null = null;
    let distance = Infinity;
    parent.forEach((node, offset, index) => {
      if (!node.isBlock) return;
      const pos = start + offset;
      const dom = view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return;
      const rect = dom.getBoundingClientRect();
      if (!rect.width || !rect.height) return; // closed toggles and hidden node content
      const dy = Math.max(rect.top - y, y - rect.bottom, 0);
      const dx = gutter ? Math.max(rect.left - docRect.left, 0) : Math.max(rect.left - x, x - rect.right, 0);
      const d = dy * 10000 + dx;
      if (d >= distance) return;
      const ownRow = ID_TYPES.includes(node.type.name) && node.type.name !== "column" &&
        !(node.type.name === "paragraph" && ITEMS.has(parent.type.name) && index === 0);
      let hit: BlockHit | null = ownRow ? { node, pos, dom, rect } : null;
      if (!node.isAtom && node.type.name !== "table" && node.content.size) {
        const child = visit(node, pos + 1);
        // A container's own header remains draggable; its children own their rendered rows.
        if (child && (!ownRow || (y >= child.rect.top && y <= child.rect.bottom))) hit = child;
      }
      if (hit) { nearest = hit; distance = d; }
    });
    return nearest;
  }
  return visit(view.state.doc, 0);
}

function targetAtPoint(view: EditorView, drag: BlockDrag, x: number, y: number): number | null {
  const placeholder = view.dom.querySelector<HTMLElement>(".block-drop-skeleton");
  const rect = placeholder?.getBoundingClientRect();
  if (rect && y >= rect.top && y <= rect.bottom && x >= rect.left - 64 && x <= rect.right) return drag.target;
  const hit = blockAtPoint(view, x, y);
  if (!hit) return null;
  const boundary = y < hit.rect.top + hit.rect.height / 2 ? hit.pos : hit.pos + hit.node.nodeSize;
  if (boundary >= drag.from && boundary <= drag.to) return null;
  const target = dropPoint(view.state.doc, boundary, drag.slice);
  return target !== null && (target < drag.from || target > drag.to) ? target : null;
}

/** Use one insertion position for both preview and commit; deletion is mapped before insertion. */
export function moveDraggedBlock(state: EditorState, from: number, to: number, slice: Slice, target: number) {
  if (target >= from && target <= to || dropPoint(state.doc, target, slice) !== target) return null;
  const tr = state.tr;
  NodeSelection.create(state.doc, from).replace(tr);
  const at = tr.mapping.map(target);
  const before = tr.doc;
  tr.replaceRange(at, at, slice);
  if (tr.doc.eq(before)) return null;
  const inserted = tr.doc.nodeAt(at);
  tr.setSelection(inserted && NodeSelection.isSelectable(inserted)
    ? NodeSelection.create(tr.doc, at) : NodeSelection.near(tr.doc.resolve(at)));
  return tr.setMeta(blockDragKey, null).setMeta("uiEvent", "drop");
}

function startBlockDrag(view: EditorView, hit: BlockHit): boolean {
  if (!view.editable || !view.state.doc.nodeAt(hit.pos)?.eq(hit.node)) return false;
  const selection = NodeSelection.create(view.state.doc, hit.pos);
  const slice = selection.content();
  const scale = view.dom.getBoundingClientRect().height / (view.dom.offsetHeight || 1);
  view.dispatch(view.state.tr.setSelection(selection).setMeta(blockDragKey, {
    from: selection.from, to: selection.to, slice, height: Math.max(12, hit.rect.height / (scale || 1)), target: null,
  }).setMeta("addToHistory", false));
  return true;
}

export function blockDragPlugin(onHover: (hit: BlockHit | null) => void) {
  return new Plugin<BlockDrag | null>({
    key: blockDragKey,
    state: {
      init: () => null,
      // A concurrent content edit cancels the drag rather than moving a stale source selection.
      apply: (tr, value) => tr.getMeta(blockDragKey) !== undefined ? tr.getMeta(blockDragKey) : tr.docChanged ? null : value,
    },
    props: {
      decorations(state) {
        const drag = blockDragKey.getState(state);
        if (!drag) return null;
        const decorations = [Decoration.node(drag.from, drag.to, { class: "block-drag-source" })];
        if (drag.target !== null) decorations.push(Decoration.widget(drag.target, () => {
          const parent = state.doc.resolve(drag.target!).parent.type.name;
          const box = document.createElement(["bulletList", "orderedList", "taskList"].includes(parent) ? "li" : "div");
          box.className = "block-drop-skeleton";
          box.contentEditable = "false";
          box.setAttribute("aria-hidden", "true");
          box.style.height = `${drag.height}px`;
          for (let i = 0; i < Math.min(6, Math.max(1, Math.round(drag.height / 24))); i++) box.append(document.createElement("span"));
          return box;
        }, { side: -1, key: `block-drop-${drag.target}-${drag.height}`, ignoreSelection: true }));
        return DecorationSet.create(state.doc, decorations);
      },
    },
    view(view) {
      const root = view.dom.closest<HTMLElement>(".editor") ?? view.dom.parentElement!;
      const scroller = root.closest<HTMLElement>(".main-scroll");
      let pointer: { x: number; y: number } | null = null;
      let frame = 0;
      let dragging = false;
      let hovered: BlockHit | null = null;
      let gesture: { id: number; x: number; y: number; hit: BlockHit; grip: HTMLElement } | null = null;
      let suppressClick = false;
      let clickTimer = 0;
      const hover = (hit: BlockHit | null) => { hovered = hit; onHover(hit); };
      const end = () => {
        const held = gesture;
        gesture = null;
        pointer = null;
        dragging = false;
        root.classList.remove("block-drag-active");
        cancelAnimationFrame(frame); frame = 0;
        if (blockDragKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(blockDragKey, null).setMeta("addToHistory", false));
        if (held?.grip.hasPointerCapture(held.id)) held.grip.releasePointerCapture(held.id);
        hover(null);
        // Swallow the click generated by releasing a drag, then restore ordinary grip clicks.
        window.clearTimeout(clickTimer);
        clickTimer = window.setTimeout(() => { suppressClick = false; }, 0);
      };
      const tick = () => {
        frame = 0;
        if (!pointer) return;
        const drag = blockDragKey.getState(view.state);
        if (!dragging) {
          hover(view.editable ? blockAtPoint(view, pointer.x, pointer.y) : null);
          return;
        }
        if (!drag || !view.editable) { end(); return; }
        let scrolling = false;
        if (scroller) {
          const r = scroller.getBoundingClientRect();
          const speed = pointer.y < r.top + 48 ? -Math.min(12, (r.top + 48 - pointer.y) / 4)
            : pointer.y > r.bottom - 48 ? Math.min(12, (pointer.y - r.bottom + 48) / 4) : 0;
          const previous = scroller.scrollTop;
          scroller.scrollTop += speed;
          scrolling = scroller.scrollTop !== previous;
        }
        const target = targetAtPoint(view, drag, pointer.x, pointer.y);
        if (target !== drag.target) view.dispatch(view.state.tr.setMeta(blockDragKey, { ...drag, target }).setMeta("addToHistory", false));
        if (scrolling) frame = requestAnimationFrame(tick);
      };
      const schedule = () => { if (!frame) frame = requestAnimationFrame(tick); };
      const move = (event: MouseEvent) => {
        if (gesture || dragging || (event.target as Element).closest(".block-handle")) return;
        // A nested synced editor owns its content and must not retarget the outer handle.
        if (view.dom.contains(event.target as Node) && (event.target as Element).closest(".ProseMirror") !== view.dom) return;
        pointer = { x: event.clientX, y: event.clientY }; schedule();
      };
      const leave = (event: MouseEvent) => {
        if (!gesture && !root.contains(event.relatedTarget as Node)) { pointer = null; hover(null); }
      };
      const inside = (x: number, y: number) => root.contains(document.elementFromPoint(x, y));
      const down = (event: PointerEvent) => {
        const grip = (event.target as Element).closest<HTMLElement>(".block-handle .grip");
        if (!grip || !hovered || !view.editable || event.button !== 0 || !event.isPrimary || gesture) return;
        event.preventDefault();
        gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, hit: hovered, grip };
        grip.setPointerCapture(event.pointerId);
      };
      const pointerMove = (event: PointerEvent) => {
        if (!gesture || event.pointerId !== gesture.id) return;
        if (!dragging) {
          if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 4) return;
          if (!startBlockDrag(view, gesture.hit)) { end(); return; }
        }
        event.preventDefault();
        if (!inside(event.clientX, event.clientY)) {
          pointer = null;
          const drag = blockDragKey.getState(view.state);
          if (drag && drag.target !== null) view.dispatch(view.state.tr.setMeta(blockDragKey, { ...drag, target: null }).setMeta("addToHistory", false));
          return;
        }
        pointer = { x: event.clientX, y: event.clientY }; schedule();
      };
      const up = (event: PointerEvent) => {
        if (!gesture || event.pointerId !== gesture.id) return;
        if (!dragging) {
          const held = gesture;
          gesture = null;
          if (held.grip.hasPointerCapture(held.id)) held.grip.releasePointerCapture(held.id);
          return; // A grip click keeps its hovered row so the block menu can open.
        }
        const drag = blockDragKey.getState(view.state);
        if (dragging && drag && inside(event.clientX, event.clientY)) {
          event.preventDefault(); event.stopPropagation();
          const target = targetAtPoint(view, drag, event.clientX, event.clientY);
          const tr = view.editable && target !== null ? moveDraggedBlock(view.state, drag.from, drag.to, drag.slice, target) : null;
          if (tr) { view.dispatch(tr); view.focus(); }
        }
        end();
      };
      const cancel = (event: PointerEvent) => { if (gesture?.id === event.pointerId) end(); };
      const key = (event: KeyboardEvent) => { if (event.key === "Escape" && gesture) { event.preventDefault(); event.stopPropagation(); end(); } };
      const click = (event: MouseEvent) => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); } };
      const blur = () => { if (gesture) end(); };
      // A selected ProseMirror node is natively draggable. Our captured gesture owns this move.
      const nativeDrag = (event: DragEvent) => { if (gesture || dragging) event.preventDefault(); };
      const resize = new ResizeObserver(schedule);
      resize.observe(view.dom);
      root.addEventListener("mousemove", move);
      root.addEventListener("mouseleave", leave);
      root.addEventListener("click", click, true);
      root.addEventListener("pointerdown", down);
      root.addEventListener("lostpointercapture", cancel);
      root.addEventListener("dragstart", nativeDrag, true);
      document.addEventListener("pointermove", pointerMove, true);
      document.addEventListener("pointerup", up, true);
      document.addEventListener("pointercancel", cancel, true);
      window.addEventListener("blur", blur);
      document.addEventListener("keydown", key, true);
      document.addEventListener("scroll", schedule, true);
      return {
        update() {
          const drag = blockDragKey.getState(view.state);
          if (!view.editable && (gesture || drag)) { end(); return; }
          if (drag && !dragging) { dragging = true; suppressClick = true; root.classList.add("block-drag-active"); hover(null); }
          else if (!drag && dragging) { end(); }
          if (!dragging && !gesture) schedule();
        },
        destroy() {
          cancelAnimationFrame(frame); window.clearTimeout(clickTimer); resize.disconnect();
          root.classList.remove("block-drag-active");
          root.removeEventListener("mousemove", move);
          root.removeEventListener("mouseleave", leave);
          root.removeEventListener("click", click, true);
          root.removeEventListener("pointerdown", down);
          root.removeEventListener("lostpointercapture", cancel);
          root.removeEventListener("dragstart", nativeDrag, true);
          document.removeEventListener("pointermove", pointerMove, true);
          document.removeEventListener("pointerup", up, true);
          document.removeEventListener("pointercancel", cancel, true);
          window.removeEventListener("blur", blur);
          document.removeEventListener("keydown", key, true);
          document.removeEventListener("scroll", schedule, true);
        },
      };
    },
  });
}

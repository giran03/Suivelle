import { Extension } from "@tiptap/core";
import { Slice, type Node as PMNode } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  Selection,
  type SelectionBookmark,
  type Transaction,
} from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** Text elements fill an entire row; only their rendered text should start text selection. */
export function pointerOverText(
  target: HTMLElement,
  x: number,
  y: number,
): boolean {
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (
        rect.width &&
        rect.height &&
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      )
        return true;
    }
  }
  return false;
}

export function blockRange(doc: PMNode, from: number, to: number) {
  const blocks: { node: PMNode; pos: number }[] = [];
  const visit = (parent: PMNode, start: number) =>
    parent.forEach((node, offset) => {
      const pos = start + offset,
        end = pos + node.nodeSize;
      if (pos >= to || end <= from) return;
      if (LIST_TYPES.has(node.type.name)) visit(node, pos + 1);
      else if (pos >= from && end <= to) blocks.push({ node, pos });
      else if (node.isBlock && node.content.size) visit(node, pos + 1);
    });
  visit(doc, 0);
  return blocks;
}

const LIST_TYPES = new Set(["taskList", "bulletList", "orderedList"]);

/** List containers have selectable item rows; the list itself is not a row. */
function marqueeRows(doc: PMNode) {
  const rows = blockRange(doc, 0, doc.content.size);
  const result: typeof rows = [];
  const visit = (node: PMNode, pos: number) => {
    result.push({ node, pos });
    if (["taskItem", "listItem"].includes(node.type.name))
      node.forEach((child, offset) => {
        if (LIST_TYPES.has(child.type.name))
          child.forEach((item, itemOffset) =>
            visit(item, pos + offset + itemOffset + 2),
          );
      });
  };
  for (const row of rows) visit(row.node, row.pos);
  return result;
}

/** A contiguous range of whole page blocks; clipboard and deletion keep their structure. */
export class BlockRangeSelection extends Selection {
  static create(doc: PMNode, from: number, to: number): Selection {
    const blocks = blockRange(
      doc,
      Math.max(0, from),
      Math.min(doc.content.size, to),
    );
    if (!blocks.length)
      return Selection.near(
        doc.resolve(Math.max(0, Math.min(doc.content.size, from))),
      );
    const first = blocks[0],
      last = blocks[blocks.length - 1];
    return new BlockRangeSelection(
      doc.resolve(first.pos),
      doc.resolve(last.pos + last.node.nodeSize),
    );
  }
  visible = false;
  eq(other: Selection) {
    return (
      other instanceof BlockRangeSelection &&
      other.from === this.from &&
      other.to === this.to
    );
  }
  map(doc: PMNode, mapping: Mappable) {
    return BlockRangeSelection.create(
      doc,
      mapping.map(this.from, 1),
      mapping.map(this.to, -1),
    );
  }
  toJSON() {
    return { type: "blockRange", from: this.from, to: this.to };
  }
  static fromJSON(doc: PMNode, json: { from: number; to: number }) {
    return BlockRangeSelection.create(doc, json.from, json.to);
  }
  getBookmark(): SelectionBookmark {
    return new BlockRangeBookmark(this.from, this.to);
  }
  replace(tr: Transaction, content = Slice.empty) {
    const { $from, $to } = this;
    if (
      !content.size &&
      $from.sameParent($to) &&
      LIST_TYPES.has($from.parent.type.name) &&
      $from.parentOffset === 0 &&
      $to.parentOffset === $to.parent.content.size
    ) {
      tr.delete($from.before(), $to.after());
      tr.setSelection(
        Selection.near(
          tr.doc.resolve(Math.min($from.before(), tr.doc.content.size)),
        ),
      );
    } else super.replace(tr, content);
  }
}
class BlockRangeBookmark implements SelectionBookmark {
  constructor(
    readonly from: number,
    readonly to: number,
  ) {}
  map(mapping: Mappable) {
    return new BlockRangeBookmark(
      mapping.map(this.from, 1),
      mapping.map(this.to, -1),
    );
  }
  resolve(doc: PMNode) {
    return BlockRangeSelection.create(doc, this.from, this.to);
  }
}
Selection.jsonID("blockRange", BlockRangeSelection);

export const BlockSelection = Extension.create({
  name: "blockSelection",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          attributes: { tabindex: "0" },
          createSelectionBetween(view) {
            const selection = view.state.selection;
            // DOM endpoints inside list-item text must not turn whole-row selection into text selection on blur.
            return selection instanceof BlockRangeSelection ? selection : null;
          },
          handleDOMEvents: {
            // ProseMirror skips its normal keydown handlers in read-only editors.
            keydown(view, event) {
              if (
                view.editable ||
                !(view.state.selection instanceof BlockRangeSelection)
              )
                return false;
              if (event.key === "Escape")
                view.dispatch(
                  view.state.tr.setSelection(
                    Selection.near(
                      view.state.doc.resolve(view.state.selection.from),
                    ),
                  ),
                );
              else if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "a"
              )
                view.dispatch(
                  view.state.tr.setSelection(
                    BlockRangeSelection.create(
                      view.state.doc,
                      0,
                      view.state.doc.content.size,
                    ),
                  ),
                );
              else return false;
              event.preventDefault();
              return true;
            },
          },
          decorations(state) {
            if (!(state.selection instanceof BlockRangeSelection)) return null;
            return DecorationSet.create(
              state.doc,
              blockRange(
                state.doc,
                state.selection.from,
                state.selection.to,
              ).map(({ node, pos }) =>
                Decoration.node(pos, pos + node.nodeSize, {
                  class: "block-range-selected",
                }),
              ),
            );
          },
          handleKeyDown(view, event) {
            if (!(view.state.selection instanceof BlockRangeSelection))
              return false;
            if (event.key === "Escape") {
              view.dispatch(
                view.state.tr.setSelection(
                  Selection.near(
                    view.state.doc.resolve(view.state.selection.from),
                  ),
                ),
              );
              return true;
            }
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "a"
            ) {
              view.dispatch(
                view.state.tr.setSelection(
                  BlockRangeSelection.create(
                    view.state.doc,
                    0,
                    view.state.doc.content.size,
                  ),
                ),
              );
              return true;
            }
            if (view.editable && ["Backspace", "Delete"].includes(event.key)) {
              view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
              return true;
            }
            return false;
          },
        },
        view(view) {
          const root =
            view.dom.closest<HTMLElement>(".synced-body") ??
            view.dom.closest<HTMLElement>(".editor") ??
            view.dom.parentElement!;
          const surface = view.dom.parentElement?.closest(".ProseMirror")
            ? root
            : (view.dom.closest<HTMLElement>("[data-canvas-editor]") ??
              view.dom.closest<HTMLElement>(".main-scroll") ?? root);
          const box = document.createElement("div");
          box.className = "block-selection-marquee";
          box.setAttribute("aria-hidden", "true");
          let drag: {
            id: number;
            x: number;
            y: number;
            scroll: number;
            doc: PMNode;
            previous: SelectionBookmark;
            active: boolean;
          } | null = null;
          let pointer = { x: 0, y: 0 },
            frame = 0,
            suppressClick = false;
          let scroller: HTMLElement = document.scrollingElement as HTMLElement;
          for (let el = root.parentElement; el; el = el.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
              scroller = el;
              break;
            }
          }
          const end = (restore = false) => {
            if (restore && drag && view.state.doc === drag.doc)
              view.dispatch(
                view.state.tr.setSelection(
                  drag.previous.resolve(view.state.doc),
                ),
              );
            suppressClick = !!drag?.active;
            drag = null;
            cancelAnimationFrame(frame);
            frame = 0;
            box.remove();
            root.classList.remove("is-selecting-blocks");
          };
          const draw = () => {
            frame = 0;
            const d = drag;
            if (!d?.active) return;
            if (view.state.doc !== d.doc) {
              end();
              return;
            }
            const scrollRect =
              scroller === document.scrollingElement
                ? { top: 0, bottom: window.innerHeight }
                : scroller.getBoundingClientRect();
            const scrollDelta =
              pointer.y < scrollRect.top + 32
                ? -12
                : pointer.y > scrollRect.bottom - 32
                  ? 12
                  : 0;
            if (scrollDelta) scroller.scrollTop += scrollDelta;
            const y = d.y + d.scroll - scroller.scrollTop;
            // The overlay lives on body, so explicitly keep it inside its editor pane.
            const clips = [surface, view.dom.closest(".canvas-view"), view.dom.closest(".main-scroll")]
              .filter((el): el is HTMLElement => el instanceof HTMLElement)
              .map(el => el.getBoundingClientRect());
            const minX = Math.max(0, ...clips.map(rect => rect.left)), minY = Math.max(0, ...clips.map(rect => rect.top));
            const maxX = Math.max(minX, Math.min(window.innerWidth, ...clips.map(rect => rect.right)));
            const maxY = Math.max(minY, Math.min(window.innerHeight, ...clips.map(rect => rect.bottom)));
            const clampX = (x: number) => Math.min(maxX, Math.max(minX, x));
            const clampY = (y: number) => Math.min(maxY, Math.max(minY, y));
            const left = clampX(Math.min(d.x, pointer.x)), top = clampY(Math.min(y, pointer.y));
            const right = clampX(Math.max(d.x, pointer.x)), bottom = clampY(Math.max(y, pointer.y));
            Object.assign(box.style, {
              left: `${left}px`,
              top: `${top}px`,
              width: `${right - left}px`,
              height: `${bottom - top}px`,
            });
            let from: number | undefined,
              to = 0;
            const docRect = view.dom.getBoundingClientRect();
            const inGutter =
              (right <= docRect.left && right > docRect.left - 56) ||
              (left >= docRect.right && left < docRect.right + 24);
            for (const { node, pos } of marqueeRows(view.state.doc)) {
              const dom = view.nodeDOM(pos);
              if (!(dom instanceof HTMLElement)) continue;
              const rect = dom.getBoundingClientRect();
              const text = ["taskItem", "listItem"].includes(node.type.name)
                ? dom
                    .querySelector(":scope > div > p, :scope > p")
                    ?.getBoundingClientRect()
                : null;
              const rowBottom = text?.height ? text.bottom : rect.bottom;
              if (
                rect.width &&
                rect.height &&
                (inGutter || (rect.right > left && rect.left < right)) &&
                rowBottom > top &&
                rect.top < bottom
              ) {
                from ??= pos;
                to = Math.max(to, pos + node.nodeSize);
              }
            }
            if (from !== undefined) {
              const selection = BlockRangeSelection.create(
                view.state.doc,
                from,
                to,
              );
              if (!view.state.selection.eq(selection))
                view.dispatch(
                  view.state.tr
                    .setSelection(selection)
                    .setMeta("addToHistory", false),
                );
              window.getSelection()?.removeAllRanges();
            } else {
              const empty = Selection.near(
                view.state.doc.resolve(d.previous.resolve(view.state.doc).from),
              );
              if (!view.state.selection.eq(empty))
                view.dispatch(
                  view.state.tr
                    .setSelection(empty)
                    .setMeta("addToHistory", false),
                );
            }
            if (scrollDelta) frame = requestAnimationFrame(draw);
          };
          const down = (event: PointerEvent) => {
            const target = event.target;
            if (
              event.button === 2 &&
              view.state.selection instanceof BlockRangeSelection &&
              target instanceof Element &&
              target.closest(".block-range-selected") &&
              view.dom.contains(target)
            ) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (
              !(target instanceof HTMLElement) ||
              event.button !== 0 ||
              !event.isPrimary ||
              event.pointerType === "touch"
            )
              return;
            if (
              target.closest(
                "button, input, textarea, select, label, a, .block-handle, .media-viewer, [role='menu']",
              )
            )
              return;
            const owner = target.closest(".ProseMirror");
            if (owner && owner !== view.dom) return;
            const blank =
              target === surface ||
              target === view.dom ||
              target.contains(view.dom) ||
              (view.dom.contains(target) &&
                !pointerOverText(target, event.clientX, event.clientY));
            if (!blank && !(event.altKey && view.dom.contains(target))) {
              if (
                view.state.selection instanceof BlockRangeSelection &&
                view.dom.contains(target)
              ) {
                const point = view.posAtCoords({
                  left: event.clientX,
                  top: event.clientY,
                });
                if (point)
                  view.dispatch(
                    view.state.tr.setSelection(
                      Selection.near(view.state.doc.resolve(point.pos)),
                    ),
                  );
              }
              return;
            }
            suppressClick = false;
            drag = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              scroll: scroller.scrollTop,
              doc: view.state.doc,
              previous: view.state.selection.getBookmark(),
              active: false,
            };
            pointer = { x: event.clientX, y: event.clientY };
            root.classList.add("is-selecting-blocks");
            event.preventDefault();
            event.stopPropagation();
          };
          const move = (event: PointerEvent) => {
            if (!drag || event.pointerId !== drag.id) return;
            pointer = { x: event.clientX, y: event.clientY };
            if (!drag.active) {
              if (Math.hypot(pointer.x - drag.x, pointer.y - drag.y) < 4)
                return;
              drag.active = true;
              document.body.append(box);
              window.getSelection()?.removeAllRanges();
            }
            event.preventDefault();
            if (!frame) frame = requestAnimationFrame(draw);
          };
          const up = (event: PointerEvent) => {
            if (!drag || event.pointerId !== drag.id) return;
            if (drag.active) {
              pointer = { x: event.clientX, y: event.clientY };
              cancelAnimationFrame(frame);
              draw();
              event.preventDefault();
              event.stopPropagation();
              view.focus();
              if (view.state.selection instanceof BlockRangeSelection)
                window.getSelection()?.removeAllRanges();
            } else {
              const point = view.posAtCoords({
                left: event.clientX,
                top: event.clientY,
              });
              const atom =
                point && point.inside >= 0
                  ? view.state.doc.nodeAt(point.inside)
                  : null;
              view.dispatch(
                view.state.tr.setSelection(
                  atom?.isAtom && point
                    ? NodeSelection.create(view.state.doc, point.inside)
                    : Selection.near(
                        view.state.doc.resolve(
                          point?.pos ?? view.state.doc.content.size,
                        ),
                      ),
                ),
              );
              view.focus();
            }
            end();
          };
          const cancel = () => end(true);
          const key = (event: KeyboardEvent) => {
            if (drag && event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          };
          const click = (event: MouseEvent) => {
            if (suppressClick) {
              suppressClick = false;
              event.preventDefault();
              event.stopPropagation();
            }
          };
          const nativeDrag = (event: DragEvent) => {
            if (drag) event.preventDefault();
          };
          surface.addEventListener("pointerdown", down, true);
          surface.addEventListener("dragstart", nativeDrag, true);
          surface.addEventListener("click", click, true);
          document.addEventListener("pointermove", move, true);
          document.addEventListener("pointerup", up, true);
          document.addEventListener("pointercancel", cancel);
          document.addEventListener("keydown", key, true);
          window.addEventListener("blur", cancel);
          return {
            destroy() {
              end();
              surface.removeEventListener("pointerdown", down, true);
              surface.removeEventListener("dragstart", nativeDrag, true);
              surface.removeEventListener("click", click, true);
              document.removeEventListener("pointermove", move, true);
              document.removeEventListener("pointerup", up, true);
              document.removeEventListener("pointercancel", cancel);
              document.removeEventListener("keydown", key, true);
              window.removeEventListener("blur", cancel);
            },
          };
        },
      }),
    ];
  },
});

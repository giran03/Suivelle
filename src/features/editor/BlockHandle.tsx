import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useEffect, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { Icon } from "../../components/Icon";
import { TURN_INTO } from "./blockKinds";
import { deleteBlockAt, duplicateBlock, enclosingColumns, moveBlock, selectBlockAt } from "./commands";
import { canSync, syncBlock } from "./synced";
import { editorDom } from "./editorDom";
import { blockDragKey, blockDragPlugin, type BlockHit } from "./blockDrag";

interface Hovered {
  node: PMNode;
  pos: number;
}

export function blockItems(editor: Editor, at: Hovered): MenuItem[] {
    const on = (fn: () => void) => () => {
      selectBlockAt(editor, at.pos);
      fn();
    };
    // A block inside a column also offers removing the whole columns block.
    const columns = at.node.type.name === "columns" ? null : enclosingColumns(editor, at.pos);
    return [
      { label: "Duplicate", onSelect: on(() => duplicateBlock(editor)) },
      { label: "Move up", onSelect: on(() => moveBlock(editor, -1)) },
      { label: "Move down", onSelect: on(() => moveBlock(editor, 1)) },
      { label: "Turn into synced block", separated: true, disabled: !canSync(editor, at.node), onSelect: () => void syncBlock(editor, at.pos, at.node) },
      ...TURN_INTO.map((k, i) => ({
        label: `Turn into ${k.title}`,
        separated: i === 0,
        disabled: !at.node.isTextblock && !["details", "listItem", "taskItem"].includes(at.node.type.name),
        onSelect: on(() => void k.apply(editor)),
      })),
      { label: "Delete", danger: true, separated: true, onSelect: () => void deleteBlockAt(editor, at.pos) },
      ...(columns ? [{ label: "Delete columns", danger: true, onSelect: () => { editor.view.dispatch(editor.state.tr.delete(columns.pos, columns.pos + columns.size).scrollIntoView()); editor.view.focus(); } }] : []),
    ];
}


/** Gutter controls for the hovered block: add below, drag to move, click the grip for more. */
export function BlockHandle({ editor }: { editor: Editor }) {
  const hovered = useRef<BlockHit | null>(null);
  const handle = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; at: Hovered } | null>(null);

  useEffect(() => {
    const plugin = blockDragPlugin(hit => {
      hovered.current = hit;
      const element = handle.current;
      const dom = editorDom(editor);
      const parent = element?.offsetParent;
      if (!element || !dom || !(parent instanceof HTMLElement)) return;
      const dragging = !!blockDragKey.getState(editor.state);
      // Keep the pointer capture target mounted while the grip is being dragged.
      element.style.visibility = hit || dragging ? "visible" : "hidden";
      element.style.pointerEvents = dragging ? "none" : "auto";
      if (!hit) return;
      const doc = dom.getBoundingClientRect();
      const origin = parent.getBoundingClientRect();
      const scaleX = origin.width / (parent.offsetWidth || 1) || 1;
      const scaleY = origin.height / (parent.offsetHeight || 1) || 1;
      const centerHeading = hit.node.type.name === "heading";
      const y = hit.rect.top + (centerHeading ? (hit.rect.height - element.offsetHeight * scaleY) / 2 : 0);
      element.style.left = `${(doc.left - origin.left) / scaleX - element.offsetWidth}px`;
      element.style.top = `${(y - origin.top) / scaleY}px`;
    });
    // React remounts and refreshes can retain the editor's plugin state. Replace our
    // previous instance instead of appending a second plugin with the same key.
    editor.registerPlugin(plugin, (next, plugins) => [...plugins.filter(p => p !== blockDragKey.get(editor.state)), next]);
    return () => { if (!editor.isDestroyed && blockDragKey.get(editor.state) === plugin) editor.unregisterPlugin(blockDragKey); };
  }, [editor]);

  const addBelow = () => {
    const h = hovered.current;
    if (!h) return;
    // Typing "/" into an empty text block (or a fresh one below) opens the slash menu there.
    const empty = h.node.type.name === "paragraph" && h.node.content.size === 0;
    if (empty) editor.chain().focus().insertContentAt(h.pos + 1, "/").run();
    else
      editor
        .chain()
        .focus()
        .insertContentAt(h.pos + h.node.nodeSize, { type: "paragraph", content: [{ type: "text", text: "/" }] })
        .run();
  };


  return (
    <>
      <div className="block-handle" ref={handle}>
        <div className="gutter">
          <button type="button" className="icon-btn" aria-label="Add a block below" title="Add a block below" onClick={addBelow}>
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="icon-btn grip"
            draggable={false}
            aria-label="Block options. Drag to move"
            title="Drag to move, click for options"
            onPointerDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              const at = hovered.current;
              if (at) setMenu({ x: e.clientX, y: e.clientY, at });
            }}
            onClick={(e) => {
              const h = hovered.current;
              if (!h) return;
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right + 4, y: r.top, at: h });
            }}
          >
            <Icon name="grip" />
          </button>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={blockItems(editor, menu.at)} onClose={() => setMenu(null)} />}
    </>
  );
}

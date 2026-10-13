import { mergeAttributes, Node, type Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { Icon } from "../../../components/Icon";

export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 4;

const emptyColumn = () => ({ type: "column", content: [{ type: "paragraph" }] });

/** True when the caret is already inside a column: columns do not nest. */
export function insideColumn(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d >= 1; d--) if ($from.node(d).type.name === "column") return true;
  return false;
}

/** Inserts `count` empty columns where an empty block is (or after the current block) and puts the caret in the first. */
export function insertColumns(editor: Editor, count: number): boolean {
  if (insideColumn(editor)) return false;
  const { $from } = editor.state.selection;
  // The nearest top-level block around the caret.
  const index = $from.index(0);
  const block = editor.state.doc.child(index);
  const start = $from.before(1);
  const empty = block.type.name === "paragraph" && block.content.size === 0;
  const from = empty ? start : start + block.nodeSize;
  const to = empty ? start + block.nodeSize : from;
  const columns = { type: "columns", content: Array.from({ length: count }, emptyColumn) };
  editor.chain().focus().insertContentAt({ from, to }, [columns, { type: "paragraph" }]).run();
  // columns > column > paragraph: three openings to reach the first column's text.
  editor.commands.setTextSelection(from + 3);
  return true;
}

/** True while the selection sits anywhere inside this columns block, so the controls stay up for as long as it is being edited. */
function useFocusedWithin(editor: Editor, node: PMNode, getPos: NodeViewProps["getPos"]): boolean {
  const compute = () => {
    const pos = getPos();
    if (pos === undefined || !editor.isEditable) return false;
    const { from, to } = editor.state.selection;
    return from >= pos && to <= pos + node.nodeSize;
  };
  const [within, setWithin] = useState(compute);
  useEffect(() => {
    const update = () => setWithin(compute());
    update();
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, node]);
  return within;
}

function ColumnsView({ node, editor, getPos }: NodeViewProps) {
  const count = node.childCount;
  const editable = editor.isEditable;
  const active = useFocusedWithin(editor, node, getPos);
  const keep = (e: React.MouseEvent) => e.preventDefault(); // clicking a control must not move the caret out of the block

  const addColumn = () => {
    const pos = getPos();
    if (pos === undefined || count >= MAX_COLUMNS) return;
    const end = pos + node.nodeSize - 1; // just inside the closing edge of the columns node
    editor.chain().insertContentAt(end, emptyColumn()).run();
  };

  const removeLast = () => {
    const pos = getPos();
    if (pos === undefined || count <= MIN_COLUMNS) return;
    const last = node.lastChild as PMNode;
    const lastStart = pos + node.nodeSize - 1 - last.nodeSize;
    const prevEnd = lastStart - 1; // end of the previous column's content
    const blank = last.childCount === 1 && last.firstChild?.type.name === "paragraph" && last.firstChild.content.size === 0;
    const tr = editor.state.tr.delete(lastStart, lastStart + last.nodeSize);
    // Content in the removed column joins the one before it instead of being deleted.
    if (!blank) tr.insert(prevEnd, last.content);
    editor.view.dispatch(tr);
  };

  const remove = () => {
    const pos = getPos();
    if (pos === undefined) return;
    editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize).scrollIntoView());
    editor.view.focus();
  };

  const unwrap = () => {
    const pos = getPos();
    if (pos === undefined) return;
    const blocks: PMNode[] = [];
    node.forEach((column) => column.content.forEach((child) => blocks.push(child)));
    const tr = editor.state.tr.replaceWith(pos, pos + node.nodeSize, Fragment.from(blocks));
    editor.view.dispatch(tr);
  };

  return (
    <NodeViewWrapper className={`columns-wrap${active ? " is-active" : ""}`}>
      {editable && (
        <div className="columns-bar" contentEditable={false} role="toolbar" aria-label="Columns">
          <button type="button" className="cbar-btn" onMouseDown={keep} disabled={count >= MAX_COLUMNS} title="Add a column" onClick={addColumn}>
            <Icon name="plus" size={14} />
            Column
          </button>
          <button type="button" className="cbar-btn" onMouseDown={keep} disabled={count <= MIN_COLUMNS} title="Remove the last column" onClick={removeLast}>
            <Icon name="close" size={14} />
            Column
          </button>
          <button type="button" className="cbar-btn" onMouseDown={keep} title="Turn the columns back into ordinary blocks" onClick={unwrap}>
            Unwrap
          </button>
          <button type="button" className="cbar-btn danger" onMouseDown={keep} title="Delete the columns and everything in them" aria-label="Delete columns" onClick={remove}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      )}
      <NodeViewContent className="columns" data-count={count} />
    </NodeViewWrapper>
  );
}

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  defining: true,
  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "column" }, HTMLAttributes), 0];
  },
});

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column+", // the toolbar keeps it between 2 and 4; the schema stays lenient so odd stored data still loads
  isolating: true,
  defining: true,
  draggable: true,
  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "columns" }, HTMLAttributes), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ColumnsView);
  },
});

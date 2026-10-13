import { mergeAttributes, Node, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";

interface Heading {
  level: number;
  text: string;
  pos: number;
}

const headingCache = new WeakMap<Editor, { doc: Editor["state"]["doc"]; headings: Heading[] }>();

/** Every heading in the page, in order, with where it sits. Exported so the outline can be tested and reused. */
export function collectHeadings(editor: Editor): Heading[] {
  const cached = headingCache.get(editor);
  if (cached?.doc === editor.state.doc) return cached.headings;
  const out: Heading[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") out.push({ level: Number(node.attrs.level) || 1, text: node.textContent.trim(), pos });
    return !node.isTextblock; // headings hold no blocks, so there is nothing to look into
  });
  headingCache.set(editor, { doc: editor.state.doc, headings: out });
  return out;
}

function TocView({ editor }: NodeViewProps) {
  const [headings, setHeadings] = useState<Heading[]>(() => collectHeadings(editor));

  // Keep up with typing, and with the page's content arriving after the block first appears.
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => !editor.isDestroyed && setHeadings(collectHeadings(editor)), 150);
    };
    refresh();
    const onTransaction = ({ transaction }: { transaction: Editor["state"]["tr"] }) => {
      if (transaction.docChanged) refresh();
    };
    editor.on("transaction", onTransaction);
    return () => {
      window.clearTimeout(timer);
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  const go = (pos: number) => {
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
    dom?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const top = headings.length ? Math.min(...headings.map((h) => h.level)) : 1;
  return (
    <NodeViewWrapper className="toc" contentEditable={false}>
      <div className="toc-title">Contents</div>
      {headings.length === 0 ? (
        <p className="toc-empty">Add headings to this page and they will be listed here.</p>
      ) : (
        <nav aria-label="Contents">
          {headings.map((h, i) => (
            <button key={`${h.pos}:${i}`} type="button" className="toc-item" style={{ paddingLeft: 6 + (h.level - top) * 16 }} onClick={() => go(h.pos)}>
              {h.text || "Untitled"}
            </button>
          ))}
        </nav>
      )}
    </NodeViewWrapper>
  );
}

export const TableOfContents = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'div[data-type="table-of-contents"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "table-of-contents" }, HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TocView);
  },
});

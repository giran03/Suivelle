import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useState } from "react";

function TabsView({ node, editor, getPos }: NodeViewProps) {
  const [selected, setSelected] = useState(0);
  const active = Math.min(selected, node.childCount - 1);
  const panels = Array.from({ length: node.childCount }, (_, i) => node.child(i));
  const rename = (i: number, label: string) => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    let offset = pos + 1;
    for (let j = 0; j < i; j++) offset += node.child(j).nodeSize;
    editor.view.dispatch(editor.state.tr.setNodeAttribute(offset, "label", label));
  };
  return <NodeViewWrapper className="editor-tabs" data-active-tab={active}>
    <div className="editor-tab-bar" contentEditable={false}>
      <div role="tablist" aria-label="Content tabs">
        {panels.map((panel, i) => <button key={i} type="button" role="tab" aria-selected={active === i}
          tabIndex={active === i ? 0 : -1} onClick={() => setSelected(i)} onKeyDown={(event) => {
            let next = i;
            if (event.key === "ArrowRight") next = (i + 1) % panels.length;
            else if (event.key === "ArrowLeft") next = (i + panels.length - 1) % panels.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = panels.length - 1;
            else return;
            event.preventDefault(); setSelected(next);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
          }}>{panel.attrs.label}</button>)}
      </div>
      {editor.isEditable && <button type="button" aria-label="Add tab" onClick={() => {
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.commands.insertContentAt(pos + node.nodeSize - 1, { type: "tabPanel", attrs: { label: `Tab ${panels.length + 1}` }, content: [{ type: "paragraph" }] });
        setSelected(panels.length);
      }}>+</button>}
    </div>
    {editor.isEditable && <label className="editor-tab-label" contentEditable={false}>Tab name
      <input aria-label="Tab name" maxLength={80} value={panels[active]?.attrs.label ?? ""} onChange={(event) => rename(active, event.target.value)} />
    </label>}
    <NodeViewContent className="editor-tab-panels" />
    <style contentEditable={false}>{panels.map((_, i) => `.editor-tabs[data-active-tab="${i}"] > .editor-tab-panels > [data-node-view-content-react] > [data-type="tabPanel"]:nth-child(${i + 1}) { display: block; }`).join("\n")}</style>
  </NodeViewWrapper>;
}

export const Tabs = Node.create({
  name: "tabs", group: "block", content: "tabPanel+", defining: true, isolating: true,
  parseHTML: () => [{ tag: 'div[data-type="tabs"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "tabs" }), 0],
  addNodeView: () => ReactNodeViewRenderer(TabsView),
});

export const TabPanel = Node.create({
  name: "tabPanel", content: "block+", defining: true, isolating: true,
  addAttributes: () => ({ label: { default: "Tab", parseHTML: (el) => el.getAttribute("data-label"), renderHTML: ({ label }) => ({ "data-label": label, "aria-label": label || "Tab" }) } }),
  parseHTML: () => [{ tag: 'div[data-type="tabPanel"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "tabPanel", role: "tabpanel" }), 0],
});

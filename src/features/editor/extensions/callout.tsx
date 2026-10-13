import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Icon } from "../../../components/Icon";

export const CALLOUT_TONES = ["note", "tip", "warning"] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];
const LABEL: Record<CalloutTone, string> = { note: "Note", tip: "Tip", warning: "Warning" };

function CalloutView({ node, updateAttributes, editor, decorations }: NodeViewProps) {
  const placeholder = decorations.find((decoration) => decoration.type.attrs?.["data-placeholder"])?.type.attrs?.["data-placeholder"];
  const tone = (CALLOUT_TONES as readonly string[]).includes(node.attrs.tone) ? (node.attrs.tone as CalloutTone) : "note";
  const next = CALLOUT_TONES[(CALLOUT_TONES.indexOf(tone) + 1) % CALLOUT_TONES.length];
  return (
    <NodeViewWrapper className={`callout callout-${tone}`}>
      <button
        type="button"
        className="callout-icon"
        contentEditable={false}
        disabled={!editor.isEditable}
        aria-label={`${LABEL[tone]} callout. Change to ${LABEL[next]}`}
        title={`${LABEL[tone]} · click to change`}
        onClick={() => updateAttributes({ tone: next })}
      >
        <Icon name={tone} />
      </button>
      <NodeViewContent className="callout-body" data-placeholder={placeholder} />
    </NodeViewWrapper>
  );
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "inline*",
  defining: true,

  addAttributes() {
    return {
      tone: {
        default: "note",
        parseHTML: (el) => el.getAttribute("data-tone") ?? "note",
        renderHTML: (attrs) => ({ "data-tone": attrs.tone as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-callout": "" }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});

import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";

type Katex = typeof import("katex").default;

// KaTeX and its stylesheet are fetched the first time a page shows an equation, keeping them
// out of the editor's start-up code.
let katex: Katex | null = null;
let loading: Promise<Katex> | null = null;
function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([mod]) => (katex = mod.default));
  return loading;
}

function render(lib: Katex | null, latex: string): string {
  if (!lib || !latex.trim()) return "";
  // KaTeX escapes its output and has `trust` off, so the HTML it returns is safe to inject.
  return lib.renderToString(latex, { displayMode: true, throwOnError: false, strict: "ignore", output: "html" });
}

function EquationView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const latex = String(node.attrs.latex ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(latex);
  const [lib, setLib] = useState(katex);
  useEffect(() => {
    if (lib) return;
    let live = true;
    loadKatex().then((loaded) => live && setLib(() => loaded), () => { loading = null; });
    return () => { live = false; };
  }, [lib]);
  const html = useMemo(() => render(lib, latex), [lib, latex]);
  const preview = useMemo(() => (editing ? render(lib, draft) : ""), [lib, editing, draft]);

  // A freshly inserted, empty equation opens straight into editing.
  useEffect(() => {
    if (selected && latex === "" && editor.isEditable) {
      setDraft("");
      setEditing(true);
    }
  }, [selected, latex, editor]);

  const commit = () => {
    setEditing(false);
    if (draft !== latex) updateAttributes({ latex: draft });
    editor.commands.focus();
  };

  return (
    <NodeViewWrapper className={`equation${selected ? " is-selected" : ""}`} contentEditable={false}>
      {editing ? (
        <div className="equation-edit">
          <textarea
            autoFocus
            value={draft}
            rows={Math.min(8, Math.max(2, draft.split("\n").length))}
            placeholder="LaTeX, for example E = mc^2"
            aria-label="Equation (LaTeX)"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setDraft(latex);
                setEditing(false);
                editor.commands.focus();
              } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commit();
              }
            }}
          />
          {preview && <div className="equation-preview" dangerouslySetInnerHTML={{ __html: preview }} />}
          <p className="equation-hint">Ctrl+Enter to finish, Esc to cancel</p>
        </div>
      ) : (
        <button
          type="button"
          className="equation-display"
          disabled={!editor.isEditable}
          aria-label={latex ? `Equation: ${latex}. Edit` : "Add an equation"}
          onClick={() => {
            setDraft(latex);
            setEditing(true);
          }}
        >
          {html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : latex.trim() ? <code>{latex}</code> : <span className="media-empty-label">Add an equation</span>}
        </button>
      )}
    </NodeViewWrapper>
  );
}

export const Equation = Node.create({
  name: "equation",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-latex") ?? "",
        renderHTML: (attrs) => ({ "data-latex": attrs.latex as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-equation]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-equation": "" })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(EquationView);
  },
});

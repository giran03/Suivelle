import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";

const lowlight = createLowlight({ bash, css, javascript, json, markdown, python, rust, sql, typescript, xml, yaml });

export const CODE_LANGUAGES: { id: string; label: string }[] = [
  { id: "", label: "Plain text" },
  { id: "bash", label: "Shell" },
  { id: "css", label: "CSS" },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "markdown", label: "Markdown" },
  { id: "python", label: "Python" },
  { id: "rust", label: "Rust" },
  { id: "sql", label: "SQL" },
  { id: "typescript", label: "TypeScript" },
  { id: "xml", label: "HTML / XML" },
  { id: "yaml", label: "YAML" },
];

function CodeView({ node, updateAttributes, editor }: NodeViewProps) {
  return (
    <NodeViewWrapper className="code-block">
      <select
        contentEditable={false}
        value={(node.attrs.language as string | null) ?? ""}
        disabled={!editor.isEditable}
        aria-label="Code language"
        onChange={(e) => updateAttributes({ language: e.target.value || null })}
      >
        {CODE_LANGUAGES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
      <pre spellCheck={false}>
        <NodeViewContent as="div" className="code-content" />
      </pre>
    </NodeViewWrapper>
  );
}

export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeView);
  },
}).configure({ lowlight, defaultLanguage: null });

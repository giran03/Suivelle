// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { deleteBlockAt } from "./commands";
import { buildExtensions } from "./extensions";

let editor: Editor | null = null;
afterEach(() => { editor?.destroy(); editor = null; });

const para = (t?: string): JSONContent => ({ type: "paragraph", ...(t ? { content: [{ type: "text", text: t }] } : {}) });
const column = (...c: JSONContent[]): JSONContent => ({ type: "column", content: c });
const make = (content: JSONContent[]) => (editor = new Editor({ extensions: buildExtensions(), content: { type: "doc", content } }));
const types = (e: Editor) => e.state.doc.content.content.map((n) => n.type.name);

describe("deleteBlockAt", () => {
  it("removes the whole columns block when its only content is an empty paragraph", () => {
    const e = make([para("above"), { type: "columns", content: [column(para()), column(para())] }, para("below")]);
    let pos = -1;
    e.state.doc.descendants((n, p) => { if (pos < 0 && n.type.name === "paragraph" && n.content.size === 0) pos = p; });
    deleteBlockAt(e, pos);
    expect(types(e)).not.toContain("columns");
  });

  it("clears a lone filled block instead of failing", () => {
    const e = make([{ type: "columns", content: [column(para("keep")), column(para("x"))] }]);
    let pos = -1;
    e.state.doc.descendants((n, p) => { if (pos < 0 && n.type.name === "paragraph") pos = p; });
    deleteBlockAt(e, pos);
    expect(e.state.doc.textContent).toBe("x");
  });
});

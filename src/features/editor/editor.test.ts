// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { BLOCK_KINDS } from "./blockKinds";
import { blocksToDoc, diffBlocks, docToBlocks, positionsOf, type BlockRow } from "./convert";
import { duplicateBlock, moveBlock, selectBlockAt } from "./commands";
import { buildExtensions } from "./extensions";
import { findKey, getFind, setFind } from "./extensions/find";
import { collectHeadings } from "./extensions/tableOfContents";

const text = (t: string): JSONContent[] => [{ type: "text", text: t }];
const p = (t: string, id: string): JSONContent => ({ type: "paragraph", attrs: { blockId: id }, content: text(t) });

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function make(content: JSONContent): Editor {
  editor = new Editor({ extensions: buildExtensions(), content });
  return editor;
}

/** The editor keeps one empty paragraph after a final non-text block (click-to-write area). */
const withoutTrailing = (rows: BlockRow[], original: BlockRow[]) => {
  const known = new Set(original.map((r) => r.id));
  return rows.filter((r) => known.has(r.id) || r.dataJson !== '{"content":[]}');
};

const kind = (id: string) => BLOCK_KINDS.find((k) => k.id === id)!;
const types = (e: Editor) => (e.getJSON().content ?? []).map((n) => n.type);

describe("editor schema", () => {
  it("accepts every block type the converter can produce", () => {
    const rows: BlockRow[] = [
      ["paragraph", { content: text("a") }], ["heading_1", { content: text("h") }], ["bullet_list", { content: text("b") }],
      ["numbered_list", { content: text("n") }], ["todo", { content: text("t"), checked: true }],
      ["toggle", { content: text("tg"), open: false }], ["quote", { content: text("q") }], ["callout", { content: text("c"), tone: "warning" }],
      ["divider", {}], ["code", { language: "rust", text: "let x = 1;" }], ["equation", { latex: "x^2" }],
      ["image", { attachment: null }], ["audio", { attachment: null }], ["video", { attachment: null }],
      ["file", { attachment: null }], ["pdf", { attachment: null }],
    ].map(([type, data], i) => ({
      id: `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      parentBlockId: null, type: type as BlockRow["type"], position: i, dataJson: JSON.stringify(data), schemaVersion: 2,
    }));
    const e = make(blocksToDoc(rows));
    // Loading through the real schema and saving again must not change or lose any block.
    const back = withoutTrailing(docToBlocks(e.getJSON(), positionsOf(rows)), rows);
    const { upserts, deleteIds } = diffBlocks(new Map(rows.map((r) => [r.id, r])), back);
    expect(deleteIds).toEqual([]);
    expect(upserts.map((r) => r.id)).toEqual([]);
  });

  it("keeps ids unique after a split or duplicate", () => {
    const e = make({ type: "doc", content: [p("one", "a"), p("two", "b")] });
    e.commands.setTextSelection(2);
    duplicateBlock(e);
    const ids = (e.getJSON().content ?? []).map((n) => n.attrs?.blockId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("a");
    e.commands.setTextSelection(2);
    e.commands.splitBlock();
    const after = (e.getJSON().content ?? []).map((n) => n.attrs?.blockId);
    expect(new Set(after).size).toBe(after.length);
    expect(after.every(Boolean)).toBe(true);
  });
});

describe("block kinds (slash menu and turn-into)", () => {
  it("converts a paragraph into each text kind and keeps the block id where possible", () => {
    for (const id of ["heading_1", "heading_2", "heading_3", "quote", "callout", "code"]) {
      const e = make({ type: "doc", content: [p("hello", "keep")] });
      e.commands.setTextSelection(2);
      kind(id).apply(e);
      const node = e.getJSON().content![0];
      expect(node.type, id).not.toBe("paragraph");
      expect(node.attrs?.blockId, id).toBe("keep");
      e.destroy();
    }
  });

  it("builds lists, to-dos and toggles", () => {
    const expected: Record<string, string> = { bullet_list: "bulletList", numbered_list: "orderedList", todo: "taskList", toggle: "details" };
    for (const [id, type] of Object.entries(expected)) {
      const e = make({ type: "doc", content: [p("hello", "x")] });
      e.commands.setTextSelection(2);
      kind(id).apply(e);
      expect(e.getJSON().content![0].type, id).toBe(type);
      e.destroy();
    }
  });

  it("turns a list item back into text", () => {
    const e = make({ type: "doc", content: [p("hello", "x")] });
    e.commands.setTextSelection(2);
    kind("bullet_list").apply(e);
    kind("paragraph").apply(e);
    expect(types(e).filter((t) => t !== "paragraph")).toEqual([]);
    expect(e.getJSON().content![0].content).toEqual(text("hello"));
  });

  it("inserts structural blocks in place of an empty paragraph and keeps a trailing paragraph", () => {
    for (const [id, type] of [["divider", "horizontalRule"], ["table", "table"], ["equation", "equation"]] as const) {
      const e = make({ type: "doc", content: [{ type: "paragraph", attrs: { blockId: "e" } }] });
      e.commands.setTextSelection(1);
      kind(id).apply(e);
      expect(types(e), id).toEqual([type, "paragraph"]);
      e.destroy();
    }
  });

  it("inserts after a non-empty block instead of overwriting it", () => {
    const e = make({ type: "doc", content: [p("keep me", "x")] });
    e.commands.setTextSelection(3);
    kind("divider").apply(e);
    expect(types(e)).toEqual(["paragraph", "horizontalRule", "paragraph"]);
  });
});

describe("handle menu actions", () => {
  it("turns a list item into a heading after selecting it by position", () => {
    const e = make(
      blocksToDoc([
        { id: "i1", parentBlockId: null, type: "bullet_list", position: 0, dataJson: JSON.stringify({ content: text("first") }), schemaVersion: 2 },
        { id: "i2", parentBlockId: null, type: "bullet_list", position: 1, dataJson: JSON.stringify({ content: text("second") }), schemaVersion: 2 },
      ]),
    );
    let itemPos = -1;
    e.state.doc.descendants((n, pos) => {
      if (n.type.name === "listItem" && itemPos < 0) itemPos = pos;
    });
    selectBlockAt(e, itemPos);
    kind("heading_2").apply(e);
    const first = e.getJSON().content![0] as JSONContent;
    expect(first.type).toBe("heading");
    expect(JSON.stringify(first)).toContain("first");
  });
});

describe("list items with children", () => {
  const nested: BlockRow[] = [
    { id: "p", parentBlockId: null, type: "bullet_list", position: 0, dataJson: JSON.stringify({ content: text("parent") }), schemaVersion: 2 },
    { id: "c", parentBlockId: "p", type: "bullet_list", position: 0, dataJson: JSON.stringify({ content: text("child") }), schemaVersion: 2 },
  ];

  it("turns the parent into a heading and keeps the child", () => {
    const e = make(blocksToDoc(nested));
    e.commands.setTextSelection(3);
    kind("heading_2").apply(e);
    const top = (e.getJSON().content ?? []).map((n) => n.type);
    expect(top.slice(0, 2)).toEqual(["heading", "bulletList"]);
    const rows = docToBlocks(e.getJSON()).filter((r) => r.dataJson !== '{"content":[]}');
    const label = (r: BlockRow) => `${r.type}:${(JSON.parse(r.dataJson) as { content: { text: string }[] }).content[0].text}`;
    expect(rows.map(label)).toEqual(["heading_2:parent", "bullet_list:child"]);
  });

  it("inserts a divider in place of a list item that has children", () => {
    const e = make(blocksToDoc(nested));
    e.commands.setTextSelection(3);
    kind("divider").apply(e);
    expect((e.getJSON().content ?? []).some((n) => n.type === "horizontalRule")).toBe(true);
  });
});

describe("moving blocks", () => {
  it("swaps with the neighbour and keeps the caret in the moved block", () => {
    const e = make({ type: "doc", content: [p("one", "a"), p("two", "b"), p("three", "c")] });
    e.commands.setTextSelection(7); // inside "two"
    expect(moveBlock(e, -1)).toBe(true);
    expect((e.getJSON().content ?? []).map((n) => n.attrs?.blockId)).toEqual(["b", "a", "c"]);
    expect(e.state.selection.$from.parent.textContent).toBe("two");
    expect(moveBlock(e, 1)).toBe(true);
    expect(moveBlock(e, 1)).toBe(true);
    expect(moveBlock(e, 1)).toBe(false);
    expect((e.getJSON().content ?? []).map((n) => n.attrs?.blockId)).toEqual(["a", "c", "b"]);
  });

  it("moves list items within their list", () => {
    const e = make(
      blocksToDoc([
        { id: "i1", parentBlockId: null, type: "bullet_list", position: 0, dataJson: JSON.stringify({ content: text("first") }), schemaVersion: 2 },
        { id: "i2", parentBlockId: null, type: "bullet_list", position: 1, dataJson: JSON.stringify({ content: text("second") }), schemaVersion: 2 },
      ]),
    );
    e.commands.setTextSelection(e.state.doc.content.size - 3);
    expect(moveBlock(e, -1)).toBe(true);
    const rows = docToBlocks(e.getJSON(), new Map()).filter((r) => r.dataJson !== '{"content":[]}');
    expect(rows.map((r) => r.id)).toEqual(["i2", "i1"]);
  });
});

describe("page references", () => {
  const target = "0190a000-0000-7000-8000-000000000042";

  it("keeps mentions and internal links through a save and reload", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "r" },
          content: [
            { type: "text", text: "see " },
            { type: "pageMention", attrs: { pageId: target } },
            { type: "text", text: " and " },
            { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: `suivelle://page/${target}` } }] },
          ],
        },
      ],
    };
    const e = make(doc);
    const rows = docToBlocks(e.getJSON());
    const data = JSON.parse(rows[0].dataJson) as { content: JSONContent[] };
    expect(data.content[1]).toEqual({ type: "pageMention", attrs: { pageId: target } });
    expect(JSON.stringify(data.content[3].marks)).toContain(`suivelle://page/${target}`);
    const again = make(blocksToDoc(rows));
    expect(JSON.stringify(again.getJSON())).toContain(target);
    expect(again.getHTML()).toContain("data-page-mention");
  });

  it("accepts the internal link scheme in the link field and rejects other schemes", async () => {
    const { normalizeHref } = await import("./SelectionToolbar");
    expect(normalizeHref(`suivelle://page/${target}`)).toBe(`suivelle://page/${target}`);
    expect(normalizeHref("example.com")).toBe("https://example.com");
    expect(normalizeHref("javascript:alert(1)")).toBeNull();
    expect(normalizeHref("suivelle://other/thing")).toBeNull();
  });
});

describe("keyboard behaviours", () => {
  it("keeps block ids while typing and still normalizes structural paste and undo", () => {
    const e = make({ type: "doc", content: [p("one", "a"), p("two", "b")] });
    e.view.dispatch(e.state.tr.insertText("X", 2));
    expect(e.getJSON().content?.map((node) => node.attrs?.blockId)).toEqual(["a", "b"]);
    e.commands.insertContentAt(e.state.doc.content.size, p("pasted", "a"));
    const ids = e.getJSON().content!.map((node) => node.attrs?.blockId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("a");
    e.commands.undo();
    const undone = e.getJSON().content!.map((node) => node.attrs?.blockId);
    expect(new Set(undone).size).toBe(undone.length);
  });

  it("steps between existing find matches without rescanning text and refreshes after an edit", () => {
    const e = make({ type: "doc", content: [p("one one one", "a")] });
    setFind(e, { query: "one" });
    const before = getFind(e);
    e.view.dispatch(e.state.tr.setMeta(findKey, { index: 1 }));
    const next = getFind(e);
    expect(next.matches).toBe(before.matches);
    expect(next.index).toBe(1);
    expect(Array.from(e.view.dom.querySelectorAll(".find-current"))).toHaveLength(1);
    e.view.dispatch(e.state.tr.insertText("two", next.matches[1].from, next.matches[1].to));
    expect(getFind(e).matches).toHaveLength(2);
    e.view.dispatch(e.state.tr.setMeta(findKey, { clear: true }));
    expect(getFind(e).matches).toHaveLength(0);
  });

  it("shares heading collection until the editor document changes", () => {
    const e = make({ type: "doc", content: [{ type: "heading", attrs: { level: 1, blockId: "h" }, content: text("Title") }, p("body", "p")] });
    const headings = collectHeadings(e);
    expect(collectHeadings(e)).toBe(headings);
    e.commands.setTextSelection(2);
    expect(collectHeadings(e)).toBe(headings);
    e.view.dispatch(e.state.tr.insertText("new ", 1));
    expect(collectHeadings(e)[0].text).toBe("new Title");
    expect(collectHeadings(e)).not.toBe(headings);
  });

  it("rich text marks survive a save and reload", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", attrs: { blockId: "m" }, content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }, { type: "text", text: " and ", }, { type: "text", text: "tone", marks: [{ type: "tone", attrs: { fg: "violet", bg: null } }] }] }],
    };
    const e = make(doc);
    const rows = docToBlocks(e.getJSON());
    const content = JSON.parse(rows[0].dataJson).content as JSONContent[];
    expect(content[0].marks?.[0].type).toBe("bold");
    expect(content[2].marks?.[0].attrs?.fg).toBe("violet");
    const reloaded = make(blocksToDoc(rows));
    expect(reloaded.getHTML()).toContain('data-fg="violet"');
  });
});

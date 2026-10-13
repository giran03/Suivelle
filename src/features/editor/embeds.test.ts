import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { blocksToDoc, docToBlocks, type BlockRow } from "./convert";

const para = (id: string, text: string): JSONContent => ({ type: "paragraph", attrs: { blockId: id }, content: [{ type: "text", text }] });

const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

const row = (id: string, type: BlockRow["type"], parent: string | null, position: number, data: object = {}): BlockRow => ({
  id,
  type,
  parentBlockId: parent,
  position,
  dataJson: JSON.stringify(data),
  schemaVersion: 2,
});

describe("columns", () => {
  const columns: JSONContent = {
    type: "columns",
    attrs: { blockId: "cols" },
    content: [
      { type: "column", attrs: { blockId: "c1" }, content: [para("a", "left")] },
      { type: "column", attrs: { blockId: "c2" }, content: [para("b", "right"), para("c", "more")] },
    ],
  };

  it("is stored as a columns row with column rows and their blocks nested beneath", () => {
    const rows = docToBlocks(doc(columns));
    expect(rows.map((r) => [r.id, r.type, r.parentBlockId])).toEqual([
      ["cols", "columns", null],
      ["c1", "column", "cols"],
      ["a", "paragraph", "c1"],
      ["c2", "column", "cols"],
      ["b", "paragraph", "c2"],
      ["c", "paragraph", "c2"],
    ]);
  });

  it("comes back as the same document", () => {
    const back = blocksToDoc(docToBlocks(doc(columns)));
    expect(back.content).toHaveLength(1);
    const node = back.content![0];
    expect(node.type).toBe("columns");
    expect(node.content!.map((c) => c.type)).toEqual(["column", "column"]);
    expect(node.content![1].content!.map((p) => p.content![0].text)).toEqual(["right", "more"]);
  });

  it("pads a lone column up to two so the layout is never broken", () => {
    const rows = [row("cols", "columns", null, 1), row("c1", "column", "cols", 1), row("a", "paragraph", "c1", 1, { content: [{ type: "text", text: "x" }] })];
    const node = blocksToDoc(rows).content![0];
    expect(node.content).toHaveLength(2);
  });

  it("gives empty columns a paragraph to type in", () => {
    const rows = [row("cols", "columns", null, 1), row("c1", "column", "cols", 1), row("c2", "column", "cols", 2)];
    const node = blocksToDoc(rows).content![0];
    expect(node.content!.every((c) => c.content?.[0]?.type === "paragraph")).toBe(true);
  });

  it("keeps the content of a column that lost its columns parent", () => {
    const rows = [row("c1", "column", null, 1), row("a", "paragraph", "c1", 1, { content: [{ type: "text", text: "kept" }] })];
    const out = blocksToDoc(rows).content!;
    expect(out.map((n) => n.type)).toEqual(["paragraph"]);
    expect(out[0].content![0].text).toBe("kept");
  });

  it("keeps stray blocks that were stored directly inside columns", () => {
    const rows = [
      row("cols", "columns", null, 1),
      row("c1", "column", "cols", 1),
      row("c2", "column", "cols", 2),
      row("s", "paragraph", "cols", 3, { content: [{ type: "text", text: "stray" }] }),
    ];
    const types = blocksToDoc(rows).content!.map((n) => n.type);
    expect(types).toEqual(["columns", "paragraph"]);
  });
});

describe("database view block", () => {
  it("stores which database and view it shows, and its height", () => {
    const node: JSONContent = { type: "databaseView", attrs: { blockId: "dv", pageId: "page-1", viewId: "view-2", height: 420 } };
    const [saved] = docToBlocks(doc(node));
    expect(saved.type).toBe("database_view");
    expect(JSON.parse(saved.dataJson)).toEqual({ pageId: "page-1", viewId: "view-2", height: 420 });
    const back = blocksToDoc([saved]).content![0];
    expect(back.attrs).toMatchObject({ blockId: "dv", pageId: "page-1", viewId: "view-2", height: 420 });
  });

  it("loads an unconfigured block as empty rather than failing", () => {
    const back = blocksToDoc([row("dv", "database_view", null, 1, {})]).content![0];
    expect(back.attrs).toMatchObject({ pageId: null, viewId: null, height: null });
  });
});

describe("table of contents block", () => {
  it("is stored as a block with no data and comes back as the same node", () => {
    const [saved] = docToBlocks(doc({ type: "tableOfContents", attrs: { blockId: "toc" } }));
    expect(saved.type).toBe("table_of_contents");
    expect(saved.dataJson).toBe("{}");
    const back = blocksToDoc([saved]).content![0];
    expect(back.type).toBe("tableOfContents");
    expect(back.attrs).toMatchObject({ blockId: "toc" });
  });
});

describe("synced block", () => {
  it("stores which page holds its content and comes back as the same node", () => {
    const [saved] = docToBlocks(doc({ type: "syncedBlock", attrs: { blockId: "sb", pageId: "content-page" } }));
    expect(saved.type).toBe("synced_block");
    expect(JSON.parse(saved.dataJson)).toEqual({ pageId: "content-page" });
    const back = blocksToDoc([saved]).content![0];
    expect(back.type).toBe("syncedBlock");
    expect(back.attrs).toMatchObject({ blockId: "sb", pageId: "content-page" });
  });

  it("loads an unconfigured block as empty rather than failing", () => {
    const back = blocksToDoc([row("sb", "synced_block", null, 1, {})]).content![0];
    expect(back.attrs).toMatchObject({ pageId: null });
  });
});

describe("a file that is still being stored", () => {
  it("is not saved as a block until the file is in", () => {
    const pending: JSONContent = { type: "image", attrs: { blockId: "m1", pending: "tok", name: "shot.png" } };
    const rows = docToBlocks(doc(pending, { type: "paragraph", attrs: { blockId: "p" }, content: [{ type: "text", text: "after" }] }));
    expect(rows.map((r) => r.type)).toEqual(["paragraph"]);
  });

  it("is saved normally once it has its attachment", () => {
    const done: JSONContent = { type: "image", attrs: { blockId: "m1", pending: null, attachmentId: "a1", hash: "h", name: "shot.png", mime: "image/png", size: 7 } };
    const [row] = docToBlocks(doc(done));
    expect(row.type).toBe("image");
    expect(JSON.parse(row.dataJson).attachment).toMatchObject({ id: "a1", name: "shot.png" });
  });
});

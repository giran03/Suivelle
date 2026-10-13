import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  assignPositions,
  blocksToDoc,
  diffBlocks,
  docToBlocks,
  emptyTable,
  migrateBlockData,
  positionsOf,
  type BlockRow,
} from "./convert";

const text = (t: string): JSONContent[] => [{ type: "text", text: t }];
const row = (id: string, type: BlockRow["type"], position: number, data: object, parent: string | null = null): BlockRow => ({
  id, parentBlockId: parent, type, position, dataJson: JSON.stringify(data), schemaVersion: 2,
});
const toMap = (rows: BlockRow[]) => new Map(rows.map((r) => [r.id, r]));

describe("migrateBlockData", () => {
  it("upgrades v1 plain text to v2 rich content", () => {
    expect(migrateBlockData(1, '{"text":"hello"}')).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect(migrateBlockData(1, '{"text":""}')).toEqual({ content: [] });
  });
  it("leaves v2 untouched and survives broken JSON", () => {
    expect(migrateBlockData(2, '{"content":[],"checked":true}')).toEqual({ content: [], checked: true });
    expect(migrateBlockData(1, "not json")).toEqual({ content: [] });
    expect(migrateBlockData(2, "[1,2]")).toEqual({});
  });
});

describe("blocksToDoc / docToBlocks", () => {
  const rows: BlockRow[] = [
    row("h", "heading_2", 0, { content: text("Title") }),
    row("p", "paragraph", 1, { content: text("Hello") }),
    row("b1", "bullet_list", 2, { content: text("one") }),
    row("b2", "bullet_list", 3, { content: text("two") }),
    row("b2a", "bullet_list", 0, { content: text("nested") }, "b2"),
    row("t1", "todo", 4, { content: text("task"), checked: true }),
    row("tg", "toggle", 5, { content: text("More"), open: true }),
    row("tgc", "paragraph", 0, { content: text("hidden") }, "tg"),
    row("q", "quote", 6, { content: text("said") }),
    row("c", "callout", 7, { content: text("note"), tone: "tip" }),
    row("d", "divider", 8, {}),
    row("code", "code", 9, { language: "rust", text: "fn main() {}" }),
    row("eq", "equation", 10, { latex: "x^2" }),
    row("img", "image", 11, { attachment: { id: "a1", hash: "h1", name: "cat.png", mime: "image/png", size: 5 } }),
    row("tbl", "simple_table", 12, { table: emptyTable() }),
  ];

  it("merges consecutive list rows into one list and nests children", () => {
    const doc = blocksToDoc(rows);
    const types = doc.content!.map((n) => n.type);
    expect(types).toEqual([
      "heading", "paragraph", "bulletList", "taskList", "details", "quote", "callout",
      "horizontalRule", "codeBlock", "equation", "image", "table",
    ]);
    const bullets = doc.content![2];
    expect(bullets.content).toHaveLength(2);
    expect(bullets.content![1].content![1].type).toBe("bulletList"); // nested under "two"
    expect(doc.content![4].content![1].content![0].type).toBe("paragraph"); // toggle child
  });

  it("round-trips back to identical rows", () => {
    const doc = blocksToDoc(rows);
    const back = docToBlocks(doc, positionsOf(rows));
    const norm = (r: BlockRow[]) =>
      [...r].sort((a, b) => a.id.localeCompare(b.id)).map((x) => ({ ...x, dataJson: JSON.parse(x.dataJson) }));
    expect(norm(back)).toEqual(norm(rows));
  });

  it("keeps an unchanged document from producing any writes", () => {
    const doc = blocksToDoc(rows);
    const { upserts, deleteIds } = diffBlocks(toMap(rows), docToBlocks(doc, positionsOf(rows)));
    expect(upserts).toEqual([]);
    expect(deleteIds).toEqual([]);
  });

  it("falls back to top level for orphans and survives an empty page", () => {
    expect(blocksToDoc([row("x", "paragraph", 0, { content: text("a") }, "missing")]).content).toHaveLength(1);
    expect(blocksToDoc([]).content).toEqual([{ type: "paragraph" }]);
  });

  it("loads v1 blocks as rich text and upgrades them on the next diff", () => {
    const v1: BlockRow = { id: "old", parentBlockId: null, type: "paragraph", position: 0, dataJson: '{"text":"legacy"}', schemaVersion: 1 };
    const doc = blocksToDoc([v1]);
    expect(doc.content![0].content).toEqual(text("legacy"));
    const { upserts } = diffBlocks(toMap([v1]), docToBlocks(doc, positionsOf([v1])));
    expect(upserts).toHaveLength(1);
    expect(upserts[0].schemaVersion).toBe(2);
  });

  it("strips editor-only block ids from stored tables", () => {
    const table = emptyTable();
    table.content![0].content![0].content![0].attrs = { blockId: "cell-para" };
    const out = docToBlocks({ type: "doc", content: [{ ...table, attrs: { blockId: "tbl" } }] });
    expect(out[0].dataJson).not.toContain("blockId");
  });

  it("assigns ids to nodes that have none instead of crashing", () => {
    const out = docToBlocks({ type: "doc", content: [{ type: "paragraph", content: text("x") }] });
    expect(out[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("diffBlocks", () => {
  const base = [
    row("a", "paragraph", 0, { content: text("a") }),
    row("b", "paragraph", 1, { content: text("b") }),
    row("c", "paragraph", 2, { content: text("c") }),
  ];

  it("writes only the inserted block when adding in the middle", () => {
    const doc = blocksToDoc(base);
    doc.content!.splice(1, 0, { type: "paragraph", attrs: { blockId: "n" }, content: text("new") });
    const { upserts, deleteIds } = diffBlocks(toMap(base), docToBlocks(doc, positionsOf(base)));
    expect(upserts.map((r) => r.id)).toEqual(["n"]);
    expect(upserts[0].position).toBeGreaterThan(0);
    expect(upserts[0].position).toBeLessThan(1);
    expect(deleteIds).toEqual([]);
  });

  it("reports edits and deletions", () => {
    const doc = blocksToDoc(base);
    doc.content![0].content = text("edited");
    doc.content!.splice(2, 1);
    const { upserts, deleteIds } = diffBlocks(toMap(base), docToBlocks(doc, positionsOf(base)));
    expect(upserts.map((r) => r.id)).toEqual(["a"]);
    expect(deleteIds).toEqual(["c"]);
  });

  it("re-parents a block without deleting it", () => {
    const doc = blocksToDoc(base);
    // Move "c" into "b" as a child by turning b into a list parent.
    const [a, , c] = doc.content!;
    const rowsNext = docToBlocks({ type: "doc", content: [a, { type: "bulletList", content: [{ type: "listItem", attrs: { blockId: "b" }, content: [{ type: "paragraph", content: text("b") }, c] }] }] }, positionsOf(base));
    const { upserts, deleteIds } = diffBlocks(toMap(base), rowsNext);
    expect(deleteIds).toEqual([]);
    expect(upserts.find((r) => r.id === "c")?.parentBlockId).toBe("b");
    expect(upserts.find((r) => r.id === "b")?.type).toBe("bullet_list");
  });
});

describe("assignPositions", () => {
  it("keeps order-preserving positions and fills gaps", () => {
    const prev = new Map([["a", 0], ["b", 1], ["c", 2]]);
    expect(assignPositions(["a", "b", "c"], prev)).toEqual([0, 1, 2]);
    expect(assignPositions(["a", "x", "b"], prev)).toEqual([0, 0.5, 1]);
    expect(assignPositions(["x", "a"], prev)).toEqual([-1, 0]);
    expect(assignPositions(["c", "x"], prev)).toEqual([2, 3]);
    expect(assignPositions(["n1", "n2"], new Map())).toEqual([0, 1]);
  });

  it("renumbers when repeated splitting exhausts precision", () => {
    const prev = new Map([["a", 0], ["z", 1e-8]]);
    expect(assignPositions(["a", "m", "z"], prev)).toEqual([0, 1, 2]);
  });
});

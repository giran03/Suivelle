import { expect, it } from "vitest";
import { blocksToDoc, docToBlocks, diffBlocks, positionsOf, type BlockRow } from "./convert";

// To see timings: npm test -- src/features/editor/performance.test.ts --silent=false
it("round-trips a 10,000-block document and writes only the changed row", () => {
  const rows: BlockRow[] = Array.from({ length: 10_000 }, (_, i) => ({
    id: `block-${i}`, parentBlockId: null, type: "paragraph", position: i,
    dataJson: JSON.stringify({ content: [{ type: "text", text: `Paragraph ${i}` }] }), schemaVersion: 2,
  }));
  const stored = new Map(rows.map((r) => [r.id, r]));
  const start = performance.now();
  const doc = blocksToDoc(rows);
  const loaded = performance.now();
  doc.content![5000].content![0].text = "Edited paragraph";
  const next = docToBlocks(doc, positionsOf(rows));
  const diff = diffBlocks(stored, next);
  console.log(JSON.stringify({ blocks: rows.length, loadMs: loaded - start, saveDiffMs: performance.now() - loaded, jsonBytes: JSON.stringify(doc).length }));
  expect(diff.upserts).toHaveLength(1);
  expect(diff.upserts[0].id).toBe("block-5000");
  expect(diff.deleteIds).toEqual([]);
});

it("loads 10,000 consecutive list items without losing sibling order", () => {
  const rows: BlockRow[] = Array.from({ length: 10_000 }, (_, i) => ({
    id: `item-${i}`, parentBlockId: null, type: "bullet_list", position: i,
    dataJson: JSON.stringify({ content: [{ type: "text", text: `Item ${i}` }] }), schemaVersion: 2,
  }));
  const doc = blocksToDoc(rows);
  expect(doc.content).toHaveLength(1);
  expect(doc.content![0].content).toHaveLength(10_000);
  const diff = diffBlocks(new Map(rows.map((r) => [r.id, r])), docToBlocks(doc, positionsOf(rows)));
  expect(diff.upserts).toEqual([]);
  expect(diff.deleteIds).toEqual([]);
});

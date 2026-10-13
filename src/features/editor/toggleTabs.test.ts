// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import { BLOCK_KINDS, filterKinds } from "./blockKinds";
import { buildExtensions } from "./extensions";
import { blocksToDoc, docToBlocks } from "./convert";
import { blockItems } from "./BlockHandle";
const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach(e => e.destroy()));
const make = () => {
  const e = new Editor({ extensions: buildExtensions(), content: '<p><strong>Keep me</strong></p>' });
  editors.push(e); e.commands.setTextSelection(2); return e;
};
it("offers toggle levels in slash search and converts the context-menu block without losing its body", () => {
  expect(filterKinds("toggle").map(k => k.id)).toEqual(expect.arrayContaining(["toggle", "toggle_heading_1", "toggle_heading_2", "toggle_heading_3", "toggle_heading_4"]));
  const e = make();
  BLOCK_KINDS.find(k => k.id === "toggle")!.apply(e);
  const rowId = e.state.doc.firstChild!.attrs.blockId;
  const node = e.state.doc.firstChild!;
  const bodyPos = 1 + node.firstChild!.nodeSize + 1;
  e.commands.insertContentAt(bodyPos, { type: "paragraph", content: [{ type: "text", text: "Nested content" }] });
  for (const level of [1, 2, 3, 4]) {
    blockItems(e, { pos: 0, node: e.state.doc.firstChild! }).find(k => k.label === `Turn into Toggle heading ${level}`)!.onSelect();
    const rows = docToBlocks(e.getJSON());
    expect(JSON.parse(rows[0].dataJson).level).toBe(level);
    expect(rows[0].id).toBe(rowId);
    expect(e.state.doc.textContent).toContain("Nested content");
    const reloaded = blocksToDoc(rows);
    expect(reloaded.content![0].content![0].attrs!.level).toBe(level);
    expect(reloaded.content![0].content![0].content![0].marks).toEqual([{ type: "bold" }]);
  }
  e.commands.undo();
  expect(e.state.doc.textContent).toContain("Keep me");
});
it("round trips tabs, labels and content through persisted rows", () => {
  const e = make(); e.commands.clearContent();
  BLOCK_KINDS.find(k => k.id === "tabs")!.apply(e);
  expect(e.state.doc.firstChild!.type.name).toBe("tabs");
  const panelPos = 1;
  e.view.dispatch(e.state.tr.setNodeAttribute(panelPos, "label", "Notes"));
  e.commands.insertContentAt(3, "Saved inside the first tab");
  const rows = docToBlocks(e.getJSON());
  expect(rows.filter(r => r.type === "tab_panel")).toHaveLength(2);
  const reloaded = new Editor({ extensions: buildExtensions(), content: blocksToDoc(rows) });
  editors.push(reloaded);
  expect(reloaded.state.doc.firstChild!.firstChild!.attrs.label).toBe("Notes");
  expect(reloaded.state.doc.textContent).toContain("Saved inside the first tab");
  expect(docToBlocks(reloaded.getJSON())).toEqual(rows);
});

it("turns the selected block into tabs and retains its text and formatting", () => {
  const e = make();
  blockItems(e, { pos: 0, node: e.state.doc.firstChild! }).find(k => k.label === "Turn into Tabs")!.onSelect();
  expect(e.state.doc.firstChild!.type.name).toBe("tabs");
  expect(e.state.doc.textContent).toContain("Keep me");
  expect(e.state.doc.firstChild!.firstChild!.firstChild!.firstChild!.marks.map(m => m.type.name)).toEqual(["bold"]);
});

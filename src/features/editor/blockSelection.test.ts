// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import { Selection } from "@tiptap/pm/state";
import { DOMParser } from "@tiptap/pm/model";
import { buildExtensions } from "./extensions";
import { BlockRangeSelection, blockRange } from "./blockSelection";
import { TURN_INTO, mergeSelectedBlocksInto } from "./blockKinds";
import {
  duplicateSelectedBlocks,
  moveSelectedBlocks,
  selectedBlockItems,
} from "./blockSelectionActions";

let editor: Editor;
afterEach(() => editor?.destroy());
const paragraph = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const image = {
  type: "image",
  attrs: { attachmentId: "attachment", hash: "hash", name: "Image" },
};
function make(
  content: JSONContent[] = [paragraph("Before"), image, paragraph("After")],
) {
  editor = new Editor({
    extensions: buildExtensions(),
    content: { type: "doc", content },
  });
  return editor;
}
function select(fromIndex: number, toIndex: number) {
  const blocks = blockRange(editor.state.doc, 0, editor.state.doc.content.size);
  editor.view.dispatch(
    editor.state.tr.setSelection(
      BlockRangeSelection.create(
        editor.state.doc,
        blocks[fromIndex].pos,
        blocks[toIndex].pos + blocks[toIndex].node.nodeSize,
      ),
    ),
  );
}
it("serializes whole mixed blocks and keeps block selection through attribute updates", () => {
  make();
  select(0, 1);
  const selection = editor.state.selection;
  expect(selection.content().content.childCount).toBe(2);
  expect(selection.content().openStart).toBe(0);
  expect(
    Selection.fromJSON(editor.state.doc, selection.toJSON()).eq(selection),
  ).toBe(true);
  editor.view.dispatch(
    editor.state.tr.setNodeAttribute(0, "blockId", "updated"),
  );
  expect(editor.state.selection).toBeInstanceOf(BlockRangeSelection);
  expect(
    blockRange(
      editor.state.doc,
      editor.state.selection.from,
      editor.state.selection.to,
    ),
  ).toHaveLength(2);
});
it("duplicates a mixed range together, with distinct block IDs and undo", () => {
  make();
  select(0, 1);
  expect(duplicateSelectedBlocks(editor)).toBe(true);
  expect(editor.state.doc.content.childCount).toBe(5);
  expect(
    blockRange(
      editor.state.doc,
      editor.state.selection.from,
      editor.state.selection.to,
    ).map((b) => b.node.type.name),
  ).toEqual(["paragraph", "image"]);
  const ids = blockRange(
    editor.state.doc,
    0,
    editor.state.doc.content.size,
  ).map((b) => b.node.attrs.blockId);
  expect(new Set(ids).size).toBe(ids.length);
  editor.commands.undo();
  expect(editor.state.doc.content.childCount).toBe(3);
});
it("moves a whole range without reversing its order or crossing page boundaries", () => {
  make();
  select(1, 2);
  expect(moveSelectedBlocks(editor, 1)).toBe(false);
  expect(moveSelectedBlocks(editor, -1)).toBe(true);
  expect(editor.state.doc.child(0).type.name).toBe("image");
  expect(editor.state.doc.child(1).textContent).toBe("After");
  expect(editor.state.doc.child(2).textContent).toBe("Before");
  expect(moveSelectedBlocks(editor, -1)).toBe(false);
  expect(moveSelectedBlocks(editor, 1)).toBe(true);
  expect(editor.state.doc.child(0).textContent).toBe("Before");
});
it("deletes an entire page safely and restores it with undo", () => {
  make();
  select(0, 2);
  editor.view.dispatch(editor.state.tr.deleteSelection());
  expect(editor.state.doc.childCount).toBe(1);
  expect(editor.state.doc.child(0).type.name).toBe("paragraph");
  editor.commands.undo();
  expect(editor.state.doc.childCount).toBe(3);
});
it("shows only shared bulk capabilities and removes editing actions in read-only mode", () => {
  make();
  select(0, 1);
  let labels = selectedBlockItems(editor).map((i) => i.label);
  expect(labels).toContain("Duplicate blocks");
  expect(labels).not.toContain("Move up");
  expect(labels).not.toContain("Align center");
  editor.commands.setContent({
    type: "doc",
    content: [image, image, paragraph("After")],
  });
  select(0, 1);
  const align = selectedBlockItems(editor).find(
    (i) => i.label === "Align center",
  )!;
  align.onSelect();
  expect(editor.state.doc.child(0).attrs.presentation.align).toBe("center");
  expect(editor.state.doc.child(1).attrs.presentation.align).toBe("center");
  expect(editor.state.selection).toBeInstanceOf(BlockRangeSelection);
  editor.setEditable(false);
  labels = selectedBlockItems(editor).map((i) => i.label);
  expect(labels).toEqual(["Copy blocks", "Copy text", "Copy image…", "Select all blocks"]);
});
it("copies and pastes mixed blocks with attachment identity and image presentation intact", () => {
  make();
  const presentation = {
    caption: "Caption",
    width: 50,
    widthMode: "percent",
    note: "Private context",
    crop: { x: 0.2, y: 0.1, width: 0.4, height: 0.5 },
  };
  const imagePos = blockRange(
    editor.state.doc,
    0,
    editor.state.doc.content.size,
  )[1].pos;
  editor.view.dispatch(
    editor.state.tr.setNodeAttribute(imagePos, "presentation", presentation),
  );
  select(0, 2);
  const { dom } = editor.view.serializeForClipboard(
    editor.state.selection.content(),
  );
  const parsed = DOMParser.fromSchema(editor.schema).parse(dom);
  const copied = blockRange(parsed, 0, parsed.content.size).find(
    (b) => b.node.type.name === "image",
  )!.node;
  expect(copied.attrs.attachmentId).toBe("attachment");
  expect(copied.attrs.presentation).toEqual(presentation);
});

const taskList = {
  type: "taskList",
  content: ["One", "Two", "Three", "Four"].map((text, i) => ({
    type: "taskItem",
    attrs: { checked: i % 2 === 0 },
    content: [paragraph(text)],
  })),
};
it("selects and duplicates only individual task rows, preserving checked state and undo", () => {
  make([taskList, paragraph("After")]);
  select(1, 2);
  const selected = blockRange(
    editor.state.doc,
    editor.state.selection.from,
    editor.state.selection.to,
  );
  expect(selected.map((b) => b.node.textContent)).toEqual(["Two", "Three"]);
  expect(editor.state.selection.content().openStart).toBe(1);
  expect(duplicateSelectedBlocks(editor)).toBe(true);
  const tasks = editor.state.doc.child(0);
  expect(tasks.childCount).toBe(6);
  expect(tasks.child(3).textContent).toBe("Two");
  expect(tasks.child(3).attrs.checked).toBe(false);
  expect(tasks.child(4).textContent).toBe("Three");
  expect(tasks.child(4).attrs.checked).toBe(true);
  expect(
    blockRange(
      editor.state.doc,
      editor.state.selection.from,
      editor.state.selection.to,
    ).map((b) => b.node.textContent),
  ).toEqual(["Two", "Three"]);
  editor.commands.undo();
  expect(editor.state.doc.child(0).childCount).toBe(4);
});
it("moves and deletes only the selected task rows, and removes an exhausted task list", () => {
  make([taskList, paragraph("After")]);
  select(1, 2);
  expect(moveSelectedBlocks(editor, -1)).toBe(true);
  expect(editor.state.doc.child(0).child(0).textContent).toBe("Two");
  expect(editor.state.doc.child(0).child(1).textContent).toBe("Three");
  expect(moveSelectedBlocks(editor, -1)).toBe(false);
  expect(selectedBlockItems(editor).map((i) => i.label)).not.toContain(
    "Move up",
  );
  editor.view.dispatch(editor.state.tr.deleteSelection());
  expect(editor.state.doc.child(0).childCount).toBe(2);
  expect(editor.state.doc.child(0).child(0).textContent).toBe("One");
  select(0, 1);
  editor.view.dispatch(editor.state.tr.deleteSelection());
  expect(editor.state.doc.childCount).toBe(1);
  expect(editor.state.doc.child(0).textContent).toBe("After");
});
it("duplicates a mixed range of tasks and following page blocks without duplicating unselected tasks", () => {
  make([taskList, paragraph("After")]);
  select(2, 4);
  expect(duplicateSelectedBlocks(editor)).toBe(true);
  const rows = blockRange(editor.state.doc, 0, editor.state.doc.content.size);
  expect(rows.map((b) => b.node.textContent)).toEqual([
    "One",
    "Two",
    "Three",
    "Four",
    "After",
    "Three",
    "Four",
    "After",
  ]);
});
it("selects one nested task without selecting its parent or siblings", () => {
  make([
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: true },
          content: [paragraph("Parent"), taskList],
        },
        { type: "taskItem", content: [paragraph("Sibling")] },
      ],
    },
    paragraph("After"),
  ]);
  let pos = 0,
    size = 0;
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "taskItem" && node.textContent === "Two") {
      pos = position;
      size = node.nodeSize;
    }
  });
  editor.view.dispatch(
    editor.state.tr.setSelection(
      BlockRangeSelection.create(editor.state.doc, pos, pos + size),
    ),
  );
  expect(
    blockRange(
      editor.state.doc,
      editor.state.selection.from,
      editor.state.selection.to,
    ).map((b) => b.node.textContent),
  ).toEqual(["Two"]);
  editor.view.dispatch(editor.state.tr.deleteSelection());
  const parent = editor.state.doc.child(0).child(0);
  expect(parent.attrs.checked).toBe(true);
  expect(parent.child(1).childCount).toBe(3);
  expect(parent.child(1).child(0).textContent).toBe("One");
});

it("turns multiple selected blocks into quote, callout, headings and back to text, keeping block IDs and undo", () => {
  make([
    {
      type: "paragraph",
      attrs: { blockId: "b1" },
      content: [{ type: "text", text: "First", marks: [{ type: "bold" }] }],
    },
    { type: "paragraph", attrs: { blockId: "b2" }, content: [{ type: "text", text: "Second" }] },
    { type: "paragraph", attrs: { blockId: "b3" }, content: [{ type: "text", text: "Third" }] },
  ]);
  select(0, 1);
  selectedBlockItems(editor).find((i) => i.label === "Turn into Quote")!.onSelect();
  expect(editor.state.doc.child(0).type.name).toBe("quote");
  expect(editor.state.doc.child(1).type.name).toBe("quote");
  expect(editor.state.doc.child(2).type.name).toBe("paragraph");
  expect(editor.state.doc.child(0).attrs.blockId).toBe("b1");
  expect(editor.state.doc.child(1).attrs.blockId).toBe("b2");
  expect(editor.state.doc.child(0).firstChild?.marks.map((m) => m.type.name)).toEqual(["bold"]);
  expect(editor.state.selection).toBeInstanceOf(BlockRangeSelection);

  selectedBlockItems(editor).find((i) => i.label === "Turn into Callout")!.onSelect();
  expect(editor.state.doc.child(0).type.name).toBe("callout");
  expect(editor.state.doc.child(1).type.name).toBe("callout");

  selectedBlockItems(editor).find((i) => i.label === "Turn into Heading 2")!.onSelect();
  expect(editor.state.doc.child(0).type.name).toBe("heading");
  expect(editor.state.doc.child(0).attrs.level).toBe(2);
  expect(editor.state.doc.child(1).type.name).toBe("heading");
  expect(editor.state.doc.child(1).attrs.level).toBe(2);

  selectedBlockItems(editor).find((i) => i.label === "Turn into Text")!.onSelect();
  expect(editor.state.doc.child(0).type.name).toBe("paragraph");
  expect(editor.state.doc.child(1).type.name).toBe("paragraph");
  expect(editor.state.doc.child(0).attrs.blockId).toBe("b1");
  expect(editor.state.doc.child(1).attrs.blockId).toBe("b2");

  editor.commands.undo();
  expect(editor.state.doc.child(0).type.name).toBe("heading");
  expect(editor.state.doc.child(1).type.name).toBe("heading");
});

it("merges multiple selected blocks into a single code block joined by newlines", () => {
  make([
    { type: "paragraph", attrs: { blockId: "c1" }, content: [{ type: "text", text: "const a = 1;" }] },
    { type: "paragraph", attrs: { blockId: "c2" }, content: [{ type: "text", text: "const b = 2;" }] },
    { type: "paragraph", attrs: { blockId: "c3" }, content: [{ type: "text", text: "After" }] },
  ]);
  select(0, 1);
  selectedBlockItems(editor).find((i) => i.label === "Turn into Code")!.onSelect();
  expect(editor.state.doc.childCount).toBe(2);
  expect(editor.state.doc.child(0).type.name).toBe("codeBlock");
  expect(editor.state.doc.child(0).attrs.blockId).toBe("c1");
  expect(editor.state.doc.child(0).textContent).toBe("const a = 1;\nconst b = 2;");
  expect(editor.state.doc.child(1).textContent).toBe("After");

  editor.commands.undo();
  expect(editor.state.doc.childCount).toBe(3);
  expect(editor.state.doc.child(0).textContent).toBe("const a = 1;");
  expect(editor.state.doc.child(1).textContent).toBe("const b = 2;");
});

it("converts multiple blocks to lists and splits partial list selections cleanly", () => {
  make([taskList, paragraph("After")]);
  // Select middle two task items ("Two", "Three") and turn them into Quote
  select(1, 2);
  selectedBlockItems(editor).find((i) => i.label === "Turn into Quote")!.onSelect();
  expect(editor.state.doc.child(0).type.name).toBe("taskList");
  expect(editor.state.doc.child(0).childCount).toBe(1);
  expect(editor.state.doc.child(0).child(0).textContent).toBe("One");
  expect(editor.state.doc.child(1).type.name).toBe("quote");
  expect(editor.state.doc.child(1).textContent).toBe("Two");
  expect(editor.state.doc.child(2).type.name).toBe("quote");
  expect(editor.state.doc.child(2).textContent).toBe("Three");
  expect(editor.state.doc.child(3).type.name).toBe("taskList");
  expect(editor.state.doc.child(3).child(0).textContent).toBe("Four");

  // Turn those two quotes back into To-do list: merges back with surrounding taskLists!
  selectedBlockItems(editor).find((i) => i.label === "Turn into To-do list")!.onSelect();
  expect(editor.state.doc.child(0).type.name).toBe("taskList");
  expect(editor.state.doc.child(0).childCount).toBe(4);
  expect(
    blockRange(editor.state.doc, editor.state.selection.from, editor.state.selection.to).map(
      (b) => b.node.textContent,
    ),
  ).toEqual(["Two", "Three"]);
});

it("converts multiple blocks into individual toggles and wraps multiple blocks into Tab 1 of tabs", () => {
  make([
    { type: "paragraph", attrs: { blockId: "t1" }, content: [{ type: "text", text: "One" }] },
    { type: "paragraph", attrs: { blockId: "t2" }, content: [{ type: "text", text: "Two" }] },
    paragraph("After"),
  ]);
  select(0, 1);
  selectedBlockItems(editor).find((i) => i.label === "Turn into Toggle heading 2")!.onSelect();
  expect(editor.state.doc.childCount).toBe(3);
  expect(editor.state.doc.child(0).type.name).toBe("details");
  expect(editor.state.doc.child(0).attrs.blockId).toBe("t1");
  expect(editor.state.doc.child(0).firstChild?.attrs.level).toBe(2);
  expect(editor.state.doc.child(1).type.name).toBe("details");
  expect(editor.state.doc.child(1).attrs.blockId).toBe("t2");

  editor.commands.undo();
  select(0, 1);
  selectedBlockItems(editor).find((i) => i.label === "Turn into Tabs")!.onSelect();
  const tabs = editor.state.doc.firstChild!;
  expect(tabs.type.name).toBe("tabs");
  expect(tabs.firstChild!.childCount).toBe(2);
  expect(tabs.firstChild!.child(0).textContent).toBe("One");
  expect(tabs.firstChild!.child(1).textContent).toBe("Two");
});

it("disables Turn into items when a non-convertible block such as an image is in the selection", () => {
  make(); // [paragraph("Before"), image, paragraph("After")]
  select(0, 1);
  const quoteItem = selectedBlockItems(editor).find((i) => i.label === "Turn into Quote")!;
  expect(quoteItem.disabled).toBe(true);
});

it("offers all merge targets for mixed blocks and retains formatting, callout tone, IDs and undo", () => {
  make([
    {
      type: "quote",
      attrs: { blockId: "q1" },
      content: [{ type: "text", text: "First quote", marks: [{ type: "bold" }] }],
    },
    {
      type: "quote",
      attrs: { blockId: "q2" },
      content: [{ type: "text", text: "Second quote" }],
    },
    {
      type: "callout",
      attrs: { blockId: "c1", tone: "warning" },
      content: [{ type: "text", text: "Watch out" }],
    },
    {
      type: "callout",
      attrs: { blockId: "c2", tone: "note" },
      content: [{ type: "text", text: "More details" }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "p1" },
      content: [{ type: "text", text: "Line one" }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "p2" },
      content: [{ type: "text", text: "Line two" }],
    },
  ]);
  const mergeItems = () => selectedBlockItems(editor).find(i => i.label === "Merge all into…")!.children!;
  select(1, 2);
  expect(mergeItems().filter(i => i.label.startsWith("Merge"))).toHaveLength(TURN_INTO.length);
  expect(mergeItems().every(i => !i.disabled)).toBe(true);

  // Merge quotes
  select(0, 1);
  mergeItems().find((i) => i.label === "Merge into one quote")!.onSelect();
  const mergedQuote = editor.state.doc.child(0);
  expect(mergedQuote.type.name).toBe("quote");
  expect(mergedQuote.attrs.blockId).toBe("q1");
  expect(mergedQuote.childCount).toBe(3);
  expect(mergedQuote.child(0).text).toBe("First quote");
  expect(mergedQuote.child(0).marks.map((m) => m.type.name)).toEqual(["bold"]);
  expect(mergedQuote.child(1).type.name).toBe("hardBreak");
  expect(mergedQuote.child(2).text).toBe("Second quote");
  editor.commands.undo();

  // Merge callouts (preserves first callout's tone and blockId)
  select(2, 3);
  mergeItems().find((i) => i.label === "Merge into one callout")!.onSelect();
  const mergedCallout = editor.state.doc.child(2);
  expect(mergedCallout.type.name).toBe("callout");
  expect(mergedCallout.attrs.blockId).toBe("c1");
  expect(mergedCallout.attrs.tone).toBe("warning");
  expect(mergedCallout.child(1).type.name).toBe("hardBreak");
  expect(mergedCallout.textContent).toBe("Watch outMore details");
  editor.commands.undo();

  // Merge paragraphs
  select(4, 5);
  mergeItems().find((i) => i.label === "Merge into one paragraph")!.onSelect();
  const mergedParagraph = editor.state.doc.child(4);
  expect(mergedParagraph.type.name).toBe("paragraph");
  expect(mergedParagraph.attrs.blockId).toBe("p1");
  expect(mergedParagraph.child(1).type.name).toBe("hardBreak");
  expect(mergedParagraph.textContent).toBe("Line oneLine two");
  editor.commands.undo();
  expect(editor.state.doc.childCount).toBe(6);
});

it.each(TURN_INTO.map(kind => kind.id))("merges mixed blocks into %s as one valid, undoable result", kind => {
  make([
    { ...paragraph("Before"), attrs: { blockId: "before" } },
    { type: "heading", attrs: { level: 2, blockId: "head" }, content: [{ type: "text", text: "Title", marks: [{ type: "bold" }] }] },
    { type: "quote", attrs: { blockId: "quote" }, content: [{ type: "text", text: "Quote" }] },
    { type: "codeBlock", attrs: { blockId: "code", language: "javascript" }, content: [{ type: "text", text: "a\nb" }] },
    { ...paragraph("After"), attrs: { blockId: "after" } },
  ]);
  select(1, 3);
  const original = editor.getJSON();
  expect(mergeSelectedBlocksInto(editor, kind)).toBe(true);
  editor.state.doc.check();
  expect(editor.state.doc.childCount).toBe(3);
  expect(editor.state.doc.firstChild!.textContent).toBe("Before");
  expect(editor.state.doc.lastChild!.textContent).toBe("After");
  expect(editor.state.selection).toBeInstanceOf(BlockRangeSelection);
  expect(editor.state.doc.child(1).textContent.replace(/\n/g, "")).toBe("TitleQuoteab");
  const result = editor.getJSON();
  expect(editor.commands.undo()).toBe(true);
  expect(editor.getJSON()).toEqual(original);
  expect(editor.commands.redo()).toBe(true);
  expect(editor.getJSON()).toEqual(result);
});

it("lets the merge menu combine text with spaces instead of line breaks", () => {
  make([paragraph("One"), { type: "codeBlock", content: [{ type: "text", text: "Two\nThree" }] }, paragraph("After")]);
  select(0, 1);
  const items = selectedBlockItems(editor).find(i => i.label === "Merge all into…")!.children!;
  items.find(i => i.label === "Keep line breaks")!.onSelect();
  items.find(i => i.label === "Merge into one quote")!.onSelect();
  expect(editor.state.doc.firstChild!.textContent).toBe("One Two Three");
  expect(editor.state.doc.firstChild!.childCount).toBe(1);
  editor.commands.undo();
  select(0, 1);
  expect(mergeSelectedBlocksInto(editor, "code")).toBe(true);
  expect(editor.state.doc.firstChild!.textContent).toBe("One\nTwo\nThree");
});

it("merges partial nested list ranges without consuming unselected rows", () => {
  make([taskList, paragraph("After")]);
  select(1, 2);
  expect(mergeSelectedBlocksInto(editor, "quote")).toBe(true);
  editor.state.doc.check();
  expect(editor.state.doc.childCount).toBe(4);
  expect(editor.state.doc.child(0).textContent).toBe("One");
  expect(editor.state.doc.child(1).textBetween(0, editor.state.doc.child(1).content.size, "", "\n")).toBe("Two\nThree");
  expect(editor.state.doc.child(2).textContent).toBe("Four");
  expect(editor.state.doc.child(3).textContent).toBe("After");
});

it("includes nested toggle bodies, lists, empty lines and inline mentions in text merges", () => {
  make([
    { type: "details", attrs: { open: true }, content: [
      { type: "detailsSummary", content: [{ type: "text", text: "Summary", marks: [{ type: "italic" }] }] },
      { type: "detailsContent", content: [paragraph("Body"), { type: "bulletList", content: [
        { type: "listItem", content: [paragraph("Nested")] },
      ] }] },
    ] },
    { type: "paragraph" },
    { type: "paragraph", content: [{ type: "pageMention", attrs: { pageId: "page-id" } }] },
  ]);
  select(0, 2);
  expect(mergeSelectedBlocksInto(editor, "quote")).toBe(true);
  const quote = editor.state.doc.firstChild!;
  expect(quote.textBetween(0, quote.content.size, "", "\n")).toBe("Summary\nBody\nNested\n\n\n");
  expect(quote.firstChild!.marks[0].type.name).toBe("italic");
  expect(quote.lastChild!.attrs.pageId).toBe("page-id");
  editor.state.doc.check();
});

it.each(["tabs", "toggle", "bullet_list", "numbered_list", "todo"])("retains embedded blocks when merging into %s", kind => {
  make([paragraph("Label"), image, { type: "equation", attrs: { latex: "x^2" } }]);
  select(0, 2);
  expect(mergeSelectedBlocksInto(editor, kind)).toBe(true);
  editor.state.doc.check();
  const types: string[] = [];
  editor.state.doc.descendants(node => {
    if (["image", "equation"].includes(node.type.name)) types.push(node.type.name);
  });
  expect(types).toEqual(["image", "equation"]);
});

it("offers every merge target for media selections and guards read-only, single-block and unknown targets", () => {
  make([image, { type: "equation", attrs: { latex: "x^2" } }]);
  select(0, 1);
  const targets = selectedBlockItems(editor).find(i => i.label === "Merge all into…")!.children!.slice(1);
  expect(targets).toHaveLength(TURN_INTO.length);
  expect(targets.some(i => i.disabled)).toBe(false);
  const original = editor.getJSON();
  expect(mergeSelectedBlocksInto(editor, "image")).toBe(false);
  expect(editor.getJSON()).toEqual(original);
  editor.setEditable(false);
  expect(mergeSelectedBlocksInto(editor, "quote")).toBe(false);
  expect(selectedBlockItems(editor).some(i => i.children)).toBe(false);
  editor.setEditable(true);
  select(0, 0);
  expect(mergeSelectedBlocksInto(editor, "quote")).toBe(false);
  expect(selectedBlockItems(editor).some(i => i.children)).toBe(false);
});

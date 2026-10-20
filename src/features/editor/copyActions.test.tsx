// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { buildExtensions } from "./extensions";
import { BlockRangeSelection } from "./blockSelection";
import { selectedBlockItems } from "./blockSelectionActions";
import { blockItems } from "./BlockHandle";
import { EditorContextMenu } from "./EditorContextMenu";
import { selectedPlainText } from "./plainText";
import { readingAction } from "../../lib/access";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let editor: Editor;
let root: Root | undefined;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  editor?.destroy();
  document.body.replaceChildren();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});
const text = (value: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text: value }] });
const image = (name = "photo.png"): JSONContent => ({ type: "image", attrs: { attachmentId: name, hash: "hash", name } });
function make(content: JSONContent[]) {
  const element = document.createElement("div"); document.body.append(element);
  editor = new Editor({ element, extensions: buildExtensions(), content: { type: "doc", content } });
  return editor;
}
function selectAll() {
  editor.view.dispatch(editor.state.tr.setSelection(BlockRangeSelection.create(editor.state.doc, 0, editor.state.doc.content.size)));
}
function clipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined), write = vi.fn();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText, write } });
  return { writeText, write };
}
function imageDom(pos: number, animated: boolean) {
  const dom = document.createElement("div"); dom.className = "image-block"; dom.dataset.animated = String(animated);
  (editor.view.nodeDOM(pos) as HTMLElement).append(dom);
  return dom;
}
async function openContext(pos = 1) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<EditorContextMenu editor={editor} />));
  vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos, inside: 0 });
  await act(async () => (editor.view.nodeDOM(0) as HTMLElement).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })));
}

it("copies mixed blocks as plain text with line breaks, without HTML or Markdown", () => {
  make([
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title", marks: [{ type: "bold" }] }] },
    { type: "quote", content: [{ type: "text", text: "Quote" }] },
    { type: "codeBlock", content: [{ type: "text", text: "a\nb" }] },
    { type: "taskList", content: [{ type: "taskItem", content: [text("Task")] }] },
  ]);
  selectAll(); const original = editor.getJSON();
  const copy = selectedBlockItems(editor).find(item => item.label === "Copy text")!;
  const { writeText, write } = clipboard();
  editor.commands.setTextSelection(1); // Menu focus must not replace the captured range.
  copy.onSelect();
  expect(writeText).toHaveBeenCalledWith("Title\nQuote\na\nb\nTask");
  expect(write).not.toHaveBeenCalled();
  expect(editor.getJSON()).toEqual(original);
});

it("retains nested content, mentions, math, paths, captions and embed URLs, excluding private image notes", () => {
  make([
    { type: "details", content: [
      { type: "detailsSummary", content: [{ type: "text", text: "Summary" }] },
      { type: "detailsContent", content: [text("Body")] },
    ] },
    { type: "paragraph", content: [{ type: "pageMention", attrs: { pageId: "page-id" } }] },
    { type: "paragraph", content: [{ type: "text", text: "brief.pdf", marks: [{ type: "smartReference", attrs: { kind: "file", value: "C:\\notes\\brief.pdf" } }] }] },
    { type: "equation", attrs: { latex: "x^2" } },
    { ...image(), attrs: { ...image().attrs, presentation: { caption: "Visible caption", note: "Private note" } } },
    { type: "embed", attrs: { url: "https://example.com/" } },
  ]);
  selectAll();
  expect(selectedPlainText(editor)).toBe("Summary\nBody\nsuivelle://page/page-id\nC:\\notes\\brief.pdf\nx^2\nVisible caption\nhttps://example.com/");
});

it("offers plain text and image copying in read-only block selections", () => {
  make([text("Read only"), image()]); selectAll(); editor.setEditable(false);
  const { writeText } = clipboard();
  const items = selectedBlockItems(editor);
  items.find(item => item.label === "Copy text")!.onSelect();
  expect(writeText).toHaveBeenCalledWith("Read only\n");
  expect(items.some(item => item.label === "Copy image")).toBe(true);
  expect(items.some(item => item.label === "Cut blocks")).toBe(false);
});

it("lets a multi-image selection copy a chosen image or animated still frame", () => {
  make([image(), image()]);
  const second = editor.state.doc.child(0).nodeSize;
  const firstDom = imageDom(0, false), secondDom = imageDom(second, true);
  const firstCopy = vi.fn(), secondCopy = vi.fn();
  firstDom.addEventListener("image-action", firstCopy); secondDom.addEventListener("image-action", secondCopy);
  selectAll();
  vi.spyOn(editor.view, "nodeDOM").mockImplementation(pos => pos === 0 ? firstDom : pos === second ? secondDom : null);
  const children = selectedBlockItems(editor).find(item => item.label === "Copy image…")!.children!;
  expect(children.map(item => item.label)).toEqual(["Copy image 1: photo.png", "Copy image 2: photo.png (still frame)"]);
  expect(children.every(item => readingAction(item.label))).toBe(true);
  children[1].onSelect();
  expect(firstCopy).not.toHaveBeenCalled();
  expect((secondCopy.mock.calls[0][0] as CustomEvent).detail).toBe("copy-still");
});

it("offers image copying in the gutter and disables Copy text for an image without a caption", () => {
  make([image()]); const dom = imageDom(0, false), copied = vi.fn(); dom.addEventListener("image-action", copied);
  const items = blockItems(editor, { pos: 0, node: editor.state.doc.firstChild! });
  expect(items.find(item => item.label === "Copy text")?.disabled).toBe(true);
  items.find(item => item.label === "Copy image")!.onSelect();
  expect((copied.mock.calls[0][0] as CustomEvent).detail).toBe("copy-image");
});

it("copies only selected text from the context menu, or the current block when no text is selected", async () => {
  make([text("Hello world"), text("Do not copy")]); editor.commands.setTextSelection({ from: 1, to: 6 });
  const { writeText } = clipboard(); await openContext();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Copy text"]')!.click());
  expect(writeText).toHaveBeenLastCalledWith("Hello");
  editor.commands.setTextSelection(1);
  await act(async () => (editor.view.nodeDOM(0) as HTMLElement).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  expect(document.querySelectorAll('[aria-label="Copy text"]')).toHaveLength(1);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Copy text"]')!.click());
  expect(writeText).toHaveBeenLastCalledWith("Hello world");
});

it("does not duplicate Copy image when the image context menu includes gutter actions", async () => {
  make([image()]); imageDom(0, false); await openContext(0);
  expect(document.querySelectorAll('[aria-label="Copy image"]')).toHaveLength(1);
});

it("routes a multi-block right-click to plain text copying", async () => {
  make([text("First"), { type: "quote", content: [{ type: "text", text: "Second", marks: [{ type: "italic" }] }] }]);
  selectAll(); const { writeText } = clipboard(); await openContext();
  expect(document.querySelector('[aria-label="Copy blocks"]')).not.toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Copy text"]')!.click());
  expect(writeText).toHaveBeenCalledWith("First\nSecond");
});

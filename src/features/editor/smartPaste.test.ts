// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import { buildExtensions } from "./extensions";
import { convertSmartReference, pasteSmart, smartToken } from "./smartPaste";
import { plainPaste, selectedPlainText } from "./plainText";
import { blocksToDoc, docToBlocks } from "./convert";
import { jsonToMarkdown } from "./markdown";
import { BlockRangeSelection } from "./blockSelection";

let editor: Editor;
afterEach(() => { editor?.destroy(); plainPaste.active = false; });
const make = (text = "") => editor = new Editor({ extensions: buildExtensions(), content: { type: "doc", content: [{ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) }] } });

it("recognizes exact colors, issue URLs and quoted absolute paths without consuming other text", () => {
  for (const color of ["#ABC", "#ABCD", "#3B82F6", "#3B82F680"]) expect(smartToken(color)?.kind).toBe("color");
  expect(smartToken("https://github.com/openai/codex/issues/123")?.label).toBe("openai/codex #123");
  expect(smartToken('"C:\\My files\\brief.pdf"')).toMatchObject({ kind: "file", value: "C:\\My files\\brief.pdf", label: "brief.pdf" });
  expect(smartToken("\\\\server\\share\\brief.pdf")?.kind).toBe("file");
  expect(smartToken("/home/me/brief.pdf")?.kind).toBe("file");
  for (const raw of ["#GGGGGG", "#12345", "text #123", "#123\n#456", "relative/file.txt", "javascript:alert(1)", "https://github.com.evil.test/x/y/issues/1", "https://github.com/x/y/pull/1", "C:\\dir\\..\\file.txt"]) expect(smartToken(raw)).toBeNull();
});

it("links selected words before media conversion and restores selection/formatting with one Undo", () => {
  make("Read the brief");
  editor.chain().setTextSelection({ from: 1, to: 5 }).setBold().run();
  expect(pasteSmart(editor, "https://example.com/image.png")).toBe(true);
  expect(editor.getText()).toBe("Read the brief");
  expect(editor.getAttributes("link").href).toBe("https://example.com/image.png");
  expect(editor.isActive("bold")).toBe(true);
  editor.commands.undo();
  expect(editor.getAttributes("link").href).toBeUndefined();
  expect(editor.isActive("bold")).toBe(true);
  expect(editor.state.selection.from).toBe(1);
  expect(editor.state.selection.to).toBe(5);
  editor.commands.redo();
  expect(editor.getAttributes("link").href).toBe("https://example.com/image.png");
});

it("keeps reference metadata across stored blocks, HTML copy and Markdown, with isolated Undo/Redo", () => {
  make();
  expect(pasteSmart(editor, "C:\\My files\\brief.pdf")).toBe(true);
  expect(editor.getText()).toBe("brief.pdf");
  const rows = docToBlocks(editor.getJSON());
  editor.commands.setContent(blocksToDoc(rows));
  const html = editor.getHTML();
  expect(html).toContain("data-smart-kind=\"file\"");
  expect(html).toContain("C:\\My files\\brief.pdf");
  editor.commands.selectAll();
  expect(selectedPlainText(editor)).toBe("C:\\My files\\brief.pdf");
  expect(jsonToMarkdown(editor.getJSON().content!)).toContain("C:\\My files\\brief.pdf");
  editor.commands.setContent(html);
  expect(editor.getJSON().content![0].content![0].marks).toEqual(expect.arrayContaining([expect.objectContaining({ type: "smartReference" })]));
  editor.destroy();
  make();
  expect(pasteSmart(editor, "#3B82F6")).toBe(true);
  editor.commands.insertContent(" next");
  editor.commands.undo();
  expect(editor.getText()).toBe("#3B82F6");
  editor.commands.undo();
  expect(editor.getText()).toBe("");
  editor.commands.redo();
  expect(editor.getText()).toBe("#3B82F6");
});

it("bypasses plain paste, inline/block code, rich clipboard content and block selections", () => {
  make();
  plainPaste.active = true;
  expect(pasteSmart(editor, "#3B82F6")).toBe(false);
  plainPaste.active = false;
  editor.commands.setCode();
  expect(pasteSmart(editor, "#3B82F6")).toBe(false);
  editor.commands.unsetCode();
  editor.commands.toggleCodeBlock();
  expect(pasteSmart(editor, "#3B82F6")).toBe(false);
  editor.commands.toggleCodeBlock();
  expect(pasteSmart(editor, "#3B82F6", "<table><tr><td>#3B82F6</td></tr></table>")).toBe(false);
  expect(pasteSmart(editor, "#3B82F6", "<p>#3B82F6</p>")).toBe(true);
  editor.view.dispatch(editor.state.tr.setSelection(BlockRangeSelection.create(editor.state.doc, 0, editor.state.doc.content.size)));
  expect(pasteSmart(editor, "#FFF")).toBe(false);
});

it("routes real clipboard paste through Intake and keeps issue text searchable and linked", () => {
  make();
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [], getData: (type: string) => type === "text/plain" ? "https://github.com/openai/codex/issues/123" : "" } });
  editor.view.dom.dispatchEvent(event);
  expect(editor.getText()).toBe("openai/codex #123");
  expect(editor.getHTML()).toContain("https://github.com/openai/codex/issues/123");
  editor.commands.undo();
  expect(editor.getText()).toBe("");
});

it("converts only the clicked badge when the selection includes surrounding text", () => {
  make("Before ");
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  pasteSmart(editor, "C:\\notes\\brief.pdf");
  editor.commands.insertContent(" after");
  editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
  expect(convertSmartReference(editor, 8)).toBe(true);
  expect(editor.getText()).toBe("Before C:\\notes\\brief.pdf after");
  expect(editor.getHTML()).not.toContain("data-smart-kind");
});

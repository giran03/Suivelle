// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildExtensions } from "./extensions";
import { convertMediaPaste, mediaUrlHint, pasteMediaUrl, useMediaPaste } from "./mediaPaste";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Workspace, Attachment } from "../../types";
import { plainPaste } from "./plainText";

let editor: Editor;
const original = useWorkspace.getState();
const id = "00000000-0000-7000-8000-000000000001";
const thumbnail = "https://encrypted-tbn0.gstatic.com/images?q=example&s=10";
beforeEach(() => {
  useWorkspace.setState({ workspace: { id } as Workspace });
  editor = new Editor({ extensions: buildExtensions(), content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Before " }] }] } });
  editor.commands.setTextSelection(8);
});
afterEach(() => {
  editor.destroy();
  for (const r of useMediaPaste.getState().requests) useMediaPaste.getState().dismiss(r.id);
  vi.restoreAllMocks(); useWorkspace.setState(original, true);
});
it("recognizes queried GIFs, direct audio/video/PDF, and supported embeds", () => {
  for (const [url, kind] of [["a.GIF?download=1", "image"], ["a.mp3", "audio"], ["a.mp4", "video"], ["a.pdf", "pdf"]]) {
    expect(mediaUrlHint(`https://example.com/${url}`)).toBe(kind);
  }
  expect(mediaUrlHint("https://youtu.be/dQw4w9WgXcQ")).toBe("embed");
  expect(mediaUrlHint(thumbnail)).toBeNull();
});
it("handles URL paste through the editor plugin, while preserving plain paste and code", () => {
  const url = "https://example.com/animation.gif";
  const event = { clipboardData: { files: [], getData: (kind: string) => kind === "text/plain" ? url : "" }, preventDefault: vi.fn() } as unknown as ClipboardEvent;
  const intake = editor.state.plugins.find(p => (p as unknown as { key: string }).key.startsWith("intake$"))!;
  const paste = () => intake.props.handlePaste!.call(intake, editor.view, event, editor.state.selection.content());
  expect(paste()).toBe(true);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(useMediaPaste.getState().requests).toHaveLength(1);
  plainPaste.active = true;
  try { expect(paste()).toBe(false); } finally { plainPaste.active = false; }
  editor.commands.setContent({ type: "doc", content: [{ type: "codeBlock" }] });
  expect(paste()).toBe(false);
});
it("detects extensionless media from MIME, requests consent, and keeps the link when declined", async () => {
  vi.spyOn(ipc, "mediaUrlInfo").mockResolvedValue({ kind: "image", mime: "image/jpeg", name: "images.jpg", size: 123 });
  const download = vi.spyOn(ipc, "attachmentImportUrl");
  expect(pasteMediaUrl(editor, thumbnail)).toBe(true);
  await vi.waitFor(() => expect(useMediaPaste.getState().requests).toHaveLength(1));
  expect(download).not.toHaveBeenCalled();
  useMediaPaste.getState().dismiss(useMediaPaste.getState().requests[0].id);
  expect(editor.getText()).toBe(`Before ${thumbnail}`);
  expect(editor.getHTML()).toContain("href=");
});
it("downloads only after confirmation, inserts a local GIF, and tracks intervening edits", async () => {
  const download = vi.spyOn(ipc, "attachmentImportUrl").mockResolvedValue({ id, hash: "a".repeat(64), originalName: "animation.gif", mimeType: "image/gif", size: 123 } as Attachment);
  pasteMediaUrl(editor, "https://example.com/animation.gif");
  const r = useMediaPaste.getState().requests[0];
  expect(download).not.toHaveBeenCalled();
  editor.commands.insertContentAt(1, "Prefix ");
  await convertMediaPaste(r);
  expect(download).toHaveBeenCalledWith(id, r.url);
  expect(editor.getText()).toContain("Prefix Before");
  expect(editor.getText()).not.toContain(r.url);
  expect(editor.getJSON().content?.find(n => n.type === "image")?.attrs).toMatchObject({ attachmentId: id, mime: "image/gif" });
  expect(useMediaPaste.getState().requests).toHaveLength(0);
});
it("retains the link and allows retry after a failed download", async () => {
  vi.spyOn(ipc, "attachmentImportUrl").mockRejectedValue(new Error("Offline"));
  pasteMediaUrl(editor, "https://example.com/photo.png");
  const r = useMediaPaste.getState().requests[0];
  await expect(convertMediaPaste(r)).rejects.toThrow("Offline");
  expect(editor.getText()).toContain(r.url);
  expect(useMediaPaste.getState().requests[0]).toBe(r);
});
it("does not replace a changed URL or offer ordinary links and failed metadata checks", async () => {
  const inspect = vi.spyOn(ipc, "mediaUrlInfo").mockResolvedValue(null);
  pasteMediaUrl(editor, "https://example.com/page");
  await Promise.resolve();
  expect(useMediaPaste.getState().requests).toHaveLength(0);
  inspect.mockRejectedValue(new Error("Offline"));
  pasteMediaUrl(editor, thumbnail);
  await Promise.resolve();
  expect(useMediaPaste.getState().requests).toHaveLength(0);
  pasteMediaUrl(editor, "https://example.com/photo.png");
  const r = useMediaPaste.getState().requests[0];
  editor.commands.insertContentAt({ from: r.range.from, to: r.range.to }, "Changed");
  const download = vi.spyOn(ipc, "attachmentImportUrl");
  await expect(convertMediaPaste(r)).rejects.toThrow("changed");
  expect(download).not.toHaveBeenCalled();
  expect(editor.getText()).toContain("Changed");
});

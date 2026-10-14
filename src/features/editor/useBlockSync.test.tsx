// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../types";
import { BlockId } from "./extensions/blockId";
import { useBlockSync } from "./useBlockSync";
import { ipc } from "../../lib/ipc";
vi.mock("../../lib/access", () => ({ READ_ONLY: false }));
vi.mock("../../lib/ipc", () => ({ ipc: { blockList: vi.fn(), blockApplyBatch: vi.fn() }, toAppError: (error: Error) => ({ code: "unknown", message: error.message }) }));
let rows: Block[], root: Root, editors: Editor[];
const syncs = new Map<Editor, ReturnType<typeof useBlockSync>>();
function Sync({ editor }: { editor: Editor }) { const sync = useBlockSync(editor, "page"); syncs.set(editor, sync); return null; }
const block = (id: string, text: string, position: number): Block => ({ id, pageId: "page", parentBlockId: null, type: "paragraph", position, dataJson: JSON.stringify({ content: [{ type: "text", text }] }), schemaVersion: 2, revision: 1, createdAt: "", updatedAt: "" });
beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks(); syncs.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  rows = [block("a", "Alpha", 0), block("b", "Beta", 1)];
  vi.mocked(ipc.blockList).mockImplementation(async () => structuredClone(rows));
  vi.mocked(ipc.blockApplyBatch).mockImplementation(async input => {
    rows = rows.filter(row => !input.deleteIds.includes(row.id));
    for (const upsert of input.upserts) { const index = rows.findIndex(row => row.id === upsert.id); const next = { ...block(upsert.id, "", upsert.position), ...upsert }; if (index < 0) rows.push(next); else rows[index] = next; }
    return undefined;
  });
  editors = [0, 1].map(() => new Editor({ element: document.createElement("div"), extensions: [StarterKit, BlockId] }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<>{editors.map((editor, index) => <Sync key={index} editor={editor} />)}</>); });
  expect(editors.every(editor => editor.isEditable)).toBe(true);
});
afterEach(async () => { await act(async () => { root.unmount(); for (const editor of editors) editor.destroy(); }); vi.useRealTimers(); document.body.replaceChildren(); });
describe("multiple editors of one page", () => {
  it("undoes a first edit without undoing the loaded page", async () => {
    await act(async () => { editors[0].commands.setTextSelection(1); editors[0].commands.insertContent("Edited "); await vi.advanceTimersByTimeAsync(501); });
    await act(async () => { editors[0].commands.undo(); await vi.advanceTimersByTimeAsync(501); });
    expect(editors[0].getText()).toEqual("Alpha\n\nBeta");
    expect(editors[1].getText()).toEqual(editors[0].getText());
    expect(rows).toHaveLength(2);
  });
  it("autosaves to the real page rows and refreshes its clean peer without a save loop", async () => {
    await act(async () => { editors[0].commands.setTextSelection(1); editors[0].commands.insertContent("Edited "); await vi.advanceTimersByTimeAsync(501); });
    expect(editors[1].getText()).toContain("Edited Alpha");
    expect(ipc.blockApplyBatch).toHaveBeenCalledTimes(1);
    await act(async () => { editors[1].commands.setTextSelection(1); editors[1].commands.insertContent("Again "); await vi.advanceTimersByTimeAsync(501); });
    expect(editors[0].getText()).toContain("Again Edited Alpha");
    expect(ipc.blockApplyBatch).toHaveBeenCalledTimes(2);
  });
  it("does not replace unsaved peer text and merges separate block edits after saving", async () => {
    await act(async () => {
      editors[1].commands.setTextSelection(8); editors[1].commands.insertContent("LOCAL ");
      editors[0].commands.setTextSelection(1); editors[0].commands.insertContent("REMOTE ");
      await syncs.get(editors[0])!.retry();
    });
    expect(editors[1].getText()).toContain("LOCAL Beta");
    await act(async () => { await syncs.get(editors[1])!.retry(); });
    expect(editors[1].getText()).toContain("REMOTE Alpha");
    expect(editors[1].getText()).toContain("LOCAL Beta");
    expect(editors[0].getText()).toEqual(editors[1].getText());
    expect(ipc.blockApplyBatch).toHaveBeenCalledTimes(2);
  });
});

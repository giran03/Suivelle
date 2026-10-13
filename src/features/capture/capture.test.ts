import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, Workspace } from "../../types";

const ipc = vi.hoisted(() => ({
  pageGet: vi.fn(),
  pageCreate: vi.fn(),
  pageUpdate: vi.fn(),
  workspaceUpdateSettings: vi.fn(),
  blockList: vi.fn(),
  blockApplyBatch: vi.fn(),
}));
vi.mock("../../lib/ipc", async (original) => ({ ...(await original<typeof import("../../lib/ipc")>()), ipc }));

import { useActiveEditor } from "../../stores/activeEditor";
import { useWorkspace } from "../../stores/workspace";
import { appendToPage, capture, parseCapture, toEditorNodes } from "./capture";

const page = (id: string, extra: Partial<Page> = {}): Page => ({ id, workspaceId: "w1", title: id, kind: "page", deletedAt: null, ...extra }) as Page;
const workspace = (settings: object = {}): Workspace => ({ id: "w1", name: "W", settingsJson: JSON.stringify(settings) }) as Workspace;

describe("parseCapture", () => {
  it("makes one item per line and drops blanks", () => {
    expect(parseCapture("first\n\n  second  \r\nthird", false)).toEqual([
      { text: "first", todo: false },
      { text: "second", todo: false },
      { text: "third", todo: false },
    ]);
  });

  it("removes list markers and reads checkbox syntax", () => {
    expect(parseCapture("- one\n* two\n[ ] three\n- [ ] four\n[x] five", false)).toEqual([
      { text: "one", todo: false },
      { text: "two", todo: false },
      { text: "three", todo: true },
      { text: "four", todo: true },
      { text: "five", todo: true },
    ]);
  });

  it("makes everything a to-do when asked", () => {
    expect(parseCapture("a\nb", true).every((i) => i.todo)).toBe(true);
  });

  it("returns nothing for empty input or bare markers", () => {
    expect(parseCapture("", false)).toEqual([]);
    expect(parseCapture("  \n - \n [ ] ", false)).toEqual([]);
  });
});

describe("toEditorNodes", () => {
  it("groups neighbouring to-dos into one list and keeps order", () => {
    const nodes = toEditorNodes([
      { text: "note", todo: false },
      { text: "a", todo: true },
      { text: "b", todo: true },
      { text: "after", todo: false },
    ]);
    expect(nodes.map((n) => n.type)).toEqual(["paragraph", "taskList", "paragraph"]);
    expect(nodes[1].content).toHaveLength(2);
  });
});

describe("saving a capture", () => {
  beforeEach(() => {
    Object.values(ipc).forEach((f) => f.mockReset());
    useActiveEditor.setState({ editor: null });
    useWorkspace.setState({
      workspace: workspace({ inboxPageId: "inbox" }),
      workspaces: [workspace()],
      selectedPage: null,
      selectedPageId: null,
      view: "page",
      reloadTree: async () => undefined,
      notify: vi.fn(),
    });
    ipc.pageGet.mockResolvedValue(page("inbox"));
    ipc.blockList.mockResolvedValue([{ position: 4 }, { position: 9 }]);
    ipc.blockApplyBatch.mockResolvedValue(undefined);
  });

  it("writes new blocks after the last one, as paragraphs and to-dos", async () => {
    const done = await appendToPage(page("inbox"), [
      { text: "buy milk", todo: true },
      { text: "idea", todo: false },
    ]);
    const call = ipc.blockApplyBatch.mock.calls[0][0];
    expect(call.pageId).toBe("inbox");
    expect(call.upserts.map((r: { type: string; position: number }) => [r.type, r.position])).toEqual([
      ["todo", 10],
      ["paragraph", 11],
    ]);
    expect(JSON.parse(call.upserts[0].dataJson)).toMatchObject({ checked: false, content: [{ text: "buy milk" }] });
    await done.undo();
    expect(ipc.blockApplyBatch.mock.calls[1][0].deleteIds).toHaveLength(2);
  });

  it("goes to the Inbox, creating it when it is missing", async () => {
    useWorkspace.setState({ workspace: workspace() });
    ipc.pageCreate.mockResolvedValue(page("new-inbox"));
    ipc.pageUpdate.mockResolvedValue(page("new-inbox"));
    ipc.workspaceUpdateSettings.mockImplementation(async (_id: string, json: string) => ({ ...workspace(), settingsJson: json }));
    expect(await capture("remember this", { todo: false, target: "inbox" })).toBeNull();
    expect(ipc.pageCreate).toHaveBeenCalledWith("w1", null, "Inbox");
    expect(ipc.blockApplyBatch.mock.calls[0][0].pageId).toBe("new-inbox");
  });

  it("asks for text, and for an open page when sending there", async () => {
    expect(await capture("  \n ", { todo: false, target: "inbox" })).toBe("Type something to capture.");
    expect(await capture("x", { todo: false, target: "page" })).toMatch(/Open a page first/);
    expect(ipc.blockApplyBatch).not.toHaveBeenCalled();
  });

  it("reports a save failure instead of throwing", async () => {
    ipc.blockApplyBatch.mockRejectedValue({ code: "database", message: "disk full" });
    expect(await capture("x", { todo: false, target: "inbox" })).toBe("disk full");
  });
});

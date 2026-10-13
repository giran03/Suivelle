// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { usePageSelection } from "./pageSelection";
import { copyHierarchyPages, copyPages, pastePages, usePageClipboard } from "./pageClipboard";
import { registerFlusher } from "../editor/flushRegistry";
import type { Page, Workspace } from "../../types";

const workspace = (id: string) => ({ id, name: id } as Workspace);
const page = (id: string, workspaceId = "source", parentPageId: string | null = null) => ({ id, title: id, kind: "page", workspaceId, parentPageId } as Page);
const source = page("parent");
const child = page("child", "source", source.id);
const target = page("destination", "dest");
const reload = vi.fn(async () => {});
const select = vi.fn(async () => {});
const expand = vi.fn(async () => {});
const notify = vi.fn();
const error = vi.fn();
let stopFlush: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspace.setState({ workspace: workspace("source"), workspaces: [workspace("source"), workspace("dest")], children: { root: [source], parent: [child] }, expanded: {}, favorites: [], reloadTree: reload, selectPage: select, toggleExpanded: expand, notify, setError: error });
  usePageSelection.setState({ ids: [], anchor: null });
  usePageClipboard.setState({ held: null, pasting: false });
  vi.spyOn(ipc, "pageDuplicate").mockResolvedValue({ page: page("copy", "dest"), pages: 2, skipped: 0 });
});
afterEach(() => { stopFlush?.(); stopFlush = undefined; vi.restoreAllMocks(); usePageClipboard.setState({ held: null, pasting: false }); document.body.replaceChildren(); });

it("copies picked roots once and keeps them across a workspace switch for paste inside a page", async () => {
  usePageSelection.setState({ ids: [source.id, child.id], anchor: source.id });
  expect(copyHierarchyPages(child.id)).toBe(true);
  expect(usePageClipboard.getState().held?.pages).toEqual([source]);
  useWorkspace.setState({ workspace: workspace("dest"), children: { root: [target] } });
  expect(usePageSelection.getState().ids).toEqual([]);
  await pastePages(target);
  expect(ipc.pageDuplicate).toHaveBeenCalledExactlyOnceWith({ id: source.id, parentPageId: target.id, includeChildren: true, targetWorkspaceId: "dest" });
  expect(expand).toHaveBeenCalledWith(target.id);
  expect(select).toHaveBeenCalledWith("copy");
  expect(usePageClipboard.getState().held?.pages).toEqual([source]);
});

it("copies a focused row without a picked selection and pastes repeatedly into an empty workspace", async () => {
  expect(copyHierarchyPages(source.id)).toBe(true);
  useWorkspace.setState({ workspace: workspace("dest"), children: { root: [] } });
  await pastePages(null);
  await pastePages(null);
  expect(ipc.pageDuplicate).toHaveBeenCalledTimes(2);
  expect(ipc.pageDuplicate).toHaveBeenCalledWith({ id: source.id, parentPageId: null, includeChildren: true, targetWorkspaceId: "dest" });
  expect(usePageClipboard.getState().pasting).toBe(false);
});

it("preserves the clipboard and prevents copying stale content when editor saves fail", async () => {
  copyPages([source]);
  useWorkspace.setState({ workspace: workspace("dest") });
  stopFlush = registerFlusher(async () => { throw new Error("Unsaved changes"); });
  await pastePages(null);
  expect(ipc.pageDuplicate).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
  expect(usePageClipboard.getState().held?.pages).toEqual([source]);
  expect(usePageClipboard.getState().pasting).toBe(false);
});

it("prevents simultaneous pastes and never selects a destination copy after switching away", async () => {
  copyPages([source]);
  useWorkspace.setState({ workspace: workspace("dest") });
  let release!: (value: Awaited<ReturnType<typeof ipc.pageDuplicate>>) => void;
  vi.mocked(ipc.pageDuplicate).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = pastePages(null);
  await vi.waitFor(() => expect(ipc.pageDuplicate).toHaveBeenCalledTimes(1));
  await pastePages(null);
  expect(ipc.pageDuplicate).toHaveBeenCalledTimes(1);
  useWorkspace.setState({ workspace: workspace("source") });
  release({ page: page("copy", "dest"), pages: 1, skipped: 0 });
  await pending;
  expect(select).not.toHaveBeenCalled();
});

it("reports nested content the existing copier cannot transfer", async () => {
  copyPages([source]);
  useWorkspace.setState({ workspace: workspace("dest") });
  vi.mocked(ipc.pageDuplicate).mockResolvedValue({ page: page("copy", "dest"), pages: 1, skipped: 1 });
  await pastePages(null);
  expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("1 database or dashboard inside was not copied"));
});

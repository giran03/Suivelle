// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { usePreferences } from "../../stores/preferences";
import { registerFlusher, flushAllEditors } from "../editor/flushRegistry";
import { workspaceOptions } from "./model";
import type { Page, Workspace } from "../../types";

const original = useWorkspace.getInitialState();
const originalPreferences = usePreferences.getInitialState();
const a = { id: "a", name: "Personal", icon: null, settingsJson: "{}" } as Workspace;
const b = { id: "b", name: "Studio", icon: "symbol:code", settingsJson: '{"theme":"dark","accent":"blue","future":42}' } as Workspace;
const pa = { id: "pa", workspaceId: "a", title: "Personal page", kind: "page", deletedAt: null } as Page;
const pb = { id: "pb", workspaceId: "b", title: "Studio page", kind: "page", deletedAt: null } as Page;
let unregister: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear(); useWorkspace.setState(original, true); usePreferences.setState(originalPreferences, true);
  vi.spyOn(ipc, "workspaceList").mockResolvedValue([a, b]);
  vi.spyOn(ipc, "workspaceGet").mockImplementation(async (id) => id === "b" ? b : a);
  vi.spyOn(ipc, "pageListChildren").mockImplementation(async (id) => id === "b" ? [pb] : [pa]);
  vi.spyOn(ipc, "pageListFavorites").mockResolvedValue([]);
  vi.spyOn(ipc, "pageGet").mockImplementation(async (id) => id === "pb" ? pb : pa);
  vi.spyOn(ipc, "pageAncestors").mockResolvedValue([]);
  vi.spyOn(ipc, "historyCheckpoint").mockResolvedValue(undefined);
});
afterEach(() => { unregister?.(); unregister = undefined; usePreferences.setState(originalPreferences, true); vi.restoreAllMocks(); });

it("can retry a failed startup without creating a replacement workspace", async () => {
  vi.mocked(ipc.workspaceList).mockRejectedValueOnce(new Error("Workspace unavailable"));
  const create = vi.spyOn(ipc, "workspaceCreate");
  await useWorkspace.getState().init();
  expect(useWorkspace.getState().ready).toBe(false);
  expect(useWorkspace.getState().error).toContain("Workspace unavailable");
  useWorkspace.getState().clearError();
  await useWorkspace.getState().init();
  expect(useWorkspace.getState().ready).toBe(true);
  expect(useWorkspace.getState().workspace?.id).toBe("a");
  expect(create).not.toHaveBeenCalled();
});

it("adopts the current legacy theme once and persists it as an application preference", () => {
  usePreferences.setState({ theme: null });
  usePreferences.getState().adoptTheme("dark");
  usePreferences.getState().adoptTheme("light");
  expect(usePreferences.getState().theme).toBe("dark");
  expect(JSON.parse(localStorage.getItem("suivelle.preferences")!).theme).toBe("dark");
});

it("keeps the application theme when switching to a workspace with a different legacy mode", async () => {
  usePreferences.getState().setTheme("light");
  await useWorkspace.getState().init();
  await useWorkspace.getState().switchWorkspace("b");
  usePreferences.getState().adoptTheme(useWorkspace.getState().settings.theme);
  expect(usePreferences.getState().theme).toBe("light");
});

it("theme commands change application preferences without updating workspace metadata", async () => {
  await useWorkspace.getState().init();
  const update = vi.spyOn(ipc, "workspaceUpdateSettings");
  await useWorkspace.getState().setTheme("dark");
  expect(usePreferences.getState().theme).toBe("dark");
  expect(useWorkspace.getState().workspace?.settingsJson).toBe("{}");
  expect(update).not.toHaveBeenCalled();
});

it("switches atomically after saving, clears workspace caches and remembers the choice", async () => {
  await useWorkspace.getState().init();
  useWorkspace.setState({ expanded: { stale: true }, trash: [pa], pageTitles: { stale: { id: "stale", title: "old", icon: null, deleted: false } } });
  const save = vi.fn(async () => { expect(useWorkspace.getState().workspace?.id).toBe("a"); });
  unregister = registerFlusher(save);
  await useWorkspace.getState().switchWorkspace("b");
  expect(save).toHaveBeenCalled();
  const s = useWorkspace.getState();
  expect(s.workspace?.id).toBe("b"); expect(s.selectedPageId).toBe("pb"); expect(s.settings.theme).toBe("dark");
  expect(s.history.stack).toEqual(["pb"]); expect(s.expanded).toEqual({}); expect(s.trash).toEqual([]); expect(s.pageTitles).toEqual({});
  expect(localStorage.getItem("suivelle.workspace")).toBe("b"); expect(s.workspaceBusy).toBe(false);
});
it("stays in the current workspace when a pending save fails", async () => {
  await useWorkspace.getState().init(); unregister = registerFlusher(async () => { throw new Error("Disk is full"); });
  await expect(useWorkspace.getState().switchWorkspace("b")).rejects.toThrow("Disk is full");
  expect(useWorkspace.getState().workspace?.id).toBe("a"); expect(useWorkspace.getState().selectedPageId).toBe("pa"); expect(useWorkspace.getState().workspaceBusy).toBe(false);
});
it("uses the remembered workspace, falls back from removed choices, and restores its last page", async () => {
  localStorage.setItem("suivelle.workspace", "b"); localStorage.setItem("suivelle.page.b", "pb");
  await useWorkspace.getState().init(); expect(useWorkspace.getState().selectedPageId).toBe("pb");
  localStorage.setItem("suivelle.workspace", "gone"); await useWorkspace.getState().init(); expect(useWorkspace.getState().workspace?.id).toBe("a");
});
it("ignores delayed tree results from a previous workspace", async () => {
  await useWorkspace.getState().init();
  let resolve!: (pages: Page[]) => void;
  vi.mocked(ipc.pageListChildren).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  const old = useWorkspace.getState().loadChildren("old-parent");
  await useWorkspace.getState().switchWorkspace("b"); resolve([pa]); await old;
  expect(useWorkspace.getState().children["old-parent"]).toBeUndefined(); expect(useWorkspace.getState().children.root).toEqual([pb]);
});
it("merges profile settings without dropping unknown values and resets the icon explicitly", async () => {
  await useWorkspace.getState().init();
  const update = vi.spyOn(ipc, "workspaceUpdate").mockResolvedValue({ ...b, icon: null });
  await useWorkspace.getState().updateWorkspaceProfile("b", "Studio", null, { accent: "green", description: "Work" });
  expect(update).toHaveBeenCalledWith("b", "Studio", { icon: null, settingsJson: JSON.stringify({ theme: "dark", accent: "green", future: 42, description: "Work" }) });
  expect(useWorkspace.getState().workspace?.id).toBe("a");
});
it("creates a workspace and its profile in one backend call", async () => {
  await useWorkspace.getState().init(); const create = vi.spyOn(ipc, "workspaceCreate").mockResolvedValue(b);
  await useWorkspace.getState().createWorkspace("Studio", "symbol:code", { accent: "blue" });
  expect(create).toHaveBeenCalledWith("Studio", "symbol:code", '{"accent":"blue"}'); expect(useWorkspace.getState().workspace?.id).toBe("b");
});
it("does not switch or clear data when deletion or its safety copy fails", async () => {
  await useWorkspace.getState().init(); vi.spyOn(ipc, "workspaceDelete").mockRejectedValue(new Error("Backup write failed"));
  await expect(useWorkspace.getState().deleteWorkspace("a", "Personal")).rejects.toThrow("Backup write failed");
  expect(useWorkspace.getState().workspace?.id).toBe("a"); expect(useWorkspace.getState().workspaces).toHaveLength(2);
});
it("moves to a survivor after deleting the active workspace", async () => {
  await useWorkspace.getState().init(); vi.spyOn(ipc, "workspaceDelete").mockResolvedValue("safety.suibk"); vi.mocked(ipc.workspaceList).mockResolvedValue([b]);
  await useWorkspace.getState().deleteWorkspace("a", "Personal"); expect(useWorkspace.getState().workspace?.id).toBe("b"); expect(useWorkspace.getState().selectedPageId).toBe("pb"); expect(useWorkspace.getState().workspaces).toEqual([b]);
});
it("strict flush propagates failures while existing best-effort callers stay compatible", async () => {
  unregister = registerFlusher(async () => { throw new Error("pending"); });
  await expect(flushAllEditors()).resolves.toBeUndefined(); await expect(flushAllEditors(true)).rejects.toThrow("pending");
});
it("normalizes legacy workspace preferences without dropping raw settings", () => {
  expect(workspaceOptions({ settingsJson: "bad" }).accent).toBe("violet");
  expect(workspaceOptions({ settingsJson: '{"sidebarDensity":"compact","accent":"green","description":"Lab","extra":7}' })).toMatchObject({ sidebarDensity: "compact", accent: "green", description: "Lab", raw: { extra: 7 } });
  expect(workspaceOptions({ settingsJson: '{"sidebarDensity":"normal"}' }).sidebarDensity).toBe("normal");
});

it("persists workspace order across refresh and startup, appending newly discovered workspaces", async () => {
  await useWorkspace.getState().init();
  useWorkspace.getState().reorderWorkspace("b", "a");
  expect(useWorkspace.getState().workspaces.map((w) => w.id)).toEqual(["b", "a"]);
  expect(useWorkspace.getState().workspace?.id).toBe("a");
  vi.mocked(ipc.workspaceList).mockResolvedValue([a, b, { ...a, id: "c" }]);
  await useWorkspace.getState().refreshWorkspaces();
  expect(useWorkspace.getState().workspaces.map((w) => w.id)).toEqual(["b", "a", "c"]);
  useWorkspace.setState(original, true);
  await useWorkspace.getState().init();
  expect(useWorkspace.getState().workspaces.map((w) => w.id)).toEqual(["b", "a", "c"]);
});
it("creates an initial image through the atomic command and preserves the draft workspace on failure", async () => {
  await useWorkspace.getState().init();
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const image = { name: "icon.gif", arrayBuffer: async () => bytes } as File;
  const create = vi.spyOn(ipc, "workspaceCreateWithImage").mockRejectedValueOnce(new Error("Disk full")).mockResolvedValueOnce(b);
  const plainCreate = vi.spyOn(ipc, "workspaceCreate");
  await expect(useWorkspace.getState().createWorkspace("Studio", null, { accent: "blue" }, image)).rejects.toThrow("Disk full");
  expect(useWorkspace.getState().workspace?.id).toBe("a");
  expect(useWorkspace.getState().workspaces).toEqual([a, b]);
  await useWorkspace.getState().createWorkspace("Studio", null, { accent: "blue" }, image);
  expect(create).toHaveBeenLastCalledWith("Studio", '{"accent":"blue"}', "icon.gif", bytes);
  expect(plainCreate).not.toHaveBeenCalled();
});

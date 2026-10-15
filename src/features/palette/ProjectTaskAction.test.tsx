// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseDetail, Page, RecordRow, Workspace } from "../../types";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { usePalette } from "./store";
import { ProjectTaskAction } from "./ProjectTaskAction";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const workspace = { id: "w", settingsJson: '{"projectTaskRelationIds":["project-relation"]}' } as Workspace;
const projects = { database: { id: "projects" }, page: { id: "projects-page", title: "Projects" }, properties: [] } as unknown as DatabaseDetail;
const tasks = { database: { id: "tasks" }, page: { id: "tasks-page", title: "Tasks" }, properties: [{ id: "project-relation", name: "Initiative", type: "relation", config: { targetDatabaseId: "projects" } }] } as unknown as DatabaseDetail;
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 130)); }); };
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  useWorkspace.setState({ workspace, reloadTree: async () => {}, notify: vi.fn() });
  usePalette.setState({ open: true, task: true, busy: false });
  vi.spyOn(ipc, "workspaceGet").mockResolvedValue(workspace);
  vi.spyOn(ipc, "databaseList").mockResolvedValue([{ id: "tasks", pageId: "tasks-page", title: "Tasks" }, { id: "projects", pageId: "projects-page", title: "Projects" }]);
  vi.spyOn(ipc, "databaseGet").mockImplementation(async id => id === "tasks-page" ? tasks : projects);
  vi.spyOn(ipc, "pageAncestors").mockResolvedValue([{ title: "Work" } as Page]);
  vi.spyOn(ipc, "recordLookup").mockResolvedValue([{ id: "project-id", pageId: "project-page", title: "Website" }]);
  vi.spyOn(ipc, "recordTemplateList").mockResolvedValue([{ id: "default-template", databaseId: "tasks", name: "Default task", title: "", values: {}, blockCount: 0, isDefault: true }]);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); usePalette.setState({ busy: false }); });

it("creates in the mapped database with project/template IDs, prevents duplicates and retains drafts on failure", async () => {
  await act(async () => root.render(<ProjectTaskAction />)); await settle(); await settle();
  expect(host.querySelector('[role="option"]')?.textContent).toContain("Website");
  await act(async () => { (host.querySelector('[role="option"]') as HTMLElement).click(); }); await settle();
  const title = host.querySelector("form input") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Write tests");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  let reject: (error: Error) => void = () => {};
  const create = vi.spyOn(ipc, "recordCreate").mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith({ databaseId: "tasks", title: "Write tests", templateId: "default-template", values: { "project-relation": ["project-id"] } });
  expect(usePalette.getState().busy).toBe(true);
  await act(async () => { reject(new Error("Could not save")); });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
  expect(title.value).toBe("Write tests");
  create.mockResolvedValue({ id: "task-id", pageId: "task-page", title: "Write tests" } as RecordRow);
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Write tests");
  expect(host.textContent).toContain("Open task");
  expect(usePalette.getState().busy).toBe(false);
});

it("asks for an explicit relation mapping when none is saved and cancels on workspace changes", async () => {
  vi.mocked(ipc.workspaceGet).mockResolvedValue({ ...workspace, settingsJson: "{}" });
  await act(async () => root.render(<ProjectTaskAction />)); await settle();
  expect(host.textContent).toContain("Choose task database → project relation");
  expect(ipc.recordLookup).not.toHaveBeenCalled();
  await act(async () => { useWorkspace.setState({ workspace: { ...workspace, id: "other" } }); });
  expect(usePalette.getState().open).toBe(false);
});

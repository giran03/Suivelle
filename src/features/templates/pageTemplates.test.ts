import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, Workspace } from "../../types";

const ipc = vi.hoisted(() => ({
  pageGet: vi.fn(),
  pageCreate: vi.fn(),
  pageUpdate: vi.fn(),
  pageListChildren: vi.fn(),
  pageDuplicate: vi.fn(),
  workspaceUpdateSettings: vi.fn(),
}));

vi.mock("../../lib/ipc", async (original) => ({ ...(await original<typeof import("../../lib/ipc")>()), ipc }));

import { useWorkspace } from "../../stores/workspace";
import { createFromPageTemplate, listPageTemplates, saveAsTemplate, templatesContainer } from "./pageTemplates";

const page = (id: string, extra: Partial<Page> = {}): Page => ({ id, workspaceId: "w1", title: id, kind: "page", deletedAt: null, ...extra }) as Page;
const workspace = (settings: object = {}): Workspace => ({ id: "w1", name: "W", settingsJson: JSON.stringify(settings) }) as Workspace;

beforeEach(() => {
  Object.values(ipc).forEach((f) => f.mockReset());
  useWorkspace.setState({
    workspace: workspace(),
    workspaces: [workspace()],
    reloadTree: async () => undefined,
    selectPage: async () => undefined,
    notify: () => undefined,
    setError: vi.fn(),
  });
});

describe("the templates page", () => {
  it("does not exist until something is saved as a template", async () => {
    expect(await templatesContainer(false)).toBeNull();
    expect(ipc.pageCreate).not.toHaveBeenCalled();
  });

  it("is created once, given an icon, and remembered in the workspace settings", async () => {
    ipc.pageCreate.mockResolvedValue(page("t1", { title: "Templates" }));
    ipc.pageUpdate.mockResolvedValue(page("t1", { title: "Templates", icon: "icon:layers" }));
    ipc.workspaceUpdateSettings.mockImplementation(async (_id: string, json: string) => ({ ...workspace(), settingsJson: json }));
    const made = await templatesContainer(true);
    expect(made?.id).toBe("t1");
    expect(ipc.pageUpdate).toHaveBeenCalledWith({ id: "t1", icon: "icon:layers" });
    expect(JSON.parse(ipc.workspaceUpdateSettings.mock.calls[0][1])).toMatchObject({ templatesPageId: "t1" });
    expect(JSON.parse(useWorkspace.getState().workspace!.settingsJson).templatesPageId).toBe("t1");
  });

  it("keeps the other settings when it records itself", async () => {
    useWorkspace.setState({ workspace: workspace({ theme: "dark", accent: "blue" }) });
    ipc.pageCreate.mockResolvedValue(page("t1"));
    ipc.pageUpdate.mockResolvedValue(page("t1"));
    ipc.workspaceUpdateSettings.mockImplementation(async (_id: string, json: string) => ({ ...workspace(), settingsJson: json }));
    await templatesContainer(true);
    expect(JSON.parse(ipc.workspaceUpdateSettings.mock.calls[0][1])).toEqual({ theme: "dark", accent: "blue", templatesPageId: "t1" });
  });

  it("is reused when it still exists", async () => {
    useWorkspace.setState({ workspace: workspace({ templatesPageId: "t1" }) });
    ipc.pageGet.mockResolvedValue(page("t1"));
    expect((await templatesContainer(true))?.id).toBe("t1");
    expect(ipc.pageCreate).not.toHaveBeenCalled();
  });

  it("is replaced when it was trashed or deleted", async () => {
    useWorkspace.setState({ workspace: workspace({ templatesPageId: "gone" }) });
    ipc.pageGet.mockResolvedValue(page("gone", { deletedAt: "2026-01-01" }));
    ipc.pageCreate.mockResolvedValue(page("t2"));
    ipc.pageUpdate.mockResolvedValue(page("t2"));
    ipc.workspaceUpdateSettings.mockImplementation(async (_id: string, json: string) => ({ ...workspace(), settingsJson: json }));
    expect((await templatesContainer(true))?.id).toBe("t2");
    ipc.pageGet.mockRejectedValue(new Error("not found"));
    useWorkspace.setState({ workspace: workspace({ templatesPageId: "gone" }) });
    expect(await templatesContainer(false)).toBeNull();
  });
});

describe("using templates", () => {
  it("lists only ordinary pages inside the templates page", async () => {
    useWorkspace.setState({ workspace: workspace({ templatesPageId: "t1" }) });
    ipc.pageGet.mockResolvedValue(page("t1"));
    ipc.pageListChildren.mockResolvedValue([page("a"), page("db", { kind: "database" })]);
    expect((await listPageTemplates()).map((p) => p.id)).toEqual(["a"]);
    expect(ipc.pageListChildren).toHaveBeenCalledWith("w1", "t1");
  });

  it("saves a copy into the templates page without touching the original", async () => {
    useWorkspace.setState({ workspace: workspace({ templatesPageId: "t1" }) });
    ipc.pageGet.mockResolvedValue(page("t1"));
    ipc.pageDuplicate.mockResolvedValue({ page: page("copy"), pages: 1, skipped: 0 });
    await saveAsTemplate(page("src"));
    expect(ipc.pageDuplicate).toHaveBeenCalledWith({ id: "src", parentPageId: "t1", includeChildren: true });
  });

  it("will not save the templates page as a template of itself", async () => {
    useWorkspace.setState({ workspace: workspace({ templatesPageId: "t1" }) });
    ipc.pageGet.mockResolvedValue(page("t1"));
    await saveAsTemplate(page("t1"));
    expect(ipc.pageDuplicate).not.toHaveBeenCalled();
  });

  it("makes a new page from a template and reports a failure instead of throwing", async () => {
    ipc.pageDuplicate.mockResolvedValueOnce({ page: page("new"), pages: 2, skipped: 0 });
    expect(await createFromPageTemplate("tpl")).toBeNull();
    expect(ipc.pageDuplicate).toHaveBeenCalledWith({ id: "tpl", parentPageId: null, includeChildren: true });
    ipc.pageDuplicate.mockRejectedValueOnce({ code: "not_found", message: "That template no longer exists." });
    expect(await createFromPageTemplate("tpl")).toBe("That template no longer exists.");
  });
});

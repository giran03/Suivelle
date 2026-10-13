import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, Workspace } from "../../types";

const ipc = vi.hoisted(() => ({ pageGet: vi.fn(), pageCreate: vi.fn(), pageListChildren: vi.fn() }));
vi.mock("../../lib/ipc", async (original) => ({ ...(await original<typeof import("../../lib/ipc")>()), ipc }));

import { useWorkspace } from "../../stores/workspace";
import { dailyTitle, openDailyNote } from "./journal";

const page = (id: string, extra: Partial<Page> = {}): Page => ({ id, workspaceId: "w1", title: id, kind: "page", deletedAt: null, ...extra }) as Page;
const store = new Map<string, string>();
const day = new Date(2026, 9, 13, 23, 30);

describe("daily notes", () => {
  const selectPage = vi.fn(), reloadTree = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    store.clear();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    useWorkspace.setState({ workspace: { id: "w1" } as Workspace, expanded: {}, selectPage, reloadTree });
  });

  it("titles notes by local date so they sort in order", () => {
    expect(dailyTitle(day)).toBe("2026-10-13");
    expect(dailyTitle(new Date(2027, 0, 2))).toBe("2027-01-02");
  });

  it("creates the Journal page and today's note the first time, then reopens them", async () => {
    ipc.pageListChildren.mockResolvedValueOnce([page("p1", { title: "Ideas" })]).mockResolvedValueOnce([]);
    ipc.pageCreate.mockResolvedValueOnce(page("j", { title: "Journal" })).mockResolvedValueOnce(page("n1", { title: "2026-10-13" }));
    await openDailyNote(day);
    expect(ipc.pageCreate).toHaveBeenNthCalledWith(1, "w1", null, "Journal");
    expect(ipc.pageCreate).toHaveBeenNthCalledWith(2, "w1", "j", "2026-10-13");
    expect(selectPage).toHaveBeenLastCalledWith("n1");
    expect(useWorkspace.getState().expanded.j).toBe(true);

    ipc.pageGet.mockResolvedValueOnce(page("j", { title: "Journal" }));
    ipc.pageListChildren.mockResolvedValueOnce([page("n1", { title: "2026-10-13" })]);
    await openDailyNote(day);
    expect(ipc.pageCreate).toHaveBeenCalledTimes(2);
    expect(selectPage).toHaveBeenLastCalledWith("n1");
  });

  it("does not reuse a trashed Journal or note", async () => {
    store.set("suivelle.journal.w1", "old");
    ipc.pageGet.mockResolvedValueOnce(page("old", { title: "Journal", deletedAt: "2026-10-01" }));
    ipc.pageListChildren.mockResolvedValueOnce([page("j2", { title: "Journal" })]).mockResolvedValueOnce([page("gone", { title: "2026-10-13", deletedAt: "x" })]);
    ipc.pageCreate.mockResolvedValueOnce(page("n2", { title: "2026-10-13" }));
    await openDailyNote(day);
    expect(ipc.pageCreate).toHaveBeenCalledWith("w1", "j2", "2026-10-13");
    expect(store.get("suivelle.journal.w1")).toBe("j2");
  });
});

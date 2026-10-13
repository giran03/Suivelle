import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ pageGet: vi.fn() }));
vi.mock("../../lib/ipc", async (original) => ({ ...(await original<typeof import("../../lib/ipc")>()), ipc }));
import { useWorkspace } from "../../stores/workspace";
import type { Workspace } from "../../types";
import { closeTab, cycleTab, dropTab, installTabs, moveTab, openInNewTab, reopenClosedTab, useTabs } from "./tabs";

const workspace = { id: "w1", name: "W" } as Workspace;
let uninstall: () => void;

/** Navigation without a backend: selecting a page just records it, like the real store does. */
function stubNavigation() {
  useWorkspace.setState({
    workspace,
    selectedPageId: "A",
    selectPage: async (id: string | null) => {
      useWorkspace.setState({ selectedPageId: id });
    },
    setError: () => undefined,
  });
}

const select = (id: string) => useWorkspace.setState({ selectedPageId: id });
const ids = () => useTabs.getState().ids;
const open = () => useWorkspace.getState().selectedPageId;

beforeEach(() => {
  useTabs.setState({ ids: [] });
  uninstall = installTabs();
  stubNavigation();
  useTabs.setState({ ids: [] });
});

afterEach(() => uninstall());

describe("page tabs", () => {
  it("stay hidden until a second page is opened in a new tab", async () => {
    expect(ids()).toEqual([]);
    await openInNewTab("B");
    expect(ids()).toEqual(["A", "B"]);
    expect(open()).toBe("B");
  });

  it("put a new tab right after the open one", async () => {
    await openInNewTab("B");
    await openInNewTab("C");
    select("A");
    await openInNewTab("D");
    expect(ids()).toEqual(["A", "D", "B", "C"]);
  });

  it("switch to a page that already has a tab instead of duplicating it", async () => {
    await openInNewTab("B");
    await openInNewTab("A");
    expect(ids()).toEqual(["A", "B"]);
    expect(open()).toBe("A");
  });

  it("change what the open tab shows when you navigate normally", async () => {
    await openInNewTab("B");
    select("C");
    expect(ids()).toEqual(["A", "C"]);
    select("A");
    expect(ids()).toEqual(["A", "C"]);
  });

  it("close to the neighbour, and leave tab mode when one is left", async () => {
    await openInNewTab("B");
    await openInNewTab("C");
    await closeTab("C");
    expect(ids()).toEqual(["A", "B"]);
    expect(open()).toBe("B");
    await closeTab("B");
    expect(ids()).toEqual([]);
    expect(open()).toBe("A");
  });

  it("closing a tab you are not on keeps you where you are", async () => {
    await openInNewTab("B");
    await openInNewTab("C");
    await closeTab("A");
    expect(open()).toBe("C");
    expect(ids()).toEqual(["B", "C"]);
  });

  it("cycle with wrap-around", async () => {
    await openInNewTab("B");
    await openInNewTab("C");
    await cycleTab(1);
    expect(open()).toBe("A");
    await cycleTab(-1);
    expect(open()).toBe("C");
  });

  it("never drop the tab you are on", async () => {
    await openInNewTab("B");
    dropTab("B");
    expect(ids()).toEqual(["A", "B"]);
    dropTab("A");
    expect(ids()).toEqual([]);
  });

  it("are forgotten when the workspace changes", async () => {
    await openInNewTab("B");
    useWorkspace.setState({ workspace: { id: "w2", name: "Other" } as Workspace });
    expect(ids()).toEqual([]);
  });
});

describe("moving tabs", () => {
  it("reorders without changing the open page", async () => {
    await openInNewTab("B");
    await openInNewTab("C");
    moveTab("A", 2);
    expect(ids()).toEqual(["B", "C", "A"]);
    expect(open()).toBe("C");
    moveTab("A", 0);
    expect(ids()).toEqual(["A", "B", "C"]);
  });

  it("clamps to the ends and ignores unknown tabs", async () => {
    await openInNewTab("B");
    moveTab("A", 99);
    expect(ids()).toEqual(["B", "A"]);
    moveTab("A", -5);
    expect(ids()).toEqual(["A", "B"]);
    moveTab("nope", 0);
    expect(ids()).toEqual(["A", "B"]);
  });
});

describe("reopening closed tabs", () => {
  it("brings back the most recent closed tab whose page still exists", async () => {
    await openInNewTab("B");
    await openInNewTab("C");
    await closeTab("B");
    await closeTab("C");
    ipc.pageGet.mockImplementation(async (id: string) => ({ id, deletedAt: id === "C" ? "trashed" : null }));
    expect(await reopenClosedTab()).toBe(true);
    expect(ids()).toContain("B");
    expect(open()).toBe("B");
    expect(await reopenClosedTab()).toBe(false);
  });
});

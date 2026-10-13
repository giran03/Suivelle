// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Page, Workspace } from "../../types";
import { PagesToolbar } from "./PagesToolbar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const original = useWorkspace.getInitialState();
const ws = { id: "workspace" } as Workspace;
const page = (id: string, parentPageId: string | null = null, childCount = 0, kind: Page["kind"] = "page") => ({ id, parentPageId, childCount, kind, workspaceId: ws.id, title: id } as Page);
const a = page("a", null, 1), b = page("b", "a", 1), c = page("c", "b");
let root: Root | undefined;

beforeEach(() => {
  useWorkspace.getState().collapseAllPages();
  useWorkspace.setState({ ...original, workspace: ws, children: { root: [a, page("leaf")] } }, true);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  document.body.replaceChildren(); vi.restoreAllMocks();
});
async function mount() {
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host); await act(async () => root!.render(<PagesToolbar />));
  return host;
}
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const select = async (label: string) => act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === label)!.click());

it("expands unloaded descendants and refreshes cached branches, without querying leaves", async () => {
  useWorkspace.setState({ children: { root: [a, page("leaf")], a: [b] } });
  const list = vi.spyOn(ipc, "pageListChildren").mockImplementation(async (_, id) => id === "a" ? [b] : [c]);
  await useWorkspace.getState().expandAllPages();
  expect(list.mock.calls).toEqual([[ws.id, "a"], [ws.id, "b"]]);
  expect(useWorkspace.getState().expanded).toEqual({ a: true, b: true });
  expect(useWorkspace.getState().children.b).toEqual([c]);
  expect(useWorkspace.getState().treeExpanding).toBe(false);
});

it("collapse all cancels pending expansion without reopening any branches", async () => {
  let resolve!: (value: Page[]) => void;
  vi.spyOn(ipc, "pageListChildren").mockImplementation(() => new Promise((r) => { resolve = r; }));
  const pending = useWorkspace.getState().expandAllPages();
  expect(useWorkspace.getState().treeExpanding).toBe(true);
  useWorkspace.getState().collapseAllPages(); resolve([b]); await pending;
  expect(useWorkspace.getState().expanded).toEqual({});
  expect(useWorkspace.getState().children.a).toBeUndefined();
  expect(useWorkspace.getState().treeExpanding).toBe(false);
});

it("ignores expansion results after switching workspaces", async () => {
  let resolve!: (value: Page[]) => void;
  vi.spyOn(ipc, "pageListChildren").mockImplementation(() => new Promise((r) => { resolve = r; }));
  const pending = useWorkspace.getState().expandAllPages();
  useWorkspace.setState({ workspace: { id: "other" } as Workspace, children: {}, expanded: {}, treeExpanding: false });
  resolve([b]); await pending;
  expect(useWorkspace.getState().children).toEqual({}); expect(useWorkspace.getState().expanded).toEqual({});
});

it("reports loading failures and makes expansion retryable", async () => {
  const list = vi.spyOn(ipc, "pageListChildren").mockRejectedValueOnce({ code: "database", message: "Unable to read pages" }).mockResolvedValue([]);
  await useWorkspace.getState().expandAllPages();
  expect(useWorkspace.getState().error).toBe("Unable to read pages");
  expect(useWorkspace.getState().treeExpanding).toBe(false);
  await useWorkspace.getState().expandAllPages(); expect(list).toHaveBeenCalledTimes(2);
});

it("reveals the selected page after collapse without navigating or changing its history", async () => {
  useWorkspace.setState({ selectedPage: c, selectedPageId: c.id, ancestors: [a, b] });
  vi.spyOn(ipc, "pageListChildren").mockImplementation(async (_, id) => id === "a" ? [b] : [c]);
  const history = useWorkspace.getState().history;
  expect(await useWorkspace.getState().revealCurrentPage()).toBe("c");
  expect(useWorkspace.getState().expanded).toEqual({ a: true, b: true });
  expect(useWorkspace.getState().selectedPageId).toBe("c");
  expect(useWorkspace.getState().history).toBe(history);
});

it("reveals a record's database, since database records are not sidebar rows", async () => {
  const database = page("db", "a", 0, "database"), record = page("record", "db", 0, "record");
  useWorkspace.setState({ selectedPage: record, selectedPageId: record.id, ancestors: [a, database] });
  const list = vi.spyOn(ipc, "pageListChildren").mockResolvedValue([database]);
  expect(await useWorkspace.getState().revealCurrentPage()).toBe("db");
  expect(list.mock.calls).toEqual([[ws.id, "a"]]);
  expect(useWorkspace.getState().expanded).toEqual({ a: true });
});

it("keeps New page one click away and exposes every existing creation action", async () => {
  const create = vi.spyOn(useWorkspace.getState(), "createPage").mockResolvedValue(undefined);
  const database = vi.spyOn(useWorkspace.getState(), "createDatabase").mockResolvedValue(undefined);
  await mount();
  await act(async () => button("New page").click()); expect(create).toHaveBeenCalledWith(null);
  const trigger = button("More ways to create"); trigger.focus();
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect([...document.querySelectorAll('[role="menuitem"]')].map((el) => el.getAttribute("aria-label"))).toEqual(["New page", "New database", "New dashboard", "New from template…"]);
  await select("New database"); expect(database).toHaveBeenCalledWith(null);
  expect(document.activeElement).toBe(trigger);
});

it("disables inapplicable tree controls and offers refresh with existing menu keyboard navigation", async () => {
  useWorkspace.setState({ children: { root: [] } });
  const reload = vi.spyOn(useWorkspace.getState(), "reloadTree").mockResolvedValue(undefined);
  await mount();
  expect(button("Expand all pages").disabled).toBe(true); expect(button("Collapse all pages").disabled).toBe(true);
  const trigger = button("Page tree options"); trigger.focus(); await act(async () => trigger.click());
  expect(document.activeElement?.textContent).toBe("Refresh pages");
  expect([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Show current page in tree")?.disabled).toBe(true);
  await select("Refresh pages"); expect(reload).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(trigger);
});

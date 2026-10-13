// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";
import { CalendarView } from "../features/database/CalendarView";
import { Grid } from "../features/database/Grid";
import { ipc } from "../lib/ipc";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function mount(node: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host); await act(async () => root!.render(node)); return host;
}

it("restores context menu focus on Escape", async () => {
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const host = await mount(<ContextMenu x={0} y={0} onClose={() => root!.render(null)} items={[{ label: "Open", onSelect: () => {} }]} />);
  expect(document.activeElement).toBe(host.querySelector("button"));
  await act(async () => host.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.activeElement).toBe(opener);
});

it("allows a menu action to hand focus to a new surface", async () => {
  const opener = document.createElement("button"); const destination = document.createElement("button");
  document.body.append(opener, destination); opener.focus();
  const host = await mount(<ContextMenu x={0} y={0} onClose={() => root!.render(null)} items={[{ label: "Open", onSelect: () => destination.focus() }]} />);
  await act(async () => host.querySelector("button")!.click());
  expect(document.activeElement).toBe(destination);
});

it("calendar owns seven cells per week and exposes full date labels", async () => {
  vi.spyOn(ipc, "queryRecords").mockResolvedValue({ rows: [], total: null, nextCursor: null });
  const prop = { id: "date", type: "date", name: "Date" };
  const props = { db: { detail: { database: { id: "db" } }, byId: new Map([["date", prop]]) }, view: { id: "view", config: { datePropertyId: "date" } }, queryVersion: 0 } as unknown as ComponentProps<typeof CalendarView>;
  const host = await mount(<CalendarView {...props} />);
  const weeks = host.querySelectorAll('[role="rowgroup"] > [role="row"]');
  expect(weeks).toHaveLength(6);
  weeks.forEach((week) => {
    expect(week.querySelectorAll(':scope > [role="cell"]')).toHaveLength(7);
    week.querySelectorAll('[role="cell"]').forEach((cell) => expect(cell.getAttribute("aria-label")!.length).toBeGreaterThan(10));
  });
});

it("column separators support keyboard increments and limits", async () => {
  const patchColumn = vi.fn();
  const props = { columns: [{ property: { id: "title", type: "title", name: "Title" }, column: { width: 100 } }], view: { sorts: [], filter: null }, db: { patchColumn }, table: { rowCount: 0, loaded: false, loadedRows: () => [] }, focusRequest: null, onCreate: vi.fn(), onAddProperty: vi.fn(), onToggleGroup: vi.fn() } as unknown as ComponentProps<typeof Grid>;
  const host = await mount(<Grid {...props} />);
  const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
  expect(handle.tabIndex).toBe(0);
  handle.focus();
  for (const [key, width] of [["ArrowRight", 110], ["Home", 60], ["End", 800]] as const) {
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    expect(patchColumn).toHaveBeenLastCalledWith("title", { width });
  }
});

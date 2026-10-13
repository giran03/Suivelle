// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";
import { AppContextMenu } from "./AppContextMenu";
import { useShortcuts } from "../features/shortcuts/store";
import { key, mouse } from "../features/shortcuts/bindings";
import { installInputRouter } from "../features/shortcuts/runtime";
import { editingItems } from "./editingMenu";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); useShortcuts.setState({ overrides: {}, recording: false }); vi.restoreAllMocks(); });
async function mount(node: React.ReactNode) { const host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); return host; }
function context(el: Element) { const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); el.dispatchEvent(event); return event; }

it("suppresses the browser menu on blank surfaces without adding irrelevant actions", async () => {
  const host = await mount(<AppContextMenu />);
  let event!: MouseEvent; await act(async () => { event = context(host); });
  expect(event.defaultPrevented).toBe(true); expect(document.querySelector('[role="menu"]')).toBeNull();
});
it("keeps field editing ahead of parent record actions and preserves captured selection", async () => {
  const parentAction = vi.fn();
  const host = await mount(<><div onContextMenu={parentAction}><input defaultValue="hello world" /></div><AppContextMenu /></>);
  const input = host.querySelector("input")!; input.focus(); input.setSelectionRange(0, 5);
  await act(async () => { context(input); });
  expect(parentAction).not.toHaveBeenCalled();
  const command = vi.fn(() => { expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(5); return true; });
  Object.defineProperty(document, "execCommand", { configurable: true, value: command });
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.getAttribute("aria-label") === "Copy")!.click());
  expect(command).toHaveBeenCalledWith("copy");
});
it("mounts text menus inside the active modal subtree", async () => {
  const host = await mount(<><dialog open><textarea defaultValue="notes" /></dialog><AppContextMenu /></>);
  await act(async () => { context(host.querySelector("textarea")!); });
  expect(host.querySelector('dialog [role="menu"]')).not.toBeNull();
});
it("does not offer copy or cut for passwords, or mutations for readonly fields", () => {
  const password = document.createElement("input"); password.type = "password"; password.value = "secret";
  expect(editingItems(password).map((i) => i.label)).not.toContain("Copy");
  expect(editingItems(password).map((i) => i.label)).not.toContain("Cut");
  const readonly = document.createElement("textarea"); readonly.readOnly = true;
  expect(editingItems(readonly).map((i) => i.label)).toEqual(["Copy", "Select all"]);
});
it("supports Home, End, wraparound and character navigation while skipping disabled items", async () => {
  const host = await mount(<ContextMenu x={10} y={10} onClose={() => {}} items={[{ label: "Open", onSelect: () => {} }, { label: "Disabled", disabled: true, onSelect: () => {} }, { label: "Copy", onSelect: () => {} }, { label: "Trash", onSelect: () => {} }]} />);
  for (const [key, label] of [["End", "Trash"], ["ArrowDown", "Open"], ["ArrowUp", "Trash"], ["Home", "Open"], ["c", "Copy"]]) {
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    expect(document.activeElement?.textContent).toBe(label);
  }
  expect(host.querySelector('button')?.getAttribute("tabindex")).toBe("-1");
  const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  await act(async () => document.activeElement!.dispatchEvent(space));
  expect(space.defaultPrevented).toBe(false); // Preserve the button's native Space activation.
});
it("opening another menu closes the previous owner", async () => {
  function Pair() { const [first, setFirst] = useState(true); const [second, setSecond] = useState(false); return <>{first && <ContextMenu x={0} y={0} items={[{ label: "First", onSelect: () => {} }]} onClose={() => setFirst(false)} />}<button id="second" onClick={() => setSecond(true)}>Second</button>{second && <ContextMenu x={10} y={10} items={[{ label: "Second action", onSelect: () => {} }]} onClose={() => setSecond(false)} />}</>; }
  const host = await mount(<Pair />); await act(async () => host.querySelector<HTMLButtonElement>("#second")!.click());
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1); expect(document.querySelector('[role="menuitem"]')?.textContent).toBe("Second action");
});

it("offers value copying for date/number fields without unsupported selection actions", () => {
  const field = document.createElement("input"); field.type = "date"; field.value = "2026-10-07";
  const items = editingItems(field);
  expect(items.find((i) => i.label === "Copy value")?.disabled).toBe(false);
  expect(items.find((i) => i.label === "Cut")?.disabled).toBe(true);
  expect(items.find((i) => i.label === "Paste text")?.disabled).toBe(true);
  expect(items.find((i) => i.label === "Select all")?.disabled).toBe(true);
});

it("shows live keycaps and runs the captured item rather than a workspace action", async () => {
  const clicked = vi.fn(), unrelated = vi.fn(), close = vi.fn();
  const stop = installInputRouter({ search: unrelated }, () => true);
  try {
    const host = await mount(<ContextMenu x={0} y={0} onClose={close} items={[{ label: "Copy this page", shortcut: "page-copy", onSelect: clicked }, { label: "Copy link", onSelect: unrelated }]} />);
    expect([...host.querySelectorAll("kbd")].map(el => el.textContent)).toEqual(["Ctrl", "C"]);
    expect(host.querySelector('[aria-label="Copy link"] kbd')).toBeNull();
    await act(async () => useShortcuts.setState({ overrides: { "page-copy": [key("k", "Control")] } }));
    expect([...host.querySelectorAll("kbd")].map(el => el.textContent)).toEqual(["Ctrl", "K"]);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(clicked).toHaveBeenCalledTimes(1); expect(unrelated).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
    await act(async () => useShortcuts.setState({ overrides: { "page-copy": [] } }));
    expect(host.querySelector("kbd")).toBeNull();
  } finally { stop(); }
});

it("preserves literal plus keys, mouse hints and disabled action safety", async () => {
  const disabled = vi.fn(), clicked = vi.fn();
  const host = await mount(<ContextMenu x={0} y={0} onClose={() => {}} items={[{ label: "Disabled", shortcut: [key("+", "Control")], disabled: true, onSelect: disabled }, { label: "Mouse action", shortcut: [mouse(3, "Control")], onSelect: clicked }]} />);
  expect([...host.querySelector('[aria-label="Disabled"]')!.querySelectorAll("kbd")].map(el => el.textContent)).toEqual(["Ctrl", "+"]);
  expect(host.querySelector('[aria-label="Mouse action"]')?.textContent).toContain("Mouse Back");
  await act(async () => host.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "+", ctrlKey: true, bubbles: true, cancelable: true })));
  expect(disabled).not.toHaveBeenCalled();
  await act(async () => host.querySelector('[role="menu"]')!.dispatchEvent(new MouseEvent("mousedown", { button: 3, ctrlKey: true, bubbles: true, cancelable: true })));
  expect(clicked).toHaveBeenCalledTimes(1);
});

it("bounds menus in CSS zoom mode without scaling viewport coordinates twice", async () => {
  document.documentElement.style.zoom = "1.5";
  const viewport = vi.spyOn(window, "innerWidth", "get").mockReturnValue(320);
  const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(180);
  const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
  try {
    const host = await mount(<ContextMenu x={300} y={100} items={[{ label: "Open", onSelect: () => {} }]} onClose={() => {}} />);
    const menu = host.querySelector<HTMLElement>('[role="menu"]')!;
    expect(parseFloat(menu.style.maxWidth)).toBeCloseTo((320 - 16) / 1.5);
    expect(parseFloat(menu.style.left)).toBeCloseTo((320 - 8) / 1.5 - 180);
  } finally { document.documentElement.style.zoom = ""; viewport.mockRestore(); width.mockRestore(); height.mockRestore(); }
});

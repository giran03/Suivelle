// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installInputRouter, registerScope } from "./runtime";
import { useShortcuts } from "./store";
import { key, mouse } from "./bindings";
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(stop => stop()); document.body.replaceChildren(); useShortcuts.setState({ overrides: {}, recording: false }); localStorage.clear(); vi.restoreAllMocks(); });
const keyboard = (target: Element, value: string, patch = {}) => { const e = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...patch }); target.dispatchEvent(e); return e; };
it("rebinding changes execution, disables the old input, and leaves typing alone", () => {
  const input = document.createElement("input"); document.body.append(input);
  let count = 0; cleanups.push(installInputRouter({ sidebar: () => { count++; } }, () => true));
  useShortcuts.getState().assign("sidebar", [key("b", "Control", "Alt")]);
  expect(keyboard(input, "\\", { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(keyboard(input, "b", { ctrlKey: true, altKey: true }).defaultPrevented).toBe(true);
  expect(count).toBe(1);
  useShortcuts.getState().assign("sidebar", [key("b")]);
  expect(keyboard(input, "b").defaultPrevented).toBe(false);
});
it("handles a mouse gesture once, suppresses its followup and preserves unmatched clicks", () => {
  const element = document.createElement("div"); document.body.append(element);
  let count = 0; cleanups.push(installInputRouter({ sidebar: () => { count++; } }, () => true));
  useShortcuts.getState().assign("sidebar", [mouse(3)]);
  const down = "PointerEvent" in window ? "pointerdown" : "mousedown";
  element.dispatchEvent(new MouseEvent(down, { button: 3, bubbles: true, cancelable: true }));
  const up = new MouseEvent("auxclick", { button: 3, bubbles: true, cancelable: true }); element.dispatchEvent(up);
  expect(count).toBe(1); expect(up.defaultPrevented).toBe(true);
  const ordinary = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true }); element.dispatchEvent(ordinary); expect(ordinary.defaultPrevented).toBe(false);
});
it("routes contextual commands and prevents removed editor defaults from falling through", () => {
  const editor = document.createElement("div"); editor.contentEditable = "true"; document.body.append(editor);
  let count = 0; cleanups.push(registerScope(editor, "editor", { bold: () => { count++; } })); cleanups.push(installInputRouter({}, () => true));
  keyboard(editor, "b", { ctrlKey: true }); expect(count).toBe(1);
  useShortcuts.getState().assign("bold", []);
  expect(keyboard(editor, "b", { ctrlKey: true }).defaultPrevented).toBe(true); expect(count).toBe(1);
});
it("isolates recording, modal controls, unavailable commands and IME composition", () => {
  const dialog = document.createElement("dialog"); dialog.setAttribute("open", ""); const input = document.createElement("input"); dialog.append(input); document.body.append(dialog);
  let count = 0; cleanups.push(installInputRouter({ sidebar: () => { count++; } }, () => true));
  keyboard(input, "\\", { ctrlKey: true }); expect(count).toBe(0);
  dialog.removeAttribute("open"); useShortcuts.setState({ recording: true }); keyboard(input, "\\", { ctrlKey: true }); expect(count).toBe(0);
  useShortcuts.setState({ recording: false }); keyboard(input, "\\", { ctrlKey: true, isComposing: true }); expect(count).toBe(0);
});
it("persists overrides, preserves default restoration conflicts and survives storage failure", () => {
  useShortcuts.getState().assign("sidebar", []);
  expect(JSON.parse(localStorage.getItem("suivelle.shortcuts")!).overrides.sidebar).toEqual([]);
  useShortcuts.getState().assign("focus", [key("\\", "Control")]);
  expect(() => useShortcuts.getState().reset("sidebar")).toThrow(/conflict/);
  useShortcuts.getState().reset(); expect(useShortcuts.getState().overrides).toEqual({});
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(() => useShortcuts.getState().assign("sidebar", [])).toThrow(/Could not save/);
  expect(useShortcuts.getState().overrides).toEqual({});
});

it("consumes background page keys and pointer inputs while preserving palette typing and Ctrl+K", () => {
  const dialog = document.createElement("dialog"); dialog.className = "palette"; dialog.open = true;
  const input = document.createElement("input"); dialog.append(input);
  const editor = document.createElement("textarea"); document.body.append(editor, dialog);
  const pageInput = vi.fn(), typing = vi.fn(), search = vi.fn();
  editor.addEventListener("keydown", pageInput); editor.addEventListener("mousedown", pageInput);
  input.addEventListener("keydown", typing);
  cleanups.push(installInputRouter({ search }, () => true));
  expect(keyboard(editor, "a").defaultPrevented).toBe(true);
  const down = "PointerEvent" in window ? "pointerdown" : "mousedown";
  const click = new MouseEvent(down, { bubbles: true, cancelable: true }); editor.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true); expect(pageInput).not.toHaveBeenCalled();
  expect(keyboard(input, "a").defaultPrevented).toBe(false); expect(typing).toHaveBeenCalledTimes(1);
  expect(keyboard(input, "k", { ctrlKey: true }).defaultPrevented).toBe(true); expect(search).toHaveBeenCalledTimes(1);
  dialog.open = false;
  expect(keyboard(editor, "a").defaultPrevented).toBe(false); expect(pageInput).toHaveBeenCalledTimes(1);
});

it("keeps page clipboard shortcuts inside hierarchy scopes and preserves editor text copy/paste", () => {
  const tree = document.createElement("div"), editor = document.createElement("textarea");
  document.body.append(tree, editor);
  const copy = vi.fn(), paste = vi.fn();
  cleanups.push(registerScope(tree, "pages", { "page-copy": copy, "page-paste": paste }));
  cleanups.push(installInputRouter({}, () => true));
  expect(keyboard(tree, "c", { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(keyboard(tree, "v", { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(copy).toHaveBeenCalledTimes(1); expect(paste).toHaveBeenCalledTimes(1);
  expect(keyboard(editor, "c", { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(keyboard(editor, "v", { ctrlKey: true }).defaultPrevented).toBe(false);
});

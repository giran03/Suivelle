// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import { buildExtensions } from "./extensions";
import { installInputRouter } from "../shortcuts/runtime";
import { useShortcuts } from "../shortcuts/store";
import { key, mouse } from "../shortcuts/bindings";
let editor: Editor | undefined;
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); editor?.destroy(); document.body.replaceChildren(); useShortcuts.setState({ overrides: {}, recording: false }); localStorage.clear(); });
it("rebinds actual TipTap formatting without rebuilding state or leaving old shortcuts active", () => {
  const host = document.createElement("div"); document.body.append(host);
  editor = new Editor({ element: host, extensions: buildExtensions(), content: "<p>Hello world</p>" });
  stop = installInputRouter({}, () => true);
  editor.commands.setTextSelection({ from: 1, to: 6 });
  const press = (value: string, patch = {}) => editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: value, ctrlKey: true, bubbles: true, cancelable: true, ...patch }));
  useShortcuts.getState().assign("bold", [key("b", "Control", "Alt")]);
  press("b"); expect(editor.isActive("bold")).toBe(false);
  press("b", { altKey: true }); expect(editor.isActive("bold")).toBe(true);
  expect(editor.state.doc.textContent).toBe("Hello world");
  editor.commands.undo(); expect(editor.isActive("bold")).toBe(false);
  useShortcuts.getState().assign("bold", [mouse(3)]);
  editor.view.dom.dispatchEvent(new MouseEvent("PointerEvent" in window ? "pointerdown" : "mousedown", { button: 3, bubbles: true, cancelable: true }));
  expect(editor.isActive("bold")).toBe(true);
  useShortcuts.getState().assign("bold", []); press("b"); expect(editor.isActive("bold")).toBe(true);
});

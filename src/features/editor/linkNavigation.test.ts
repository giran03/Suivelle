// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vitest";
import { buildExtensions } from "./extensions";
import { openEditorLink } from "./extensions/linkNavigation";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { usePeek } from "../peek/store";

let editor: Editor | undefined;
const original = useWorkspace.getState();
afterEach(() => { editor?.destroy(); editor = undefined; vi.restoreAllMocks(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; useWorkspace.setState(original, true); document.body.replaceChildren(); });
function link(href: string, editable = true, nested = false) {
  const element = document.createElement("div"); document.body.append(element);
  editor = new Editor({ element, extensions: buildExtensions({ nested }), editable,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A link", marks: [{ type: "link", attrs: { href } }] }] }] } });
  return element.querySelector<HTMLAnchorElement>("a")!;
}
it("opens ordinary links without navigating away in editable, read-only, and nested editors", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  for (const [editable, nested] of [[true, false], [false, false], [true, true]]) {
    const anchor = link("https://example.com/page", editable, nested);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(open).toHaveBeenLastCalledWith("https://example.com/page", "_blank", "noopener,noreferrer");
    editor?.destroy(); editor = undefined;
  }
  expect(open).toHaveBeenCalledTimes(3);
});
it("uses the desktop opener, supports middle-click and Enter, and reports opening failures", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  const open = vi.spyOn(ipc, "imageOpenLink").mockResolvedValue(undefined);
  const anchor = link("https://example.com");
  anchor.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
  anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(open).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledWith("https://example.com/");
  open.mockRejectedValue(new Error("Browser launch failed"));
  await openEditorLink("https://example.com");
  expect(useWorkspace.getState().error).toContain("Browser launch failed");
});
it("keeps internal navigation and Shift-click peek inside the app", () => {
  const id = "00000000-0000-7000-8000-000000000001";
  const navigate = vi.spyOn(useWorkspace.getState(), "openPage").mockResolvedValue(undefined);
  const peek = vi.spyOn(usePeek.getState(), "show").mockImplementation(() => {});
  const external = vi.spyOn(window, "open").mockReturnValue(null);
  const anchor = link(`suivelle://page/${id}`);
  anchor.click();
  anchor.dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true, cancelable: true }));
  expect(navigate).toHaveBeenCalledWith(id);
  expect(peek).toHaveBeenCalledWith(id);
  expect(external).not.toHaveBeenCalled();
});
it("allows selecting link text and refuses executable links", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const anchor = link("https://example.com");
  const selection = window.getSelection()!;
  const range = document.createRange(); range.selectNodeContents(anchor); selection.addRange(range);
  anchor.click();
  expect(open).not.toHaveBeenCalled();
  selection.removeAllRanges();
  await openEditorLink("javascript:alert(1)");
  expect(open).not.toHaveBeenCalled();
  expect(useWorkspace.getState().error).toContain("Only web and email links");
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Palette } from "./Palette";
import { usePalette } from "./store";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("../../lib/dialog", () => ({ syncDialog: (dialog: HTMLDialogElement, open: boolean) => { dialog.open = open; } }));
vi.mock("./PaletteBody", () => ({ PaletteBody: () => <div className="palette-list"><input aria-label="Search" /></div> }));

it("blocks backdrop/background scrolling and page key handlers, preserves palette input, and restores on close", async () => {
  const host = document.createElement("div"), page = document.createElement("textarea");
  document.body.append(host, page);
  const root = createRoot(host);
  const backgroundKey = vi.fn(), backgroundWheel = vi.fn();
  window.addEventListener("keydown", backgroundKey);
  window.addEventListener("wheel", backgroundWheel);
  usePalette.setState({ open: true, task: false, busy: false });
  try {
    await act(async () => { root.render(<Palette />); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    const dialog = host.querySelector("dialog")!;
    const input = host.querySelector("input")!;
    const wheel = (target: Element) => { const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 }); target.dispatchEvent(event); return event; };
    expect(wheel(page).defaultPrevented).toBe(true);
    expect(wheel(dialog).defaultPrevented).toBe(true);
    expect(wheel(input).defaultPrevented).toBe(false);
    expect(backgroundWheel).not.toHaveBeenCalled();
    const key = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }); input.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(backgroundKey).not.toHaveBeenCalled();
    await act(async () => usePalette.getState().hide());
    expect(wheel(page).defaultPrevented).toBe(false);
    expect(backgroundWheel).toHaveBeenCalledTimes(1);
    await act(async () => usePalette.getState().show());
    expect(wheel(page).defaultPrevented).toBe(true);
  } finally {
    await act(async () => root.unmount());
    window.removeEventListener("keydown", backgroundKey);
    window.removeEventListener("wheel", backgroundWheel);
    usePalette.setState({ open: false }); host.remove(); page.remove();
  }
});

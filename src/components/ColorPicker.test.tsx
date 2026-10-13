// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ColorPicker } from "./ColorPicker";
vi.mock("../lib/dialog", () => ({ syncDialog: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("edits background alpha, preserves it through RGB edits, and commits only on Use color", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), onUse = vi.fn(), onClose = vi.fn();
  const edit = async (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    await act(async () => root.render(<ColorPicker initial="#12345680" allowOpacity onUse={onUse} onClose={onClose} />));
    expect(host.querySelector("strong")!.textContent).toBe("#12345680");
    await edit(host.querySelector<HTMLInputElement>('[aria-label="Opacity percentage"]')!, "25");
    expect(host.querySelector("strong")!.textContent).toBe("#12345640");
    await edit(host.querySelector<HTMLInputElement>('[aria-label="R channel"]')!, "255");
    expect(host.querySelector("strong")!.textContent).toBe("#FF345640");
    expect(onUse).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Use color")!.click());
    expect(onUse).toHaveBeenCalledWith("#FF345640");
    await act(async () => root.render(<ColorPicker key="opaque" initial="#123456" onUse={onUse} onClose={onClose} />));
    expect(host.querySelector('[aria-label="Opacity percentage"]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

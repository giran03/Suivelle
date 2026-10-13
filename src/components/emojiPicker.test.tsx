// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import EmojiPicker from "./EmojiPicker";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("renders a bounded page, browses the full catalog, searches and selects complete emoji sequences", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); const selected = vi.fn();
  try {
    await act(async () => root.render(<EmojiPicker onSelect={selected} />));
    expect(host.querySelectorAll(".emoji-cell")).toHaveLength(80);
    expect(host.textContent).toContain("3,944");
    const first = host.querySelector(".emoji-cell")!.textContent;
    const next = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Next")!;
    await act(async () => next.click());
    expect(host.querySelector(".emoji-cell")!.textContent).not.toBe(first);
    expect(host.textContent).toContain("Page 2");
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Philippines");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const flag = host.querySelector<HTMLButtonElement>('[aria-label="flag: Philippines"]')!;
    expect(flag).toBeTruthy();
    await act(async () => flag.click());
    expect(selected).toHaveBeenCalledWith("🇵🇭");
    await act(async () => root.render(<EmojiPicker onSelect={selected} disabled />));
    expect(flag.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
});

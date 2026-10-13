// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Popover } from "./Popover";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("positions against the full layout dimensions while the entrance animation scales the visual rect", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
  const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(240);
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 291, height: 232.8 } as DOMRect);
  try {
    await act(async () => root.render(<Popover anchor={{ left: window.innerWidth - 20, right: window.innerWidth - 10, top: window.innerHeight - 30, bottom: window.innerHeight - 10 }} onClose={() => {}} label="Sizing test"><button>Content</button></Popover>));
    const panel = host.querySelector<HTMLElement>(".popover")!;
    expect(parseFloat(panel.style.left) + 300).toBe(window.innerWidth - 8);
    expect(parseFloat(panel.style.top) + 240).toBe(window.innerHeight - 34);
  } finally {
    await act(async () => root.unmount()); host.remove(); width.mockRestore(); height.mockRestore(); rect.mockRestore();
  }
});

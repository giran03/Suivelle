// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Titlebar } from "./Titlebar";

const native = vi.hoisted(() => ({
  minimize: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  isMaximized: vi.fn(async () => false), isFocused: vi.fn(async () => true),
  onResized: vi.fn(), onFocusChanged: vi.fn(), stopResize: vi.fn(), stopFocus: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  native.isMaximized.mockResolvedValue(false); native.isFocused.mockResolvedValue(true);
  native.onResized.mockResolvedValue(native.stopResize); native.onFocusChanged.mockResolvedValue(native.stopFocus);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
async function mount() { await act(async () => root.render(<Titlebar />)); }
async function click(label: string) { await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()); }

it("connects window controls and restores the maximize button's state", async () => {
  await mount(); await click("Minimize window"); expect(native.minimize).toHaveBeenCalledOnce();
  native.isMaximized.mockResolvedValue(true);
  await click("Maximize window"); expect(native.toggleMaximize).toHaveBeenCalledOnce();
  expect(host.querySelector('[aria-label="Restore window"]')).not.toBeNull();
  await click("Close window"); expect(native.close).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-tauri-drag-region]')).not.toBeNull();
  expect(host.querySelector('.app-window-controls [data-tauri-drag-region]')).toBeNull();
});
it("tracks native resize and focus events and removes listeners on unmount", async () => {
  await mount();
  native.isMaximized.mockResolvedValue(true);
  await act(async () => native.onResized.mock.calls[0][0]());
  expect(host.querySelector('[aria-label="Restore window"]')).not.toBeNull();
  await act(async () => native.onFocusChanged.mock.calls[0][0]({ payload: false }));
  expect(host.querySelector('header')?.dataset.focused).toBe("false");
  await act(async () => root.unmount());
  expect(native.stopResize).toHaveBeenCalledOnce(); expect(native.stopFocus).toHaveBeenCalledOnce();
});
it("shows actionable window errors", async () => {
  native.minimize.mockRejectedValueOnce({ code: "window", message: "Window unavailable" });
  await mount(); await click("Minimize window");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not minimize the window: Window unavailable");
});
it("does not render desktop chrome in the browser", async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  await mount(); expect(host.innerHTML).toBe(""); expect(native.onResized).not.toHaveBeenCalled();
});

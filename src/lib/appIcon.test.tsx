// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppIcon } from "./appIcon";
import type { ThemeSetting } from "../types";

const native = vi.hoisted(() => ({
  windowIcon: vi.fn().mockResolvedValue(undefined),
  trayIcon: vi.fn().mockResolvedValue(undefined),
  image: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setIcon: native.windowIcon }) }));
vi.mock("@tauri-apps/api/tray", () => ({ TrayIcon: { getById: vi.fn(async () => ({ setIcon: native.trayIcon })) } }));
vi.mock("@tauri-apps/api/image", () => ({ Image: { fromBytes: native.image } }));
vi.mock("./appIconData", () => ({ APP_ICON_PNG: { light: "bGlnaHQ=", dark: "ZGFyaw==" } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
function IconSync({ theme }: { theme: ThemeSetting }) { useAppIcon(theme); return null; }
beforeEach(() => {
  vi.clearAllMocks();
  native.trayIcon.mockResolvedValue(undefined);
  native.image.mockImplementation(async (bytes: Uint8Array) => ({ bytes, close: native.close }));
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.unstubAllGlobals();
});

it("sends the same themed image to the window and tray, then releases it", async () => {
  for (const theme of ["light", "dark"] as const) {
    await act(async () => root.render(<IconSync theme={theme} />));
    await vi.waitFor(() => expect(native.close).toHaveBeenCalledTimes(theme === "light" ? 1 : 2));
    const image = native.windowIcon.mock.lastCall![0];
    expect(native.trayIcon.mock.lastCall![0]).toBe(image);
    expect(new TextDecoder().decode(image.bytes)).toBe(theme);
  }
});

it("updates both icons when the system color scheme changes", async () => {
  let listener: () => void = () => undefined;
  const query = { matches: false, addEventListener: vi.fn((_event, callback) => { listener = callback; }), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", () => query);
  await act(async () => root.render(<IconSync theme="system" />));
  await vi.waitFor(() => expect(native.close).toHaveBeenCalledTimes(1));
  query.matches = true;
  await act(async () => listener());
  await vi.waitFor(() => expect(native.close).toHaveBeenCalledTimes(2));
  expect(new TextDecoder().decode(native.trayIcon.mock.lastCall![0].bytes)).toBe("dark");
});

it("still updates the taskbar and releases the image if the tray update fails", async () => {
  native.trayIcon.mockRejectedValue(new Error("Tray unavailable"));
  await act(async () => root.render(<IconSync theme="light" />));
  await vi.waitFor(() => expect(native.close).toHaveBeenCalledOnce());
  expect(native.windowIcon).toHaveBeenCalledOnce();
});

it("does not call desktop icon APIs outside Tauri", async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  await act(async () => root.render(<IconSync theme="light" />));
  expect(native.image).not.toHaveBeenCalled();
});

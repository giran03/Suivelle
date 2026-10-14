// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { loadSafeMode } from "./safeMode";

afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.resetAllMocks(); });

it("does not admit a writable editor when the native safety check fails", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  vi.mocked(invoke).mockRejectedValue(new Error("database unavailable"));
  await expect(loadSafeMode()).rejects.toThrow("database unavailable");
});

it("waits for native readiness and preserves its read-only reason", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  vi.mocked(invoke).mockResolvedValue("integrity check failed");
  await expect(loadSafeMode()).resolves.toBe("integrity check failed");
});

it("opens browser instances without waiting for a native bridge", async () => {
  await expect(loadSafeMode()).resolves.toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

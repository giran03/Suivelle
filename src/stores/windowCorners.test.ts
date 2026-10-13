// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { localStorage.clear(); vi.resetModules(); });

it("remembers independent window corners across restarts and restores the system default", async () => {
  const { usePreferences } = await import("./preferences");
  expect(usePreferences.getState().windowCorners).toBe("default");
  usePreferences.getState().setWindowCorners("sharp");
  usePreferences.getState().set("corners", "round");
  vi.resetModules();
  const reloaded = (await import("./preferences")).usePreferences;
  expect(reloaded.getState().windowCorners).toBe("sharp");
  expect(reloaded.getState().corners).toBe("round");
  reloaded.getState().setWindowCorners("round");
  reloaded.getState().reset();
  expect(reloaded.getState().windowCorners).toBe("default");
});

it("migrates the old toggle without changing the existing window appearance", async () => {
  const { windowCornersFrom } = await import("./preferences");
  expect(windowCornersFrom({ windowCorners: false, corners: "round" })).toBe("default");
  for (const corners of ["sharp", "default", "round"] as const) {
    expect(windowCornersFrom({ windowCorners: true, corners })).toBe(corners);
    expect(windowCornersFrom({ windowCorners: corners })).toBe(corners);
  }
  expect(windowCornersFrom({ windowCorners: "invalid" })).toBe("default");
});

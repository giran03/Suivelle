// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { localStorage.clear(); vi.resetModules(); });

it("remembers independent window corners across restarts and resets to Soft", async () => {
  const { usePreferences } = await import("./preferences");
  expect(usePreferences.getState().windowCorners).toBe("soft");
  usePreferences.getState().setWindowCorners("sharp");
  usePreferences.getState().set("corners", "round");
  vi.resetModules();
  const reloaded = (await import("./preferences")).usePreferences;
  expect(reloaded.getState().windowCorners).toBe("sharp");
  expect(reloaded.getState().corners).toBe("round");
  reloaded.getState().setWindowCorners("round");
  reloaded.getState().reset();
  expect(reloaded.getState().windowCorners).toBe("soft");
});

it("migrates the old toggle without changing the existing window appearance", async () => {
  const { windowCornersFrom } = await import("./preferences");
  expect(windowCornersFrom({ windowCorners: false, corners: "round" })).toBe("round");
  expect(windowCornersFrom({ windowCorners: "default" })).toBe("round");
  expect(windowCornersFrom({ windowCorners: true, corners: "default" })).toBe("round");
  for (const corners of ["sharp", "soft", "round"] as const) {
    expect(windowCornersFrom({ windowCorners: corners })).toBe(corners);
  }
  expect(windowCornersFrom({ windowCorners: true, corners: "sharp" })).toBe("sharp");
  expect(windowCornersFrom({ windowCorners: true, corners: "round" })).toBe("round");
  expect(windowCornersFrom({ windowCorners: "invalid" })).toBe("soft");
  expect(windowCornersFrom({})).toBe("soft");
});

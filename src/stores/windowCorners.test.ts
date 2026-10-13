// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { localStorage.clear(); vi.resetModules(); });

it("defaults window corner syncing off and remembers the toggle across restarts", async () => {
  const { usePreferences } = await import("./preferences");
  expect(usePreferences.getState().windowCorners).toBe(false);
  usePreferences.getState().setWindowCorners(true);
  usePreferences.getState().set("corners", "round");
  vi.resetModules();
  const reloaded = (await import("./preferences")).usePreferences;
  expect(reloaded.getState().windowCorners).toBe(true);
  expect(reloaded.getState().corners).toBe("round");
  reloaded.getState().setWindowCorners(false);
  expect(reloaded.getState().corners).toBe("round");
  reloaded.getState().setWindowCorners(true);
  reloaded.getState().reset();
  expect(reloaded.getState().windowCorners).toBe(false);
});

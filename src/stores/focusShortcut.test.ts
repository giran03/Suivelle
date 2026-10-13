// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { localStorage.clear(); vi.resetModules(); });
it("enables app focus by default for old preferences and persists an explicit opt-out", async () => {
  localStorage.setItem("suivelle.preferences", JSON.stringify({shell:{closeToTray:true}}));
  const { usePreferences } = await import("./preferences");
  expect(usePreferences.getState().shell.focusShortcut).toBe(true);
  expect(usePreferences.getState().shell.closeToTray).toBe(true);
  usePreferences.getState().setShell({...usePreferences.getState().shell,focusShortcut:false});
  vi.resetModules();
  const reloaded = (await import("./preferences")).usePreferences;
  expect(reloaded.getState().shell.focusShortcut).toBe(false);
  expect(reloaded.getState().shell.closeToTray).toBe(true);
});

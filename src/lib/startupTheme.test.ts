// @vitest-environment jsdom
import bootstrap from "../../public/startup-theme.js?raw";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rememberStartupAppearance } from "./appearance";
import { sanitize } from "../stores/preferences";
import { emptyTheme, themeVariables } from "../features/settings/theme";

const run = () => Function(bootstrap)();
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});
it("restores the saved mode before React and supports system mode", () => {
  localStorage.setItem(
    "suivelle.preferences",
    JSON.stringify({ theme: "dark" }),
  );
  run();
  expect(document.documentElement.dataset.theme).toBe("dark");
  document.documentElement.removeAttribute("data-theme");
  localStorage.setItem(
    "suivelle.preferences",
    JSON.stringify({ theme: "system" }),
  );
  run();
  expect(document.documentElement.dataset.theme).toBeUndefined();
});
it("stores actual committed palette values, including derived custom colors and accent presets", () => {
  const choices = sanitize({ accent: "rose" }),
    config = emptyTheme();
  config.palettes.dark.background = "#25180F";
  config.palettes.dark["text-primary"] = "#FFF5DD";
  config.palettes.dark.accent = "#A35428";
  rememberStartupAppearance(choices, config);
  run();
  const variables = themeVariables(config, choices);
  expect(document.documentElement.style.getPropertyValue("--background")).toBe(
    variables["--background"],
  );
  expect(
    document.documentElement.style.getPropertyValue("--text-primary"),
  ).toBe(variables["--text-primary"]);
  expect(document.documentElement.style.getPropertyValue("--accent-ui")).toBe(
    variables["--accent-ui"],
  );
});
it("reads saved custom colors on the first launch after upgrading, before a cache exists", () => {
  localStorage.setItem(
    "suivelle.themes.v1",
    JSON.stringify({
      config: {
        palettes: {
          light: { background: "#FFEEDD" },
          dark: { background: "#12345680" },
        },
      },
    }),
  );
  run();
  expect(document.documentElement.style.getPropertyValue("--background")).toBe(
    "light-dark(#FFEEDD, #12345680)",
  );
});
it("falls back safely when saved data is corrupt or storage is unavailable", () => {
  localStorage.setItem("suivelle.preferences", "broken");
  localStorage.setItem("suivelle.startup-appearance", "broken");
  expect(run).not.toThrow();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect(run).not.toThrow();
  expect(() =>
    rememberStartupAppearance(sanitize({}), emptyTheme()),
  ).not.toThrow();
});

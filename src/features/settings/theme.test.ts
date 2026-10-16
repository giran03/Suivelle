// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAppearance } from "../../lib/appearance";
import { sanitize } from "../../stores/preferences";
import { COLOR_ROLES, contrast, contrastWarnings, emptyTheme, parseThemeFile, resolvePalette, sanitizeTheme, themeVariables } from "./theme";
import { useThemes } from "./themes";
import { useSettingsDialog } from "./store";
import { radioKeys } from "./radioKeys";
import type { KeyboardEvent } from "react";

const choices = sanitize({});
beforeEach(() => { localStorage.clear(); useThemes.setState({ config: emptyTheme(), preview: null, profiles: [] }); useSettingsDialog.setState({ open: false, closeGuard: null }); document.documentElement.removeAttribute("style"); });
afterEach(() => vi.restoreAllMocks());

describe("custom theme model", () => {
  it("keeps existing defaults untouched and sanitizes old or hostile saved values", () => {
    expect(themeVariables(emptyTheme(), choices)).toEqual({});
    expect(sanitizeTheme({ palettes: { dark: { sidebar: "#abc", field: "url(https://bad)", bogus: "#FFF" } } }).palettes.dark).toEqual({ sidebar: "#AABBCC" });
    expect(sanitizeTheme(null)).toEqual(emptyTheme());
  });
  it("keeps light and dark overrides independent, with explicit state colors taking precedence", () => {
    const config = emptyTheme(); config.palettes.dark = { background: "#121212", "surface-hover": "#223344", "editor-background": "#181818", accent: "#FFFFFF", "on-accent": "#112233" };
    const colors = resolvePalette(config, "dark", choices);
    expect(colors["surface-hover"]).toBe("#223344"); expect(colors["editor-background"]).toBe("#181818"); expect(colors["on-accent"]).toBe("#112233");
    expect(themeVariables(config, choices)["--background"]).toBe("light-dark(#F7F6F2, #121212)");
    expect(resolvePalette(config, "light", choices).background).toBe("#F7F6F2");
  });
  it("generates readable button text while honoring manual choices", () => {
    for (const accent of ["#FFFFFF", "#000000", "#FFFF00", "#123456"]) {
      const config = emptyTheme(); config.palettes.dark.accent = accent;
      const colors = resolvePalette(config, "dark", choices);
      expect(contrast(colors.accent, colors["on-accent"])).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keeps derived sidebar labels readable on arbitrary surfaces", () => {
    for (const sidebar of ["#FFFFFF", "#000000", "#777777", "#443355", "#FFDD00"]) {
      const config = emptyTheme(); config.palettes.dark.sidebar = sidebar;
      const colors = resolvePalette(config, "dark", choices);
      for (const role of ["sidebar-text", "sidebar-secondary", "sidebar-muted"] as const) expect(contrast(colors[role], sidebar)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("reports bad contrast without changing the requested colors", () => {
    const config = emptyTheme(); config.palettes.dark["text-primary"] = "#0C1329";
    expect(contrastWarnings(resolvePalette(config, "dark", choices))).toContainEqual(expect.objectContaining({ fg: "text-primary", bg: "background", ratio: 1 }));
    expect(config.palettes.dark["text-primary"]).toBe("#0C1329");
  });
  it("clears custom CSS on cancel/reset and restores the original accent preset", () => {
    const config = emptyTheme(); config.accent = "rose"; config.palettes.dark.sidebar = "#123456";
    applyAppearance(choices, config); expect(document.documentElement.style.getPropertyValue("--sidebar")).toContain("#123456");
    applyAppearance(choices, emptyTheme());
    for (const [role] of COLOR_ROLES) expect(document.documentElement.style.getPropertyValue(`--${role}`)).toBe("");
  });
  it("imports only versioned, valid colors and round-trips both palettes", () => {
    const config = emptyTheme(); config.palettes.light.sidebar = "#123456"; config.palettes.dark.accent = "#ABCDEF";
    expect(parseThemeFile(JSON.stringify({ format: "suivelle-theme", version: 1, name: "Mine", config }))).toEqual({ name: "Mine", config });
    expect(() => parseThemeFile('{"format":"other","version":1}')).toThrow();
    expect(() => parseThemeFile(JSON.stringify({ format: "suivelle-theme", version: 1, config: { palettes: { light: {}, dark: { sidebar: "red; background:url(x)" } } } }))).toThrow(/valid hex/);
  });
  it("names imports after the file without its JSON extension", () => {
    const json = JSON.stringify({ format: "suivelle-theme", version: 1, name: "Embedded name", config: emptyTheme() });
    expect(parseThemeFile(json, "Ocean.blue.JSON").name).toBe("Ocean.blue");
    expect(parseThemeFile(json, "  My theme.json").name).toBe("My theme");
    expect(parseThemeFile(json, `${"x".repeat(90)}.json`).name).toHaveLength(80);
    expect(parseThemeFile(json, ".json").name).toBe("Embedded name");
  });
});

describe("theme persistence and closing", () => {
  it("moves segmented-control focus and selection together with arrow keys", () => {
    const group = document.createElement("div");
    group.innerHTML = '<button role="radio">First</button><button role="radio" disabled>Disabled</button><button role="radio">Last</button>';
    document.body.append(group);
    const last = group.lastElementChild as HTMLButtonElement, select = vi.fn(); last.addEventListener("click", select);
    const preventDefault = vi.fn();
    radioKeys({ key: "ArrowRight", currentTarget: group, target: group.firstElementChild, preventDefault } as unknown as KeyboardEvent<HTMLElement>);
    expect(document.activeElement).toBe(last); expect(select).toHaveBeenCalledOnce(); expect(preventDefault).toHaveBeenCalledOnce(); group.remove();
  });
  it("previews without persisting, then saves only on Apply", () => {
    const config = emptyTheme(); config.palettes.dark.sidebar = "#112233";
    useThemes.getState().setPreview(config); expect(localStorage.length).toBe(0); expect(useThemes.getState().config).toEqual(emptyTheme());
    useThemes.getState().apply(config); expect(useThemes.getState().preview).toBeNull(); expect(JSON.parse(localStorage.getItem("suivelle.themes.v1")!).config).toEqual(config);
  });
  it("retains the draft and old committed theme if storage fails", () => {
    const config = emptyTheme(); config.palettes.dark.sidebar = "#112233"; useThemes.getState().setPreview(config);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Disk full"); });
    expect(() => useThemes.getState().apply(config)).toThrow();
    expect(useThemes.getState().config).toEqual(emptyTheme()); expect(useThemes.getState().preview).toEqual(config);
  });
  it("duplicates theme profiles independently and removes them without changing the active theme", () => {
    const config = emptyTheme(); config.palettes.dark.sidebar = "#112233";
    useThemes.getState().saveProfile("Mine", config); useThemes.getState().saveProfile("Mine copy", config);
    expect(useThemes.getState().profiles[0].id).not.toBe(useThemes.getState().profiles[1].id);
    config.palettes.dark.sidebar = "#FFFFFF"; expect(useThemes.getState().profiles[0].config.palettes.dark.sidebar).toBe("#112233");
    useThemes.getState().deleteProfile(useThemes.getState().profiles[0].id); expect(useThemes.getState().profiles).toHaveLength(1); expect(useThemes.getState().config).toEqual(emptyTheme());
  });
  it("guards closing and defers the next dialog until the draft is resolved", () => {
    const next = vi.fn(), guard = vi.fn(); useSettingsDialog.getState().show(); useSettingsDialog.setState({ closeGuard: guard });
    useSettingsDialog.getState().requestClose(next); expect(guard).toHaveBeenCalledWith(next); expect(next).not.toHaveBeenCalled(); expect(useSettingsDialog.getState().open).toBe(true);
    useSettingsDialog.getState().finishClose(next); expect(next).toHaveBeenCalledOnce(); expect(useSettingsDialog.getState().open).toBe(false);
  });
});

it("retains theme background opacity through sanitizing, saved profiles and exported files", () => {
  const config = emptyTheme();
  config.palettes.dark = { background: "#12345680", sidebar: "#abc4", "text-primary": "#FFFFFF80" };
  const clean = sanitizeTheme(config);
  expect(clean.palettes.dark).toEqual({ background: "#12345680", sidebar: "#AABBCC44" });
  expect(themeVariables(clean, choices)["--background"]).toBe("light-dark(#F7F6F2, #12345680)");
  useThemes.getState().saveProfile("Translucent", clean);
  expect(useThemes.getState().profiles[0].config.palettes.dark.background).toBe("#12345680");
  expect(parseThemeFile(JSON.stringify({format: "suivelle-theme", version: 1, config: clean})).config).toEqual(clean);
  expect(contrastWarnings(resolvePalette(clean, "dark", choices)).every(w => Number.isFinite(w.ratio))).toBe(true);
});

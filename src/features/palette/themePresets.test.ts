// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { COMMANDS, matchCommands } from "./commands";
import { PALETTE_PRESETS } from "../settings/presets";
import { emptyTheme, parseThemeFile } from "../settings/theme";
import { useThemes } from "../settings/themes";
import { usePreferences } from "../../stores/preferences";
import { useWorkspace } from "../../stores/workspace";
import { READ_ONLY_COMMANDS } from "../../lib/access";

vi.mock("../../lib/access", async importOriginal => ({ ...await importOriginal<typeof import("../../lib/access")>(), READ_ONLY: true }));

const preferences = usePreferences.getInitialState();
const themes = useThemes.getInitialState();
beforeEach(() => {
  localStorage.clear();
  usePreferences.setState({ ...preferences, theme: "system" }, true);
  useThemes.setState({ ...themes, config: { accent: "rose", palettes: { light: { background: "#ABCDEF" }, dark: { background: "#123456" } } }, preview: emptyTheme(), previewMode: "dark" }, true);
});
afterEach(() => {
  usePreferences.setState(preferences, true);
  useThemes.setState(themes, true);
  vi.restoreAllMocks();
  localStorage.clear();
});

for (const mode of ["light", "dark"] as const) {
  for (const preset of PALETTE_PRESETS[mode]) {
    it(`finds and applies ${preset.name}, including its ${mode} mode`, async () => {
      const id = `theme-preset-${preset.id}`;
      const command = matchCommands(`theme ${preset.name}`)[0];
      expect(command.id).toBe(id);
      expect(matchCommands("theme presets").some(c => c.id === id)).toBe(true);
      expect(READ_ONLY_COMMANDS.has(id)).toBe(true);
      const other = mode === "light" ? "dark" : "light";
      const previous = useThemes.getState().config;
      await command.run();
      const { config, preview, previewMode } = useThemes.getState();
      expect(config.palettes[mode]).toEqual(preset.colors);
      expect(config.palettes[other]).toEqual(previous.palettes[other]);
      expect(config.accent).toBe("rose");
      expect(previous.palettes[mode]).not.toEqual(preset.colors);
      expect(preview).toBeNull();
      expect(previewMode).toBeNull();
      expect(usePreferences.getState().theme).toBe(mode);
      expect(JSON.parse(localStorage.getItem("suivelle.themes.v1")!).config).toEqual(config);
      expect(JSON.parse(localStorage.getItem("suivelle.preferences")!).theme).toBe(mode);
    });
  }
}

it("reports a failed palette save without switching modes or losing the saved palette", async () => {
  const config = useThemes.getState().config;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage is full"); });
  const report = vi.spyOn(useWorkspace.getState(), "setError").mockImplementation(() => {});
  await COMMANDS.find(c => c.id === "theme-preset-paper")!.run();
  expect(report).toHaveBeenCalledWith("Storage is full");
  expect(useThemes.getState().config).toBe(config);
  expect(usePreferences.getState().theme).toBe("system");
});

it("discovers newly saved and imported themes, including in read-only workspaces", () => {
  expect(matchCommands("theme saved")).toEqual([]);
  useThemes.getState().saveProfile("Ocean", emptyTheme());
  const imported = parseThemeFile(JSON.stringify({ format: "suivelle-theme", version: 1, name: "Desert", config: emptyTheme() }));
  useThemes.getState().saveProfile(imported.name, imported.config);
  expect(matchCommands("theme Ocean")[0].title).toBe("Switch to Ocean theme (saved)");
  expect(matchCommands("theme Desert")[0].title).toBe("Switch to Desert theme (saved)");
  expect(matchCommands("theme presets").filter(c => c.id.startsWith("theme-profile-"))).toHaveLength(2);
});

it("applies both palettes and the accent of a saved theme while preserving the mode and library", async () => {
  const config = { accent: "cyan", palettes: { light: { background: "#FFFFFF" }, dark: { background: "#000000" } } };
  useThemes.getState().saveProfile("Ocean", config);
  const profiles = useThemes.getState().profiles;
  await matchCommands("theme Ocean")[0].run();
  expect(useThemes.getState().config).toEqual(config);
  expect(useThemes.getState().preview).toBeNull();
  expect(useThemes.getState().previewMode).toBeNull();
  expect(useThemes.getState().profiles).toEqual(profiles);
  expect(usePreferences.getState().theme).toBe("system");
  expect(JSON.parse(localStorage.getItem("suivelle.themes.v1")!).config).toEqual(config);
});

it("uses stable, separate commands for identically named themes and removes deleted entries", async () => {
  useThemes.getState().saveProfile("Paper", emptyTheme());
  useThemes.getState().saveProfile("Paper", emptyTheme());
  const commands = matchCommands("theme Paper");
  expect(commands).toHaveLength(3);
  expect(new Set(commands.map(c => c.id)).size).toBe(3);
  const profiles = useThemes.getState().profiles;
  const stale = commands.find(c => c.id === `theme-profile-${profiles[0].id}`)!;
  useThemes.getState().deleteProfile(profiles[0].id);
  expect(matchCommands("theme Paper").map(c => c.id)).not.toContain(stale.id);
  const apply = vi.spyOn(useThemes.getState(), "apply");
  await stale.run();
  expect(apply).not.toHaveBeenCalled();
});

it("leaves the active theme intact and reports failures when applying a saved theme", async () => {
  useThemes.getState().saveProfile("Ocean", emptyTheme());
  const config = useThemes.getState().config;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage is full"); });
  const report = vi.spyOn(useWorkspace.getState(), "setError").mockImplementation(() => {});
  await matchCommands("theme Ocean")[0].run();
  expect(report).toHaveBeenCalledWith("Storage is full");
  expect(useThemes.getState().config).toBe(config);
});

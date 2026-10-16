// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";
import { useSettingsDialog } from "./store";
import { useThemes } from "./themes";
import { emptyTheme, parseThemeFile } from "./theme";
import { PALETTE_PRESETS } from "./presets";
import { usePreferences } from "../../stores/preferences";
import { ipc } from "../../lib/ipc";

vi.mock("./../updates/Updates", () => ({ UpdatesSection: () => null }));
vi.mock("../../lib/dialog", () => ({ syncDialog: () => undefined }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const preferences = usePreferences.getInitialState();
beforeEach(async () => {
  localStorage.clear();
  usePreferences.setState({ ...preferences, theme: "dark" }, true);
  useThemes.setState({ config: emptyTheme(), preview: null, previewMode: null, profiles: [] });
  useSettingsDialog.setState({ open: true, section: null, closeGuard: null });
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<SettingsDialog />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  usePreferences.setState(preferences, true);
  vi.restoreAllMocks();
});
async function click(label: string) {
  const scope = label === "Light" || label === "Dark" ? host.querySelector('[aria-label="Palette to edit"]')! : host;
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

it("selects the first preset and offers Apply as soon as the palette mode changes", async () => {
  await click("Light");
  expect(host.querySelector('[aria-label="light color presets"] [aria-checked="true"]')?.textContent).toBe("Paper");
  expect([...host.querySelectorAll("button")].some(b => b.textContent === "Apply")).toBe(true);
  expect(usePreferences.getState().theme).toBe("dark");
  expect(useThemes.getState().previewMode).toBe("light");
  expect(host.querySelector('[aria-label="Theme"] [aria-checked="true"]')?.textContent).toBe("Light");
  expect(localStorage.getItem("suivelle.preferences")).toBeNull();
  expect(localStorage.getItem("suivelle.themes.v1")).toBeNull();
  expect(useThemes.getState().config).toEqual(emptyTheme());
  await click("Apply");
  expect(useThemes.getState().previewMode).toBeNull();
  await click("Dark");
  expect(useThemes.getState().previewMode).toBe("dark");
  expect(host.querySelector('[aria-label="dark color presets"] [aria-checked="true"]')?.textContent).toBe("Midnight");
  await click("Apply");
  expect(useThemes.getState().config.palettes.dark).toEqual(PALETTE_PRESETS.dark[0].colors);
});

it("offers Apply after switching back to an already saved default palette", async () => {
  await click("Light"); await click("Apply");
  await click("Dark"); await click("Apply");
  await act(async () => usePreferences.getState().setTheme("light"));
  await click("Light");
  expect([...host.querySelectorAll("button")].some(b => b.textContent === "Apply")).toBe(true);
  await click("Apply");
  expect([...host.querySelectorAll("button")].some(b => b.textContent === "Apply")).toBe(false);
});

it("applies a light preset with light mode and a dark preset with dark mode", async () => {
  await click("Light"); await click("Paper");
  expect(usePreferences.getState().theme).toBe("dark");
  await click("Apply");
  expect(usePreferences.getState().theme).toBe("light");
  expect(useThemes.getState().config.palettes.light).toEqual(PALETTE_PRESETS.light[0].colors);
  await click("Dark"); await click("Forest"); await click("Apply");
  expect(usePreferences.getState().theme).toBe("dark");
});

it("can activate an already saved preset without changing its colors", async () => {
  await click("Light"); await click("Paper"); await click("Apply");
  await act(async () => usePreferences.getState().setTheme("dark"));
  await click("Paper"); await click("Apply");
  expect(usePreferences.getState().theme).toBe("light");
});

it("cancels preset changes without changing the active mode or saved colors", async () => {
  await click("Light"); await click("Mist"); await click("Cancel");
  expect(usePreferences.getState().theme).toBe("dark");
  expect(useThemes.getState().config).toEqual(emptyTheme());
  expect(useThemes.getState().previewMode).toBeNull();
});

it("restores the saved mode when app preview is turned off and resumes it when enabled", async () => {
  await click("Light");
  expect(useThemes.getState().previewMode).toBe("light");
  const checkbox = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes("Preview changes in the app"))!;
  await act(async () => checkbox.click());
  expect(useThemes.getState().previewMode).toBeNull();
  expect(host.querySelector('[aria-label="Theme"] [aria-checked="true"]')?.textContent).toBe("Dark");
  await act(async () => checkbox.click());
  expect(useThemes.getState().previewMode).toBe("light");
  expect(usePreferences.getState().theme).toBe("dark");
});

it("stages the main Theme mode control too, including System, until Apply", async () => {
  const mode = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Theme"] button')].find(button => button.textContent === label)!;
  await act(async () => mode("Light").click());
  expect(useThemes.getState().previewMode).toBe("light");
  expect(usePreferences.getState().theme).toBe("dark");
  expect(localStorage.getItem("suivelle.preferences")).toBeNull();
  await act(async () => mode("System").click());
  expect(useThemes.getState().previewMode).toBe("system");
  expect(usePreferences.getState().theme).toBe("dark");
  await click("Apply");
  expect(useThemes.getState().previewMode).toBeNull();
  expect(usePreferences.getState().theme).toBe("system");
});

it("uses the palette mode when applying an individual custom color", async () => {
  await click("Light");
  const input = host.querySelector<HTMLInputElement>('#color-background')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "#ABCDEF");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Apply");
  expect(usePreferences.getState().theme).toBe("light");
  expect(useThemes.getState().config.palettes.light.background).toBe("#ABCDEF");
});

it("keeps the current mode if saving the palette fails", async () => {
  await click("Light"); await click("Sand");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  await click("Apply");
  expect(usePreferences.getState().theme).toBe("dark");
  expect(useThemes.getState().config).toEqual(emptyTheme());
  expect(host.textContent).toContain("Could not save the theme");
});

it("exports the current draft through the native save command as an importable theme", async () => {
  const save = vi.spyOn(ipc, "exportTheme").mockResolvedValue(true);
  await click("Light"); await click("Paper"); await click("Export theme…");
  const exported = parseThemeFile(save.mock.calls[0][0]);
  expect(exported.config.palettes.light).toEqual(PALETTE_PRESETS.light[0].colors);
  expect(host.textContent).toContain("Theme exported.");
  expect(useThemes.getState().config).toEqual(emptyTheme());
});

it("reports export cancellation and disk errors without claiming success", async () => {
  const save = vi.spyOn(ipc, "exportTheme").mockResolvedValue(false);
  await click("Export theme…");
  expect(host.textContent).toContain("Export canceled.");
  save.mockRejectedValue({ code: "io", message: "Disk is full" });
  await click("Export theme…");
  expect(host.textContent).toContain("Could not export the theme: Disk is full");
});

it("keeps Settings open when the import file picker is canceled", async () => {
  // Exercise the shared native event listener as well as React's dialog handlers.
  const { syncDialog } = await vi.importActual<typeof import("../../lib/dialog")>("../../lib/dialog");
  const dialog = host.querySelector<HTMLDialogElement>('[aria-label="Settings"]')!;
  dialog.showModal = () => dialog.setAttribute("open", "");
  syncDialog(dialog, true);
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => input.dispatchEvent(new Event("cancel", { bubbles: true })));
  expect(useSettingsDialog.getState().open).toBe(true);
  expect(dialog.classList.contains("is-closing")).toBe(false);
  expect(host.querySelector('[aria-label="Settings"]')).not.toBeNull();
  await click("Light"); await click("Paper");
  await act(async () => input.dispatchEvent(new Event("cancel", { bubbles: true })));
  expect(useSettingsDialog.getState().open).toBe(true);
  expect(host.textContent).not.toContain("Keep your theme changes?");
});

it("still lets Escape dismiss the Settings dialog itself", async () => {
  const dialog = host.querySelector<HTMLDialogElement>('[aria-label="Settings"]')!;
  await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
  expect(useSettingsDialog.getState().open).toBe(false);
});

async function themeName(value: string) {
  const input = host.querySelector<HTMLInputElement>("#theme-name")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

async function importFile(name: string, text: string, size?: number) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const chosen = new File([text], name, { type: "application/json" });
  Object.defineProperty(chosen, "text", { value: async () => text });
  if (size !== undefined) Object.defineProperty(chosen, "size", { value: size });
  Object.defineProperty(input, "files", { configurable: true, value: [chosen] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  return input;
}

it("clears the name after saving, selects the new theme, and exports with its saved name", async () => {
  const save = vi.spyOn(ipc, "exportTheme").mockResolvedValue(true);
  const input = await themeName("  Ocean  ");
  await click("Save theme");
  expect(input.value).toBe("");
  expect(useThemes.getState().profiles.map(p => p.name)).toEqual(["Ocean"]);
  expect(host.querySelector<HTMLSelectElement>("#saved-theme")!.value).toBe(useThemes.getState().profiles[0].id);
  expect([...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Save theme")!.disabled).toBe(true);
  await click("Export theme…");
  expect(parseThemeFile(save.mock.calls[0][0]).name).toBe("Ocean");
});

it("keeps the name available for retry when saving fails", async () => {
  const input = await themeName("Ocean");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage is full"); });
  await click("Save theme");
  expect(input.value).toBe("Ocean");
  expect(useThemes.getState().profiles).toEqual([]);
  expect(host.textContent).toContain("Storage is full");
});

it("imports under the file name, selects it, and exports both palettes without applying", async () => {
  const config = emptyTheme();
  config.palettes.light.background = "#ABCDEF80";
  config.palettes.dark.background = "#123456";
  const save = vi.spyOn(ipc, "exportTheme").mockResolvedValue(true);
  await themeName("Old draft name");
  const input = await importFile("Ocean.blue.JSON", JSON.stringify({ format: "suivelle-theme", version: 1, name: "Other name", config }));
  expect(input.value).toBe("");
  expect(useThemes.getState().profiles[0]).toMatchObject({ name: "Ocean.blue", config });
  expect(host.querySelector<HTMLSelectElement>("#saved-theme")!.value).toBe(useThemes.getState().profiles[0].id);
  expect(host.querySelector<HTMLInputElement>("#theme-name")!.value).toBe("");
  expect(useThemes.getState().config).toEqual(emptyTheme());
  await click("Export theme…");
  expect(parseThemeFile(save.mock.calls[0][0])).toEqual({ name: "Ocean.blue", config });
  await click("Remove");
  expect(useThemes.getState().profiles).toEqual([]);
});

it("rejects invalid or oversized imports without changing the library or name field", async () => {
  const input = await themeName("Keep my name");
  await importFile("Broken.json", "not json");
  expect(useThemes.getState().profiles).toEqual([]);
  expect(input.value).toBe("Keep my name");
  await importFile("Huge.json", "{}", 128 * 1024 + 1);
  expect(host.textContent).toContain("smaller than 128 KB");
  expect(useThemes.getState().profiles).toEqual([]);
  expect(useThemes.getState().preview).toBeNull();
});

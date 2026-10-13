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
  useThemes.setState({ config: emptyTheme(), preview: null, profiles: [] });
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
  expect(useThemes.getState().config).toEqual(emptyTheme());
  await click("Apply");
  await click("Dark");
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

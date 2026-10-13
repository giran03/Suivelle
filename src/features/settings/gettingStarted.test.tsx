// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";
import { useSettingsDialog } from "./store";
import { useWorkspace } from "../../stores/workspace";
import { usePreferences } from "../../stores/preferences";
import { seedGettingStarted } from "../onboarding/gettingStarted";
import type { Page, Workspace } from "../../types";

vi.mock("../onboarding/gettingStarted", () => ({ seedGettingStarted: vi.fn() }));
vi.mock("../updates/Updates", () => ({ UpdatesSection: () => null }));
vi.mock("../../lib/dialog", () => ({ syncDialog: () => undefined }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const original = useWorkspace.getInitialState();
const preferences = usePreferences.getInitialState();
let root: Root;
let host: HTMLDivElement;
const reload = vi.fn().mockResolvedValue(undefined);
const select = vi.fn().mockResolvedValue(undefined);

beforeEach(async () => {
  vi.clearAllMocks();
  usePreferences.setState({ ...preferences, theme: "dark" }, true);
  useWorkspace.setState({ ...original, workspace: { id: "current-workspace" } as Workspace, reloadTree: reload, selectPage: select }, true);
  useSettingsDialog.setState({ open: true, section: null, closeGuard: null });
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<SettingsDialog />));
  await act(async () => host.querySelector<HTMLButtonElement>('#settings-tab-about')!.click());
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  useWorkspace.setState(original, true);
  usePreferences.setState(preferences, true);
});
const button = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Add Getting started page")!;

it("creates the checklist in the current workspace, refreshes the tree and opens the page", async () => {
  vi.mocked(seedGettingStarted).mockResolvedValue({ id: "new-starter" } as Page);
  await act(async () => button().click());
  expect(seedGettingStarted).toHaveBeenCalledWith("current-workspace");
  expect(reload).toHaveBeenCalledOnce();
  expect(select).toHaveBeenCalledWith("new-starter");
  expect(useSettingsDialog.getState().open).toBe(false);
});

it("keeps settings open and reports a creation failure", async () => {
  vi.mocked(seedGettingStarted).mockRejectedValue(new Error("Could not create the page."));
  await act(async () => button().click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not create the page.");
  expect(button().disabled).toBe(false);
  expect(select).not.toHaveBeenCalled();
  expect(useSettingsDialog.getState().open).toBe(true);
});

it("disables creation when no workspace is open", async () => {
  await act(async () => useWorkspace.setState({ workspace: null }));
  expect(button().disabled).toBe(true);
});

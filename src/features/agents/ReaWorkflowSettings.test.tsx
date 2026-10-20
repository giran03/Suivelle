// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReaWorkflowStatus } from "./types";

const ipc = vi.hoisted(() => ({ reaWorkflowStatus: vi.fn(), reaWorkflowInstall: vi.fn() }));
vi.mock("../../lib/ipc", () => ({ ipc, toAppError: (e: unknown) => ({ message: String(e) }) }));
vi.mock("../../lib/access", () => ({ READ_ONLY: false }));
import { ReaWorkflowSettings } from "./ReaWorkflowSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const initial: ReaWorkflowStatus = { bundledVersion: "1.0.0", installedVersion: null, installed: false, current: false, path: "C:/Users/me/.agents/skills/rea-workflow", backups: [] };
beforeEach(() => {
  vi.resetAllMocks();
  ipc.reaWorkflowStatus.mockResolvedValue(initial);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(jevAvailable = false) { await act(async () => root.render(<ReaWorkflowSettings jevAvailable={jevAvailable} />)); }
const button = () => host.querySelector("button")!;

it("installs without Jev or an API key only after a click", async () => {
  await render();
  expect(host.textContent).toContain("No Jev key is needed");
  expect(host.textContent).toContain("Jev-assisted review is off");
  expect(button().textContent).toBe("Install REA workflow");
  expect(button().disabled).toBe(false);
  expect(ipc.reaWorkflowInstall).not.toHaveBeenCalled();
  ipc.reaWorkflowInstall.mockResolvedValue({ ...initial, installed: true, current: true, installedVersion: "1.0.0" });
  await act(async () => button().click());
  expect(ipc.reaWorkflowInstall).toHaveBeenCalledWith();
  expect(button().disabled).toBe(true);
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Nothing has been started");
});

it("offers an update for an existing workflow and reports backups", async () => {
  ipc.reaWorkflowStatus.mockResolvedValue({ ...initial, installed: true });
  ipc.reaWorkflowInstall.mockResolvedValue({ ...initial, installed: true, current: true, installedVersion: "1.0.0", backups: ["old.Suivelle-backup"] });
  await render(true);
  expect(button().textContent).toBe("Update REA workflow");
  expect(host.textContent).toContain("separately connected review integration");
  await act(async () => button().click());
  expect(host.textContent).toContain("1 previous file backed up");
  await render(false);
  expect(host.textContent).toContain("Turning Jev off keeps installed files");
  expect(button().textContent).toBe("Workflow up to date");
  expect(ipc.reaWorkflowInstall).toHaveBeenCalledTimes(1);
});

it("shows installation errors and allows retry", async () => {
  ipc.reaWorkflowInstall.mockRejectedValue(new Error("Access denied"));
  await render();
  await act(async () => button().click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Access denied");
  expect(button().disabled).toBe(false);
  ipc.reaWorkflowInstall.mockResolvedValue({ ...initial, installed: true, current: true, installedVersion: "1.0.0" });
  await act(async () => button().click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("keeps the install button busy until the operation completes", async () => {
  let finish!: (s: ReaWorkflowStatus) => void;
  ipc.reaWorkflowInstall.mockReturnValue(new Promise<ReaWorkflowStatus>((resolve) => { finish = resolve; }));
  await render();
  await act(async () => button().click());
  expect(button().disabled).toBe(true);
  expect(button().textContent).toBe("Installing…");
  await act(async () => finish({ ...initial, installed: true, current: true, installedVersion: "1.0.0" }));
  expect(button().textContent).toBe("Workflow up to date");
});

it("retries a failed status check without starting installation", async () => {
  ipc.reaWorkflowStatus.mockRejectedValueOnce(new Error("Cannot read workflow"));
  await render();
  expect(button().textContent).toBe("Check again");
  await act(async () => button().click());
  expect(button().textContent).toBe("Install REA workflow");
  expect(ipc.reaWorkflowInstall).not.toHaveBeenCalled();
});

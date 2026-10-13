// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BackupsDialog } from "./BackupsDialog";
import { useBackupsDialog } from "./store";
import { useWorkspace } from "../../stores/workspace";
import { ipc } from "../../lib/ipc";

vi.mock("../../lib/dialog", () => ({ syncDialog: () => undefined }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { useBackupsDialog.getState().hide(); vi.restoreAllMocks(); });

it("validates retention, persists it without changing the schedule, and reports save failures", async () => {
  vi.spyOn(ipc, "backupList").mockResolvedValue([]);
  const save = vi.spyOn(ipc, "backupSetAuto").mockRejectedValue(new Error("Cannot save backup settings"));
  useWorkspace.setState({ settings: { theme: "system", autoBackup: true, backupKeep: 3 } });
  useBackupsDialog.getState().show();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<BackupsDialog />));
    const input = host.querySelector<HTMLInputElement>("#backup-keep")!;
    expect(input.value).toBe("3");
    for (const invalid of ["", "0", "1.5", "1001"]) {
      input.value = invalid;
      expect(input.checkValidity()).toBe(false);
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "7");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.checkValidity()).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(save).toHaveBeenCalledWith(undefined, 7);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Cannot save");
    expect(useWorkspace.getState().settings.backupKeep).toBe(3);
    save.mockResolvedValue([]);
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain("limit saved");
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
});

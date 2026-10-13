import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFlusher } from "../editor/flushRegistry";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), drain: vi.fn(), showSettings: vi.fn(), hideSettings: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class { onmessage = () => undefined; } }));
vi.mock("../../stores/workspace", () => ({ useWorkspace: { getState: () => ({ workspaceBusy: false }) } }));
vi.mock("../settings/store", () => ({ useSettingsDialog: { getState: () => ({ open: true, show: mocks.showSettings, hide: mocks.hideSettings }) } }));
vi.mock("../../lib/ipc", () => ({ waitForPendingIpc: mocks.drain, toAppError: (e: unknown) => ({ message: e instanceof Error ? e.message : String(e) }) }));
import { useUpdates, type UpdateSnapshot } from "./store";

const baseline = (): UpdateSnapshot => ({
  installed: { version: "0.1.0", date: "2026-10-11", notes: "Installed" },
  available: { version: "0.2.0", date: "2026-10-12", notes: "New release" },
  preferences: { autoCheck: true, autoDownload: true }, lastCheck: null,
  ready: true, pendingChangelog: false, unsupported: null, recoveryBackup: null, installationFailed: false,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.drain.mockResolvedValue(undefined);
  vi.stubGlobal("document", { querySelector: () => null });
  useUpdates.setState({ snapshot: baseline(), phase: "idle", error: null, changelog: null, notice: false });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("safe update flow", () => {
  it("saves every editor and drains outstanding IPC before installer preparation", async () => {
    const order: string[] = [];
    const unregister = registerFlusher(async () => { order.push("save"); });
    mocks.drain.mockImplementation(async () => { order.push("drain"); });
    mocks.invoke.mockImplementation(async (command: string) => {
      order.push(command);
      throw new Error("Backup failed: disk is full");
    });
    try {
      await useUpdates.getState().install();
      expect(order).toEqual(["save", "drain", "save", "drain", "update_install"]);
      expect(useUpdates.getState().phase).toBe("idle");
      expect(useUpdates.getState().error).toContain("Backup failed");
      expect(mocks.showSettings).toHaveBeenCalledWith("updates");
    } finally { unregister(); }
  });
  it("never calls the installer when saving fails", async () => {
    const unregister = registerFlusher(async () => { throw new Error("Unsaved editor"); });
    try {
      await useUpdates.getState().install();
      expect(mocks.invoke).not.toHaveBeenCalled();
      expect(mocks.drain).not.toHaveBeenCalled();
      expect(useUpdates.getState().snapshot?.ready).toBe(true);
      expect(useUpdates.getState().error).toBe("Unsaved editor");
    } finally { unregister(); }
  });
  it("refuses installer handoff when another dialog is active", async () => {
    vi.stubGlobal("document", { querySelector: () => ({ open: true }) });
    await useUpdates.getState().install();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(useUpdates.getState().error).toContain("Finish the current dialog");
  });
  it("keeps a failed signature/download out of the ready state", async () => {
    useUpdates.setState({ snapshot: { ...baseline(), ready: false } });
    mocks.invoke.mockRejectedValue(new Error("Signature verification failed"));
    await useUpdates.getState().download();
    expect(useUpdates.getState().snapshot?.ready).toBe(false);
    expect(useUpdates.getState().error).toContain("Signature");
    await useUpdates.getState().install();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it("deduplicates checks and honors the automatic download setting", async () => {
    useUpdates.setState({ snapshot: { ...baseline(), ready: false, available: null } });
    let finish!: (value: UpdateSnapshot) => void;
    mocks.invoke.mockImplementation(() => new Promise<UpdateSnapshot>((resolve) => { finish = resolve; }));
    const check = useUpdates.getState().check(true);
    await useUpdates.getState().check(true);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    finish({ ...baseline(), ready: false, preferences: { autoCheck: true, autoDownload: false } });
    await check;
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(useUpdates.getState().phase).toBe("idle");
  });
  it("downloads automatically without invoking installation", async () => {
    useUpdates.setState({ snapshot: { ...baseline(), ready: false, available: null } });
    mocks.invoke.mockImplementation(async (command: string) => ({ ...baseline(), ready: command === "update_download" }));
    await useUpdates.getState().check(true);
    expect(mocks.invoke.mock.calls.map(([name]) => name)).toEqual(["update_check", "update_download"]);
    expect(useUpdates.getState().snapshot?.ready).toBe(true);
  });
  it("retains a queued changelog when its presentation cannot be persisted", async () => {
    useUpdates.setState({ snapshot: { ...baseline(), pendingChangelog: true } });
    mocks.invoke.mockRejectedValue(new Error("Could not save presentation"));
    await useUpdates.getState().acknowledge();
    expect(useUpdates.getState().snapshot?.pendingChangelog).toBe(true);
  });
});

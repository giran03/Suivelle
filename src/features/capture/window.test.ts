import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => unknown>(),
  emitTo: vi.fn(async () => undefined),
  unlisten: vi.fn(),
  capture: vi.fn(async () => null as string | null),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    emitTo: bridge.emitTo,
    listen: async (name: string, callback: (event: { payload: unknown }) => unknown) => {
      bridge.listeners.set(name, callback);
      return () => { bridge.listeners.delete(name); bridge.unlisten(name); };
    },
  }),
}));
vi.mock("./capture", () => ({ capture: bridge.capture }));

import { useWorkspace } from "../../stores/workspace";
import { useUpdates } from "../updates/store";
import { installCaptureWindowBridge, saveWindowCapture } from "./window";
import type { Page } from "../../types";
import { useThemes } from "../settings/themes";
import { emptyTheme } from "../settings/theme";

let stop: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  bridge.listeners.clear();
  bridge.capture.mockResolvedValue(null);
  useWorkspace.setState({ ready: true, workspaceBusy: false, view: "page", selectedPage: { title: "My page", kind: "page" } as Page });
  useUpdates.setState({ phase: "idle" });
});
afterEach(() => { stop?.(); stop = undefined; });

describe("standalone quick capture", () => {
  it("sends the main workspace context to the popup and cleans up listeners", async () => {
    stop = await installCaptureWindowBridge();
    await bridge.listeners.get("capture-ready")!({ payload: null });
    expect(bridge.emitTo).toHaveBeenCalledWith("quick-capture", "capture-context", expect.objectContaining({ page: { title: "My page" }, ready: true }));
    useWorkspace.setState({ workspaceBusy: true });
    expect(bridge.emitTo).toHaveBeenLastCalledWith("quick-capture", "capture-context", expect.objectContaining({ ready: false }));
    stop(); stop = undefined;
    expect(bridge.listeners.size).toBe(0);
  });

  it("uses the existing capture path and returns save failures to the popup", async () => {
    stop = await installCaptureWindowBridge();
    bridge.capture.mockResolvedValue("disk full");
    await bridge.listeners.get("capture-save")!({ payload: { id: "request", text: "Remember this", todo: true, target: "page" } });
    expect(bridge.capture).toHaveBeenCalledWith("Remember this", { todo: true, target: "page" });
    expect(bridge.emitTo).toHaveBeenLastCalledWith("quick-capture", "capture-result", { id: "request", error: "disk full" });
    useWorkspace.setState({ workspaceBusy: true });
    bridge.capture.mockClear();
    await bridge.listeners.get("capture-save")!({ payload: { id: "blocked", text: "x", todo: false, target: "inbox" } });
    expect(bridge.capture).not.toHaveBeenCalled();
    expect(bridge.emitTo).toHaveBeenLastCalledWith("quick-capture", "capture-result", expect.objectContaining({ id: "blocked", error: expect.any(String) }));
  });
  it("keeps the jot window in sync with theme previews and rollback", async () => {
    stop = await installCaptureWindowBridge();
    const preview = emptyTheme(); preview.palettes.dark.sidebar = "#123456";
    useThemes.getState().setPreview(preview);
    expect(bridge.emitTo).toHaveBeenLastCalledWith("quick-capture", "capture-context", expect.objectContaining({ colors: preview }));
    useThemes.getState().setPreview(null);
    expect(bridge.emitTo).toHaveBeenLastCalledWith("quick-capture", "capture-context", expect.objectContaining({ colors: useThemes.getState().config }));
  });

  it("registers the response listener before submitting and ignores other requests", async () => {
    const pending = saveWindowCapture("A thought", { todo: false, target: "inbox" });
    await vi.waitFor(() => expect(bridge.emitTo).toHaveBeenCalled());
    const [target, event, request] = bridge.emitTo.mock.calls[0] as unknown as [string, string, { id: string }];
    expect([target, event]).toEqual(["main", "capture-save"]);
    const respond = bridge.listeners.get("capture-result")!;
    respond({ payload: { id: "unrelated", error: "ignore me" } });
    respond({ payload: { id: request.id, error: null } });
    expect(await pending).toBeNull();
    expect(bridge.unlisten).toHaveBeenCalledWith("capture-result");
  });
});

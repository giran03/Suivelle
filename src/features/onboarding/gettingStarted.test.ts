import { describe, expect, it, vi } from "vitest";
import type { Page } from "../../types";

const ipc = vi.hoisted(() => ({
  pageCreate: vi.fn(),
  blockList: vi.fn(),
  blockApplyBatch: vi.fn(),
  pageGet: vi.fn(),
  attachmentImportBytes: vi.fn(),
}));
vi.mock("../../lib/ipc", async (original) => ({ ...(await original<typeof import("../../lib/ipc")>()), ipc }));

import { GETTING_STARTED, seedGettingStarted } from "./gettingStarted";

describe("getting started", () => {
  it("creates a structured onboarding page with checklist items and imports tour screenshots when available", async () => {
    ipc.pageCreate.mockResolvedValue({ id: "p1", workspaceId: "w1", title: "Getting started", kind: "page", deletedAt: null } as Page);
    ipc.blockList.mockResolvedValue([]);
    ipc.blockApplyBatch.mockResolvedValue(undefined);
    ipc.pageGet.mockResolvedValue({ id: "p1" });
    ipc.attachmentImportBytes.mockImplementation(async (_ws: string, name: string) => ({
      id: `att-${name}`,
      workspaceId: "w1",
      hash: `hash-${name}`,
      originalName: name,
      mimeType: "image/png",
      size: 128,
      createdAt: "2026-01-01T00:00:00Z",
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    } as Response);

    const page = await seedGettingStarted("w1");
    expect(page.id).toBe("p1");
    expect(ipc.pageCreate).toHaveBeenCalledWith("w1", null, "Getting started");
    const batch = ipc.blockApplyBatch.mock.calls[0][0];
    const types = batch.upserts.map((b: { type: string }) => b.type);
    expect(types).toContain("callout");
    expect(types).toContain("heading_2");
    expect(types).toContain("toggle");
    expect(types.filter((t: string) => t === "todo")).toHaveLength(GETTING_STARTED.filter((i) => i.todo).length);
    expect(types.filter((t: string) => t === "image")).toHaveLength(3);

    fetchSpy.mockRestore();
  });

  it("falls back to captions cleanly if screenshot import is unavailable", async () => {
    ipc.pageCreate.mockResolvedValue({ id: "p2", workspaceId: "w1", title: "Getting started", kind: "page", deletedAt: null } as Page);
    ipc.blockList.mockResolvedValue([]);
    ipc.blockApplyBatch.mockClear();
    ipc.pageGet.mockResolvedValue({ id: "p2" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await seedGettingStarted("w1");
    const batch = ipc.blockApplyBatch.mock.calls[0][0];
    const types = batch.upserts.map((b: { type: string }) => b.type);
    expect(types).not.toContain("image");
    expect(types).toContain("callout");

    fetchSpy.mockRestore();
  });
});

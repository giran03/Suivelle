import { describe, expect, it, vi } from "vitest";
import type { Page } from "../../types";

const ipc = vi.hoisted(() => ({ pageCreate: vi.fn(), blockList: vi.fn(), blockApplyBatch: vi.fn(), pageGet: vi.fn() }));
vi.mock("../../lib/ipc", async (original) => ({ ...(await original<typeof import("../../lib/ipc")>()), ipc }));

import { GETTING_STARTED, seedGettingStarted } from "./gettingStarted";

describe("getting started", () => {
  it("creates one page holding the checklist, to-dos where there is something to try", async () => {
    ipc.pageCreate.mockResolvedValue({ id: "p1", workspaceId: "w1", title: "Getting started", kind: "page", deletedAt: null } as Page);
    ipc.blockList.mockResolvedValue([]);
    ipc.blockApplyBatch.mockResolvedValue(undefined);
    ipc.pageGet.mockResolvedValue({ id: "p1" });
    const page = await seedGettingStarted("w1");
    expect(page.id).toBe("p1");
    expect(ipc.pageCreate).toHaveBeenCalledWith("w1", null, "Getting started");
    const batch = ipc.blockApplyBatch.mock.calls[0][0];
    expect(batch.upserts).toHaveLength(GETTING_STARTED.length);
    expect(batch.upserts.filter((b: { type: string }) => b.type === "todo")).toHaveLength(GETTING_STARTED.filter((i) => i.todo).length);
  });
});

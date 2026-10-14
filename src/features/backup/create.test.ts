import { afterEach, expect, it, vi } from "vitest";
import { createSavedBackup } from "./create";
import { registerFlusher } from "../editor/flushRegistry";
import { ipc } from "../../lib/ipc";
afterEach(() => vi.restoreAllMocks());

it("saves all editors before one shared backup and refuses failed saves", async () => {
  const calls: string[] = [];
  const unregister = registerFlusher(async () => { calls.push("save"); });
  const backup = vi.spyOn(ipc, "backupCreate").mockImplementation(async () => { calls.push("backup"); return {} as Awaited<ReturnType<typeof ipc.backupCreate>>; });
  try {
    const first = createSavedBackup();
    expect(createSavedBackup()).toBe(first);
    await first;
    expect(calls).toEqual(["save", "backup"]);
  } finally { unregister(); }
  const failed = registerFlusher(async () => { throw new Error("Unsaved changes"); });
  try { await expect(createSavedBackup()).rejects.toThrow("Unsaved changes"); expect(backup).toHaveBeenCalledTimes(1); }
  finally { failed(); }
});

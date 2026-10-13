import { afterEach, describe, expect, test, vi } from "vitest";

describe("safe mode", () => {
  afterEach(() => { globalThis.__SUIVELLE_SAFE_MODE__ = undefined; vi.resetModules(); });

  test("a normal start stays editable", async () => {
    const access = await import("./access");
    expect(access.SAFE_MODE).toBe(false);
    expect(access.READ_ONLY).toBe(false);
    expect(access.READ_ONLY_COMMANDS.has("backups")).toBe(false);
  });

  test("a failed check opens read-only but keeps backups and export reachable", async () => {
    globalThis.__SUIVELLE_SAFE_MODE__ = "integrity check failed: page 4 is never used";
    const access = await import("./access");
    const { safeModeReason } = await import("./safeMode");
    expect(access.READ_ONLY).toBe(true);
    for (const id of ["backups", "export", "export-workspace"]) expect(access.READ_ONLY_COMMANDS.has(id)).toBe(true);
    expect(access.READ_ONLY_COMMANDS.has("new-page")).toBe(false);
    expect(safeModeReason()).toMatch(/integrity/);
  });
});

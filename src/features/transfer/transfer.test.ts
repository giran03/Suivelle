import { describe, expect, it, vi } from "vitest";
import { COLUMN_KINDS, exportWorkspaceArchive, importedWorkspaceName, plural, summarize } from "./transfer";
import { ipc } from "../../lib/ipc";
import { registerFlusher } from "../editor/flushRegistry";

describe("import summaries", () => {
  it("describes what an import contains", () => {
    expect(summarize({ pages: 3, databases: 1, records: 6, attachments: 2 })).toBe("3 pages, 1 database with 6 records and 2 attachments");
    expect(summarize({ pages: 1, databases: 0, records: 0, attachments: 0 })).toBe("1 page");
    expect(summarize({ pages: 0, databases: 2, records: 1, attachments: 0 })).toBe("2 databases with 1 record");
    expect(summarize({ pages: 0, databases: 0, records: 0, attachments: 0 })).toBe("nothing");
    expect(plural(1234, "file", "files")).toBe((1234).toLocaleString() + " files");
  });

  it("offers every column type the backend understands, and a way to leave one out", () => {
    const values = COLUMN_KINDS.map((k) => k.value);
    for (const v of ["text", "number", "select", "multi_select", "date", "checkbox", "url", "email", "phone", "skip"]) expect(values).toContain(v);
    expect(values).not.toContain("title");
  });
});

describe("workspace transfer", () => {
  it("suggests separate names without collisions, including repeated and long names", () => {
    expect(importedWorkspaceName("Studio", ["studio", "Studio (imported)"])).toBe("Studio (imported 2)");
    expect(importedWorkspaceName("", [])).toBe("Imported workspace");
    expect([...importedWorkspaceName("🌟".repeat(200), ["🌟".repeat(200)])].length).toBeLessThanOrEqual(200);
  });

  it("saves edits before exporting and refuses export if a save fails", async () => {
    const order: string[] = [];
    const exporter = vi.spyOn(ipc, "exportWorkspace").mockImplementation(async () => { order.push("export"); return null; });
    let unregister = registerFlusher(async () => { order.push("save"); });
    try {
      await exportWorkspaceArchive("workspace");
      expect(order).toEqual(["save", "export"]);
      unregister(); exporter.mockClear();
      unregister = registerFlusher(async () => { throw new Error("Save failed"); });
      await expect(exportWorkspaceArchive("workspace")).rejects.toThrow("Save failed");
      expect(exporter).not.toHaveBeenCalled();
    } finally { unregister(); exporter.mockRestore(); }
  });
});

import { describe, expect, it, vi } from "vitest";
import { COLUMN_KINDS, DEFAULT_EXPORT, columnKinds, defaultTarget, describeOrigin, effectiveOptions, exportWorkspaceArchive, importedWorkspaceName, plural, savesText, summarize } from "./transfer";
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

describe("Notion transfer", () => {
  const shape = (s: Partial<import("../../types").ExportShape> = {}): import("../../types").ExportShape => ({ kind: "page", title: "Plan", needsFolder: false, hasChildren: true, hasDatabases: false, files: 1, ...s });

  it("keeps a PDF to one page and a database out of PDF", () => {
    const pdf = effectiveOptions({ ...DEFAULT_EXPORT, format: "pdf" }, "page");
    expect(pdf.includeSubpages).toBe(false);
    expect(pdf.folders).toBe(false);
    expect(effectiveOptions({ ...DEFAULT_EXPORT, format: "pdf" }, "database").format).toBe("markdown");
    expect(effectiveOptions({ ...DEFAULT_EXPORT, includeSubpages: false }, "page").folders).toBe(false);
    expect(effectiveOptions(DEFAULT_EXPORT, "page")).toEqual(DEFAULT_EXPORT);
  });

  it("says what an export saves", () => {
    expect(savesText(shape({ needsFolder: true, files: 12 }), DEFAULT_EXPORT)).toBe("Saves a zip of 12 files and the files they show.");
    expect(savesText(shape(), { ...DEFAULT_EXPORT, format: "pdf" })).toBe("Saves the page as one PDF file.");
    expect(savesText(shape({ kind: "database" }), DEFAULT_EXPORT)).toBe("Saves the table as one CSV file.");
    expect(savesText(shape(), { ...DEFAULT_EXPORT, format: "html" })).toBe("Saves the page as one HTML file.");
  });

  it("sends a whole Notion workspace to a workspace of its own", () => {
    const origin = { kind: "notion" as const, format: "markdown" as const, layout: "folders" as const, workspace: true, name: "Acme" };
    expect(defaultTarget(origin)).toBe("workspace");
    expect(defaultTarget({ ...origin, workspace: false })).toBe("container");
    expect(defaultTarget(null)).toBe("container");
    expect(describeOrigin(origin)).toBe("Markdown & CSV, subpages in folders");
    expect(describeOrigin({ ...origin, format: "html", layout: "flat" })).toBe("HTML, subpages nested by their links");
  });

  it("keeps a relation's links on offer, and the usual types", () => {
    expect(columnKinds("relation")[0].value).toBe("relation");
    expect(columnKinds("relation").map((k) => k.value)).toContain("text");
    expect(columnKinds("text").map((k) => k.value)).not.toContain("relation");
    expect(columnKinds("status")[0].value).toBe("status");
  });
});

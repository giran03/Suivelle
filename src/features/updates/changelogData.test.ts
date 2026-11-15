import { describe, expect, it } from "vitest";
import { CHANGELOG, compareVersions, parseChangelog } from "./changelogData";

describe("changelog parsing", () => {
  it("reads the version, release line, groups and bullets, joining wrapped lines", () => {
    const entry = parseChangelog("# Suivelle 0.1.7\n\nReleased October 21, 2026.\n\n## Editor\n\n- First **bold** item\n  continued here\n- Second\n\n## Settings\n\n- Third\n")!;
    expect(entry.version).toBe("0.1.7");
    expect(entry.released).toBe("Released October 21, 2026");
    expect(entry.unreleased).toBe(false);
    expect(entry.groups.map((g) => g.title)).toEqual(["Editor", "Settings"]);
    expect(entry.groups[0].items).toEqual(["First **bold** item continued here", "Second"]);
  });
  it("marks a version still in development", () => {
    const entry = parseChangelog("# Suivelle 0.1.8\n\nUnreleased.\n\n## Improvements\n\n- One\n")!;
    expect(entry.unreleased).toBe(true);
    expect(entry.released).toBeNull();
  });
  it("ignores a file with no version", () => {
    expect(parseChangelog("# Notes\n\n- nothing")).toBeNull();
  });
  it("orders versions numerically, not alphabetically", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
  });
  it("bundles the archived changelogs, newest first", () => {
    expect(CHANGELOG.length).toBeGreaterThan(3);
    for (let i = 1; i < CHANGELOG.length; i++) expect(compareVersions(CHANGELOG[i - 1].version, CHANGELOG[i].version)).toBeGreaterThan(0);
  });
});

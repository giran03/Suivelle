// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyScore } from "./fuzzy";
import { frecency, recordUse } from "./frecency";
import { isNativeBrowserKey } from "./nativeKeys";

describe("fuzzy matching", () => {
  it("prefers whole-word and prefix matches over scattered letters", () => {
    expect(fuzzyScore("dark", "Switch to dark theme")!).toBeGreaterThan(fuzzyScore("dtm", "Switch to dark theme") ?? 0);
    expect(fuzzyScore("sw", "Switch to dark theme")!).toBeGreaterThan(fuzzyScore("itch", "Switch to dark theme")!);
  });
  it("finds letters in order within a short stretch, but not across a whole title", () => {
    expect(fuzzyScore("swdk", "Switch to dark theme")).toBeNull();
    expect(fuzzyScore("swtch", "Switch to dark theme")).not.toBeNull();
    expect(fuzzyScore("zzz", "Switch to dark theme")).toBeNull();
    expect(fuzzyScore("ab", "xaxb")).toBeNull();
  });
  it("needs every word to match, and weighs the title above the keywords", () => {
    expect(fuzzyMatch("dark mode", "Switch to dark theme", "appearance mode")).not.toBeNull();
    expect(fuzzyMatch("dark nothing", "Switch to dark theme", "appearance")).toBeNull();
    expect(fuzzyMatch("backup", "Backup now", "")!).toBeGreaterThan(fuzzyMatch("backup", "Settings", "backup")!);
  });
});

describe("frecency", () => {
  beforeEach(() => localStorage.clear());
  it("rises with use and halves over a week", () => {
    const t0 = 1_000_000_000_000;
    expect(frecency("a", t0)).toBe(0);
    recordUse("a", t0); recordUse("a", t0);
    expect(frecency("a", t0)).toBeCloseTo(2);
    expect(frecency("a", t0 + 7 * 24 * 3600 * 1000)).toBeCloseTo(1);
  });
  it("survives unreadable storage", () => {
    localStorage.setItem("suivelle.frecency.v1", "not json");
    expect(frecency("a")).toBe(0);
    expect(() => recordUse("a")).not.toThrow();
  });
});

describe("browser shortcuts that must not fire", () => {
  const key = (k: string, o: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
  it("blocks print, save, view source, reload and the function keys", () => {
    for (const k of ["p", "s", "u", "r", "o"]) expect(isNativeBrowserKey(key(k, { ctrlKey: true }))).toBe(true);
    expect(isNativeBrowserKey(key("P", { ctrlKey: true, shiftKey: true }))).toBe(true);
    for (const k of ["F5", "F3", "F7"]) expect(isNativeBrowserKey(key(k))).toBe(true);
  });
  it("leaves editing and app keys alone", () => {
    for (const k of ["c", "v", "x", "a", "z", "b", "i"]) expect(isNativeBrowserKey(key(k, { ctrlKey: true }))).toBe(false);
    expect(isNativeBrowserKey(key("p"))).toBe(false);
    expect(isNativeBrowserKey(key("p", { ctrlKey: true, altKey: true }))).toBe(false);
  });
});

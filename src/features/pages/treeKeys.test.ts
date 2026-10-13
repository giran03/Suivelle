import { describe, expect, it } from "vitest";
import { matchRow, nextRow, parentRow } from "./treeKeys";

describe("nextRow", () => {
  it("moves one row at a time and stops at the ends", () => {
    expect(nextRow("ArrowDown", 0, 3)).toBe(1);
    expect(nextRow("ArrowDown", 2, 3)).toBe(2);
    expect(nextRow("ArrowUp", 2, 3)).toBe(1);
    expect(nextRow("ArrowUp", 0, 3)).toBe(0);
  });

  it("jumps with Home and End", () => {
    expect(nextRow("Home", 2, 5)).toBe(0);
    expect(nextRow("End", 0, 5)).toBe(4);
  });

  it("ignores other keys, an empty list and an unknown starting row", () => {
    expect(nextRow("a", 0, 3)).toBeNull();
    expect(nextRow("ArrowDown", 0, 0)).toBeNull();
    expect(nextRow("ArrowDown", -1, 3)).toBeNull();
  });
});

describe("matchRow", () => {
  const labels = ["Meeting notes", "Roadmap", "Risks", "Launch plan", "Roadmap v2"];
  it("finds the next title that starts with the letter, wrapping round", () => {
    expect(matchRow(labels, 0, "r")).toBe(1);
    expect(matchRow(labels, 1, "r")).toBe(2);
    expect(matchRow(labels, 4, "m")).toBe(0);
  });
  it("narrows on a longer prefix and may keep the current row", () => {
    expect(matchRow(labels, 1, "road")).toBe(1);
    expect(matchRow(labels, 0, "road")).toBe(1);
    expect(matchRow(labels, 1, "roadmap v")).toBe(4);
  });
  it("cycles on a repeated letter, ignores case, and gives up when nothing matches", () => {
    expect(matchRow(labels, 1, "rr")).toBe(2);
    expect(matchRow(labels, 0, "L")).toBe(3);
    expect(matchRow(labels, 0, "z")).toBeNull();
  });
});

describe("parentRow", () => {
  //            A  B  b1 b2 c  C  c1
  const levels = [1, 1, 2, 2, 3, 1, 2];
  it("is the nearest row above with a shallower level", () => {
    expect(parentRow(levels, 2)).toBe(1);
    expect(parentRow(levels, 3)).toBe(1);
    expect(parentRow(levels, 4)).toBe(3);
    expect(parentRow(levels, 6)).toBe(5);
  });
  it("is -1 for a top-level row", () => {
    expect(parentRow(levels, 0)).toBe(-1);
    expect(parentRow(levels, 5)).toBe(-1);
  });
});

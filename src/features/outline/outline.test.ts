import { describe, expect, it } from "vitest";
import { textStats } from "./OutlinePanel";

describe("page statistics", () => {
  it("counts words, characters without spaces and reading time", () => {
    expect(textStats("")).toEqual({ words: 0, characters: 0, minutes: 0 });
    expect(textStats("  One two\nthree  ")).toEqual({ words: 3, characters: 11, minutes: 1 });
    expect(textStats(Array(690).fill("word").join(" ")).minutes).toBe(3);
  });
});

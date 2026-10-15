import { describe, expect, it } from "vitest";
import { lineDiff, withContext } from "./diff";

describe("lineDiff", () => {
  it("marks added, removed and unchanged lines", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
  });

  it("treats an empty side as all added or removed", () => {
    expect(lineDiff("", "x").filter((l) => l.kind !== "same")).toEqual([{ kind: "del", text: "" }, { kind: "add", text: "x" }]);
    expect(lineDiff("same", "same")).toEqual([{ kind: "same", text: "same" }]);
  });

  it("collapses long unchanged runs", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "line ten");
    const shown = withContext(lineDiff(before, after), 1);
    expect(shown[0]).toBeNull();
    expect(shown.filter((l) => l && l.kind !== "same")).toHaveLength(2);
    expect(shown[shown.length - 1]).toBeNull();
  });
});

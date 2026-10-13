import { describe, expect, it } from "vitest";
import { clicked, inOrder, topLevel } from "./pageSelection";

const order = ["a", "b", "c", "d", "e"];
const none = { ids: [], anchor: null };

describe("Ctrl+click", () => {
  it("adds a page and removes it again", () => {
    const one = clicked(none, order, "b", "toggle", null);
    expect(one).toEqual({ ids: ["b"], anchor: "b" });
    const two = clicked(one, order, "d", "toggle", null);
    expect(two.ids).toEqual(["b", "d"]);
    expect(clicked(two, order, "b", "toggle", null).ids).toEqual(["d"]);
  });
  it("counts the open page as picked when it starts a selection", () => {
    expect(clicked(none, order, "d", "toggle", "b").ids).toEqual(["b", "d"]);
  });
  it("does not count the open page twice or one that is not on screen", () => {
    expect(clicked(none, order, "b", "toggle", "b").ids).toEqual(["b"]);
    expect(clicked(none, order, "b", "toggle", "zzz").ids).toEqual(["b"]);
  });
});

describe("Shift+click", () => {
  it("picks everything between the anchor and the click, in either direction", () => {
    const start = clicked(none, order, "b", "toggle", null);
    expect(clicked(start, order, "d", "range", null).ids).toEqual(["b", "c", "d"]);
    expect(clicked({ ids: ["d"], anchor: "d" }, order, "b", "range", null).ids).toEqual(["b", "c", "d"]);
  });
  it("keeps the anchor so the range can be changed", () => {
    const first = clicked({ ids: ["b"], anchor: "b" }, order, "e", "range", null);
    expect(first.anchor).toBe("b");
    expect(clicked(first, order, "c", "range", null).ids).toEqual(["b", "c"]);
  });
  it("starts from the open page when nothing is picked", () => {
    expect(clicked(none, order, "c", "range", "a").ids).toEqual(["a", "b", "c"]);
  });
  it("picks just the page when the anchor is not on screen", () => {
    expect(clicked({ ids: ["x"], anchor: "x" }, order, "c", "range", null)).toEqual({ ids: ["c"], anchor: "c" });
  });
});

describe("inOrder and topLevel", () => {
  it("sorts picked ids by their place on screen", () => {
    expect(inOrder(["d", "a", "c"], order)).toEqual(["a", "c", "d"]);
    expect(inOrder(["q", "a"], order)).toEqual(["a", "q"]);
  });
  it("leaves out pages that sit inside another picked page", () => {
    const inside = (a: string, b: string) => a === "a" && (b === "b" || b === "c");
    expect(topLevel(["a", "b", "c", "d"], inside)).toEqual(["a", "d"]);
  });
});

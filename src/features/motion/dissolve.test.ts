import { describe, expect, it } from "vitest";
import { glowLayers, onDark, wordSpans } from "./dissolve";

const ten = (s: string) => s.length * 10;

describe("wordSpans", () => {
  it("places each word along the line and skips the spaces", () => {
    expect(wordSpans("ab cde", ten)).toEqual([
      { x: 0, w: 20 },
      { x: 30, w: 30 },
    ]);
  });
  it("counts leading and repeated spaces as room", () => {
    expect(wordSpans("  a   b", ten)).toEqual([
      { x: 20, w: 10 },
      { x: 60, w: 10 },
    ]);
  });
  it("finds nothing in an empty or blank string", () => {
    expect(wordSpans("", ten)).toEqual([]);
    expect(wordSpans("   ", ten)).toEqual([]);
  });
});

describe("glowLayers", () => {
  const opts = { padLeft: 10, width: 200, rgb: "0,0,0", spread: 1.5 };
  const count = (css: string) => css.split("radial-gradient").length - 1;
  it("draws four streaks per word", () => {
    expect(count(glowLayers([{ x: 0, w: 40 }], opts))).toBe(4);
    expect(count(glowLayers([{ x: 0, w: 40 }, { x: 60, w: 30 }], opts))).toBe(8);
  });
  it("centres the first streak under the middle of the word, as a percentage of the field", () => {
    // padLeft 10 + x 0 + half of 40 = 30px of a 200px field
    expect(glowLayers([{ x: 0, w: 40 }], opts)).toContain("at 15.00% 100%");
  });
  it("uses the colour it is given", () => {
    expect(glowLayers([{ x: 0, w: 40 }], { ...opts, rgb: "255,255,255" })).toContain("rgba(255,255,255,");
  });
  it("is empty when there are no words", () => {
    expect(glowLayers([], opts)).toBe("");
  });
});

describe("onDark", () => {
  it("treats light text as sitting on a dark surface", () => {
    expect(onDark("rgb(236, 236, 242)")).toBe(true);
    expect(onDark("rgb(21, 27, 46)")).toBe(false);
  });
  it("says no to a colour it cannot read", () => {
    expect(onDark("transparent")).toBe(false);
  });
});

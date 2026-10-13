import { describe, expect, it } from "vitest";
import { gradientCss, parseCover, parseIcon, GRADIENTS } from "./pageAppearance";

describe("page icon", () => {
  it("reads emoji, line icons and nothing", () => {
    expect(parseIcon("🚀")).toEqual({ kind: "emoji", value: "🚀" });
    expect(parseIcon("icon:star")).toEqual({ kind: "icon", name: "star" });
    expect(parseIcon("")).toBeNull();
    expect(parseIcon(null)).toBeNull();
  });
  it("ignores a line icon that no longer exists", () => {
    expect(parseIcon("icon:not-a-real-icon")).toBeNull();
  });
  it("reads local image icons and rejects malformed attachment references", () => {
    const hash = "a".repeat(64);
    expect(parseIcon(`image:${hash}`)).toEqual({ kind: "image", hash });
    for (const value of ["image:", "image:../file", "image:https://example.com/icon.png", "image:bad"]) expect(parseIcon(value)).toBeNull();
  });
});

describe("page cover", () => {
  it("reads gradients and uploaded images", () => {
    expect(parseCover("gradient:dusk")).toEqual({ kind: "gradient", id: "dusk" });
    expect(parseCover("image:abc123")).toEqual({ kind: "image", hash: "abc123" });
  });
  it("treats empty and unknown values as no cover", () => {
    expect(parseCover("")).toBeNull();
    expect(parseCover(undefined)).toBeNull();
    expect(parseCover("gradient:nope")).toBeNull();
    expect(parseCover("something-else")).toBeNull();
  });
  it("falls back to the first gradient for an unknown id", () => {
    expect(gradientCss("nope")).toBe(GRADIENTS[0].css);
  });
});

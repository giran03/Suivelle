import { describe, expect, it } from "vitest";
import { parseTip, placeTip } from "./tipText";

describe("parseTip", () => {
  it("splits a trailing keyboard shortcut from the words", () => {
    expect(parseTip("Bold (Ctrl+B)")).toEqual({ text: "Bold", keys: "Ctrl+B" });
    const bs = String.fromCharCode(92);
    expect(parseTip(`Hide sidebar (Ctrl+${bs})`)).toEqual({ text: "Hide sidebar", keys: `Ctrl+${bs}` });
    expect(parseTip("Clear selection (Esc)")).toEqual({ text: "Clear selection", keys: "Esc" });
  });
  it("leaves other parentheses alone", () => {
    expect(parseTip("Copy link")).toEqual({ text: "Copy link", keys: null });
    expect(parseTip("Notes (draft)")).toEqual({ text: "Notes (draft)", keys: null });
    expect(parseTip("(Ctrl+B)")).toEqual({ text: "(Ctrl+B)", keys: null });
  });
});

describe("placeTip", () => {
  const view = { width: 800, height: 600 };
  const tip = { width: 100, height: 28 };
  it("sits centred above the trigger", () => {
    expect(placeTip({ left: 300, top: 300, width: 40, height: 28 }, tip, view)).toEqual({ x: 270, y: 264, side: "above" });
  });
  it("drops below when there is no room above", () => {
    const p = placeTip({ left: 300, top: 10, width: 40, height: 28 }, tip, view);
    expect(p.side).toBe("below");
    expect(p.y).toBe(46);
  });
  it("stays inside the viewport at the edges", () => {
    expect(placeTip({ left: 0, top: 300, width: 20, height: 28 }, tip, view).x).toBe(6);
    expect(placeTip({ left: 790, top: 300, width: 20, height: 28 }, tip, view).x).toBe(694);
  });
});

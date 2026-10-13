// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { hexToHsv, hexToRgb, hsvToHex, normalizeHex, recentColors, rememberColor } from "./color";
import { workspaceColor, workspaceOptions } from "../features/workspaces/model";
beforeEach(() => localStorage.clear());
it("accepts opaque hex and rejects unsafe or translucent saved colors", () => {
  expect(normalizeHex(" #abc ")).toBe("#AABBCC");
  for (const bad of [null, "red", "#abc8", "#12345678", "#gggggg", "var(--bad)", "url(x)"]) expect(normalizeHex(bad)).toBeNull();
  expect(workspaceOptions({ settingsJson: '{"accent":"#abc"}' }).accent).toBe("#AABBCC");
  expect(workspaceOptions({ settingsJson: '{"accent":"url(x)"}' }).accent).toBe("violet");
  expect(workspaceColor("blue")).toBe("var(--tone-blue)");
});
it("preserves RGB values through hue, saturation and brightness edits", () => {
  for (const color of ["#000000", "#FFFFFF", "#808080", "#FF0000", "#00FF00", "#0000FF", "#123ABC", "#EF23AB"]) {
    expect(hsvToHex(...hexToHsv(color))).toBe(color);
    expect(hexToRgb(color)).toHaveLength(3);
  }
});
it("keeps twelve distinct committed colors and tolerates corrupt local history", () => {
  localStorage.setItem("suivelle.recent-colors", '{"bad":true}'); expect(recentColors()).toEqual([]);
  for (let i = 0; i < 14; i++) rememberColor(`#${i.toString(16).padStart(6, "0")}`);
  expect(recentColors()).toHaveLength(12);
  rememberColor("#00000C"); expect(recentColors()[0]).toBe("#00000C"); expect(recentColors()).toHaveLength(12);
  rememberColor("garbage"); expect(recentColors()).toHaveLength(12);
});

it("normalizes alpha hex, preserves opacity endpoints and composites against the underlying surface", async () => {
  const { normalizeHexAlpha, withOpacity, hexOpacity, compositeColor } = await import("./color");
  expect(normalizeHexAlpha("#abc8")).toBe("#AABBCC88");
  expect(normalizeHexAlpha("#12345680")).toBe("#12345680");
  expect(normalizeHexAlpha("rgba(0,0,0,0.5)")).toBeNull();
  expect(withOpacity("#123456", 0)).toBe("#12345600");
  expect(withOpacity("#123456", 1)).toBe("#123456");
  expect(withOpacity("#123456", 0.5)).toBe("#12345680");
  expect(hexOpacity("#12345600")).toBe(0);
  expect(compositeColor("#00000000", "#FFFFFF")).toBe("#FFFFFF");
  expect(compositeColor("#00000080", "#FFFFFF")).toBe("#7F7F7F");
  rememberColor("#12345680"); expect(recentColors()[0]).toBe("#12345680");
});

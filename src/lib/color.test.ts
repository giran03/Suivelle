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

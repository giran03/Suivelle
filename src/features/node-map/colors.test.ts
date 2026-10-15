// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MapNode } from "./model";

const KEY = "suivelle.node-map.analogous.v3";
const BLUE = "#1F66A8", VIOLET = "#6346DC", GREEN = "#2A7348", ORANGE = "#A3540A";
const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const node = (id: string, parentId: string | null, kind: MapNode["kind"] = "page"): MapNode => ({ id, workspaceId: "w", parentId, title: id, kind, icon: null, favorite: false, archived: false, createdAt: "", updatedAt: "", count: 0, recordId: null, databaseId: null, tags: [], values: {} });
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.resetModules(); });

describe("analogous node colors", () => {
  it("fans seven distinct shades around the base hue across a lightness and saturation range", async () => {
    const { analogousPalette, hexToOklch } = await import("./colors");
    const palette = analogousPalette(BLUE);
    expect(new Set(palette).size).toBe(7);
    const [L, C, h] = hexToOklch(BLUE);
    const chroma = palette.map(shade => hexToOklch(shade)[1]);
    for (const shade of palette) {
      const [sl, , sh] = hexToOklch(shade);
      expect(hueGap(sh, h)).toBeLessThan(21);
      expect(Math.abs(sl - L)).toBeLessThan(.09);
    }
    expect(Math.min(...chroma)).toBeLessThan(C * .8);
    expect(Math.max(...chroma)).toBeGreaterThan(C * 1.1);
  });
  it("narrows the fan when another family sits close on the hue wheel", async () => {
    const { analogousPalette, hexToOklch } = await import("./colors");
    const spread = (palette: string[]) => Math.max(...palette.map(s => hueGap(hexToOklch(s)[2], hexToOklch(BLUE)[2])));
    const alone = analogousPalette(BLUE), crowded = analogousPalette(BLUE, [BLUE, VIOLET, GREEN, ORANGE]);
    expect(spread(crowded)).toBeLessThan(spread(alone));
    // Blue's widest shade stays closer to blue than to violet.
    const violet = hexToOklch(VIOLET)[2];
    for (const shade of crowded) expect(hueGap(hexToOklch(shade)[2], hexToOklch(BLUE)[2])).toBeLessThan(hueGap(hexToOklch(shade)[2], violet));
  });
  it("round-trips colours through OKLCH and keeps out-of-gamut shades valid", async () => {
    const { hexToOklch, oklchToHex } = await import("./colors");
    for (const hex of [BLUE, VIOLET, GREEN, ORANGE, "#FFFFFF", "#000000"]) expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    expect(oklchToHex([.7, .5, 145])).toMatch(/^#[0-9A-F]{6}$/);
  });
  it("gives a page tree one shade, independent of node order", async () => {
    const { analogousPalette, nodeTones } = await import("./colors");
    const nodes = [node("w", null, "workspace"), node("root", null), node("child", "root"), node("grandchild", "child"), node("other", null), node("db", "root", "database"), node("row", "db", "record")];
    const palettes = { page: analogousPalette(BLUE), database: analogousPalette(VIOLET), record: analogousPalette(GREEN) };
    const tones = nodeTones(nodes, palettes);
    expect(tones.child).toBe(tones.root);
    expect(tones.grandchild).toBe(tones.root);
    expect(palettes.record).toContain(tones.row);
    expect(tones.w).toBeUndefined();
    expect(nodeTones([...nodes].reverse(), palettes)).toEqual(tones);
  });
  it("survives parent cycles", async () => {
    const { analogousPalette, nodeTones } = await import("./colors");
    const tones = nodeTones([node("a", "b"), node("b", "a")], { page: analogousPalette(BLUE) });
    expect(Object.keys(tones)).toHaveLength(2);
  });
  it("reuses persisted palettes, recovers from damaged storage and stays bounded", async () => {
    const first = await import("./colors");
    const palette = first.analogousPalette(BLUE);
    expect(first.analogousPalette(BLUE.toLowerCase())).toBe(palette);
    vi.resetModules();
    expect((await import("./colors")).analogousPalette(BLUE)).toEqual(palette);
    localStorage.setItem(KEY, JSON.stringify({ [`${BLUE}|18`]: ["invalid"] }));
    vi.resetModules();
    const { analogousPalette } = await import("./colors");
    expect(analogousPalette(BLUE)).toHaveLength(7);
    for (let i = 0; i < 40; i++) analogousPalette(`#${(0x234500 + i).toString(16)}`);
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!))).toHaveLength(32);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    const unsaved = analogousPalette("#123456");
    expect(analogousPalette("#123456")).toBe(unsaved);
  });
});

import { describe, expect, it } from "vitest";
import { CHOICES, densityOf, sanitize, usePreferences, varsFor, type ChoiceKey } from "./preferences";

describe("preferences", () => {
  it("retains custom interface percentages when loading saved preferences", () => {
    for (const uiScale of ["50", "115", "137", "200"]) expect(sanitize({ uiScale }).uiScale).toBe(uiScale);
    expect(sanitize({ uiScale: "0115" }).uiScale).toBe("115");
  });

  it("rejects invalid interface zoom values without replacing the current size", () => {
    const previous = usePreferences.getState().uiScale;
    try {
      usePreferences.getState().set("uiScale", "137");
      for (const uiScale of ["", "0", "49", "201", "115.5", "Infinity", "1e2", "100%", 115]) {
        expect(sanitize({ uiScale }).uiScale).toBe("100");
        if (typeof uiScale === "string") {
          usePreferences.getState().set("uiScale", uiScale);
          expect(usePreferences.getState().uiScale).toBe("137");
        }
      }
    } finally { usePreferences.getState().set("uiScale", previous); }
  });

  it("falls back to the default for missing, old or invalid saved values", () => {
    const c = sanitize({ textSize: "huge", pageWidth: 3, density: "relaxed" });
    expect(c.textSize).toBe("default");
    expect(c.pageWidth).toBe("standard");
    expect(c.density).toBe("relaxed");
    expect(c.pageFont).toBe("sans");
  });

  it("every default is one of its own options", () => {
    for (const k of Object.keys(CHOICES) as ChoiceKey[]) {
      expect(CHOICES[k].options.map((o) => o.id)).toContain(CHOICES[k].fallback);
    }
  });

  it("turns choices into the variables the stylesheets read", () => {
    const vars = varsFor(sanitize({ textSize: "xlarge", pageWidth: "narrow", pageSpacing: "relaxed", pageFont: "serif", density: "compact", accent: "violet" }));
    expect(vars["--doc-size"]).toBe("1.1875rem");
    expect(vars["--page-max"]).toBe("680px");
    expect(vars["--doc-line"]).toBe("1.72");
    expect(vars["--doc-font"]).toContain("serif");
    expect(vars["--density"]).toBe("0.72");
  });

  it("sets the corner radii and line strengths, and leaves the defaults to the stylesheet", () => {
    const sharp = varsFor(sanitize({ corners: "sharp", lines: "clear" }));
    expect(sharp["--r-md"]).toBe("4px");
    expect(sharp["--border"]).toContain("light-dark");
    const plain = varsFor(sanitize({}));
    expect(plain["--r-md"]).toBeUndefined();
    expect(plain["--border"]).toBeUndefined();
  });

  it("makes each interface spacing step clearly different", () => {
    expect(densityOf("normal") / densityOf("compact")).toBeGreaterThan(1.3);
    expect(densityOf("relaxed") / densityOf("normal")).toBeGreaterThan(1.3);
  });

  it("scales rows by the interface spacing", () => {
    expect(densityOf("compact")).toBeLessThan(1);
    expect(densityOf("normal")).toBe(1);
    expect(densityOf("relaxed")).toBeGreaterThan(1);
    expect(densityOf("nonsense")).toBe(1);
  });

  describe("accent colours stay readable", () => {
    const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const pair = (v: string) => {
      const m = /light-dark\((#\w{6}), (#\w{6})\)/.exec(v)!;
      return { light: parse(m[1]), dark: parse(m[2]) };
    };
    // The page and sidebar backgrounds from styles.css, light and dark.
    const surfaces = { light: [parse("#f7f6f2"), parse("#eeeff0"), parse("#ffffff")], dark: [parse("#0c1329"), parse("#0a1022"), parse("#131c3a")] };
    for (const o of CHOICES.accent.options.filter((o) => Object.keys(o.vars).length)) {
      for (const theme of ["light", "dark"] as const) {
        it(`${o.id} (${theme}): white on the button, text and focus ring on the surfaces, text on the soft fill`, () => {
          const v = o.vars as Record<string, string>;
          expect(ratio([255, 255, 255], pair(v["--accent"])[theme])).toBeGreaterThanOrEqual(4.5);
          expect(ratio([255, 255, 255], pair(v["--accent-hover"])[theme])).toBeGreaterThanOrEqual(4.5);
          for (const bg of surfaces[theme]) expect(ratio(pair(v["--accent-ui"])[theme], bg)).toBeGreaterThanOrEqual(4.5);
          expect(ratio(pair(v["--accent-ui"])[theme], pair(v["--accent-soft"])[theme])).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  });
});

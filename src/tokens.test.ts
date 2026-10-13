import { describe, expect, it } from "vitest";
// Vitest stubs CSS imports, so the stylesheet is read from disk. (There are no Node typings in this
// project, hence the ignore: the module exists at test time.)
// @ts-ignore
const { readFileSync } = (await import("node:fs")) as { readFileSync: (path: URL, encoding: string) => string };
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/** WCAG 2.x contrast of the design tokens, read from the real stylesheet so a colour change cannot slip past. */
const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const blend = (fg: number[], bg: number[], alpha: number) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));

/** The [light, dark] values of a `light-dark(#…, #…)` token. */
function token(name: string): { light: number[]; dark: number[] } {
  const m = new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`).exec(css);
  if (!m) throw new Error(`token --${name} is not a light-dark() pair of hex colours in styles.css`);
  return { light: parse(m[1]), dark: parse(m[2]) };
}

const SURFACES = ["background", "sidebar", "surface-1", "surface-2", "field", "surface-hover", "accent-soft"];
const TEXT = ["text-primary", "text-secondary", "text-muted"];
const STATUS = ["accent-ui", "danger", "success", "warning"];

for (const theme of ["light", "dark"] as const) {
  describe(`${theme} theme contrast`, () => {
    for (const surface of SURFACES) {
      const bg = token(surface)[theme];
      for (const name of TEXT) {
        it(`${name} on ${surface} is at least 4.5:1`, () => {
          expect(ratio(token(name)[theme], bg)).toBeGreaterThanOrEqual(4.5);
        });
      }
      for (const name of STATUS) {
        it(`${name} text on ${surface} is at least 4.5:1`, () => {
          expect(ratio(token(name)[theme], bg)).toBeGreaterThanOrEqual(4.5);
        });
      }
      it(`the focus ring on ${surface} is at least 3:1`, () => {
        expect(ratio(blend(token("accent-ui")[theme], bg, 0.75), bg)).toBeGreaterThanOrEqual(3);
      });
    }

    it("white text on the primary button and on its hover colour is at least 4.5:1", () => {
      const white = [255, 255, 255];
      expect(ratio(white, token("accent")[theme])).toBeGreaterThanOrEqual(4.5);
      expect(ratio(white, token("accent-hover")[theme])).toBeGreaterThanOrEqual(4.5);
    });
  });
}

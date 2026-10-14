import { hexToRgb, normalizeHex, rgbToHex } from "../../lib/color";
import { hash, type MapNode } from "./model";

const KEY = "suivelle.node-map.analogous.v3";
const SHADES = 7, LIMIT = 32;
// Adjacent shades alternate in lightness and saturation, so neighbours on the hue fan also separate
// in tone and intensity: muted and vivid variants of each family, not just small hue turns.
const LIGHTNESS = [0, .08, -.08, 0, .08, -.08, 0];
const CHROMA = [1.35, .7, 1.15, 1, .65, 1.25, .85];
let cache: Record<string, string[]> | undefined;

type Lch = [number, number, number];
const linear = (c: number) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
const gamma = (c: number) => c <= .0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - .055;
/** OKLCH keeps lightness and chroma perceptually even while the hue turns, unlike HSV. */
export function hexToOklch(hex: string): Lch {
  const [r, g, b] = hexToRgb(hex).map(c => linear(c / 255));
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b), m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b), s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  const L = .2104542553 * l + .793617785 * m - .0040720468 * s, A = 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, B = .0259040371 * l + .7827717662 * m - .808675766 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360];
}
const rgbOf = ([L, C, h]: Lch) => {
  const A = C * Math.cos(h * Math.PI / 180), B = C * Math.sin(h * Math.PI / 180);
  const l = (L + .3963377774 * A + .2158037573 * B) ** 3, m = (L - .1055613458 * A - .0638541728 * B) ** 3, s = (L - .0894841775 * A - 1.291485548 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + .2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s, -.0041960863 * l - .7034186147 * m + 1.707614701 * s].map(gamma);
};
/** Out-of-gamut shades lose chroma, never hue or lightness. */
export function oklchToHex([L, C, h]: Lch): `#${string}` {
  let chroma = C, rgb = rgbOf([L, chroma, h]);
  for (let i = 0; i < 24 && rgb.some(c => c < 0 || c > 1); i++) rgb = rgbOf([L, chroma *= .9, h]);
  return rgbToHex(rgb.map(c => Math.round(Math.min(1, Math.max(0, c)) * 255)));
}
const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * Seven analogous shades around a theme colour. The fan widens or narrows with the distance to the
 * other node families, so blue never drifts into violet. Palettes are cached per resolved colour.
 */
export function analogousPalette(base: string, neighbours: string[] = []): string[] {
  const hex = normalizeHex(base);
  if (!hex) return [base];
  const [L, C, h] = hexToOklch(hex);
  const gaps = neighbours.map(normalizeHex).filter(n => !!n && n !== hex).map(n => hueGap(h, hexToOklch(n!)[2])).filter(g => g >= 1);
  const spread = Math.round(Math.min(20, Math.max(8, gaps.length ? Math.min(...gaps) * .38 : 18)));
  const key = `${hex}|${spread}`;
  if (!cache) {
    cache = {};
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const [entry, shades] of Object.entries(saved).slice(-LIMIT)) {
          if (/^#[0-9A-F]{6}\|\d+$/.test(entry) && Array.isArray(shades) && shades.length === SHADES && shades.every(shade => normalizeHex(shade))) cache[entry] = shades;
        }
      }
    } catch { /* Unavailable or damaged storage: keep a session cache. */ }
  }
  if (cache[key]) return cache[key];
  const shades = Array.from({ length: SHADES }, (_, i) => oklchToHex([Math.min(.95, Math.max(.2, L + LIGHTNESS[i])), C * CHROMA[i], (h + spread * (i / 3 - 1) + 360) % 360]));
  cache[key] = shades;
  while (Object.keys(cache).length > LIMIT) delete cache[Object.keys(cache)[0]];
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* Session cache still works. */ }
  return shades;
}

/** Identity, rather than node order or title, determines a stable nearby hue. */
export function nodeShade(id: string, palette: string[]): string { return palette[hash(id) % palette.length]; }

/**
 * One colour per node: the family comes from its kind, the shade from its top-level branch,
 * so a page tree (and a database's records) reads as one tone instead of random speckle.
 */
export function nodeTones(nodes: MapNode[], palettes: Record<string, string[]>): Record<string, string> {
  const at = new Map(nodes.map(n => [n.id, n])), roots = new Map<string, string>();
  const rootOf = (node: MapNode): string => {
    const known = roots.get(node.id); if (known) return known;
    const path: string[] = []; let current = node;
    for (let depth = 0; depth < 64; depth++) {
      const cached = roots.get(current.id); if (cached) { path.forEach(id => roots.set(id, cached)); return cached; }
      path.push(current.id);
      const parent = current.parentId ? at.get(current.parentId) : undefined;
      if (!parent || parent.kind === "workspace") break;
      current = parent;
    }
    path.forEach(id => roots.set(id, current.id)); return current.id;
  };
  const tones: Record<string, string> = {};
  for (const n of nodes) if (n.kind !== "workspace") { const palette = palettes[n.kind]; if (palette) tones[n.id] = nodeShade(rootOf(n), palette); }
  return tones;
}

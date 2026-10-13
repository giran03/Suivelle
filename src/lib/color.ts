import "./legacy";
/** Opaque colors only; never pass arbitrary saved strings into CSS. */
export function normalizeHex(value: unknown): `#${string}` | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^#[\da-f]{6}$/i.test(text)) return text.toUpperCase() as `#${string}`;
  if (/^#[\da-f]{3}$/i.test(text)) return `#${text.slice(1).split("").map((c) => c + c).join("").toUpperCase()}`;
  return null;
}
export function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
export function rgbToHex(rgb: number[]): `#${string}` {
  return `#${rgb.map((n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
export function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((n) => n / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max === 0 ? 0 : d / max, max];
}
export function hsvToHex(h: number, s: number, v: number): `#${string}` {
  const sector = (h / 60) % 6, c = v * s, x = c * (1 - Math.abs(sector % 2 - 1)), m = v - c;
  const rgb = sector < 1 ? [c, x, 0] : sector < 2 ? [x, c, 0] : sector < 3 ? [0, c, x] : sector < 4 ? [0, x, c] : sector < 5 ? [x, 0, c] : [c, 0, x];
  return rgbToHex(rgb.map((n) => (n + m) * 255));
}
const RECENTS = "suivelle.recent-colors";
export function recentColors(): `#${string}`[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENTS) ?? "[]");
    return Array.isArray(saved) ? [...new Set(saved.map(normalizeHex).filter((c): c is `#${string}` => c !== null))].slice(0, 12) : [];
  } catch { return []; }
}
export function rememberColor(color: string) {
  const hex = normalizeHex(color);
  if (!hex) return;
  try { localStorage.setItem(RECENTS, JSON.stringify([hex, ...recentColors().filter((c) => c !== hex)].slice(0, 12))); } catch { /* Optional history. */ }
}

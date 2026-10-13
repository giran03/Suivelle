/** The Settings > Motion levels, and what each one means for the transitions. src/motion.css holds the same table. */
export type MotionLevel = "system" | "subtle" | "reduced";

export interface MotionProfile {
  /** Multiplies every duration. */
  time: number;
  /** Multiplies travel distances. */
  dist: number;
  /** Multiplies blur radii. */
  blur: number;
  /** How far a scale departs from 1 (0 means no scaling at all). */
  scale: number;
  /** 1 lets looping effects run, 0 shows them still. */
  loops: number;
}

export const PROFILES = {
  full: { time: 1, dist: 1, blur: 1, scale: 1, loops: 1 },
  subtle: { time: 0.65, dist: 0.6, blur: 0, scale: 0.5, loops: 1 },
  reduced: { time: 0.45, dist: 0, blur: 0, scale: 0, loops: 0 },
} as const satisfies Record<string, MotionProfile>;

/** System follows the operating system's request for less motion; the other two are explicit. */
export function profileOf(level: string, osReduced: boolean): MotionProfile {
  if (level === "subtle") return PROFILES.subtle;
  if (level === "reduced") return PROFILES.reduced;
  return osReduced ? PROFILES.reduced : PROFILES.full;
}

const NAMES: Record<keyof MotionProfile, string> = { time: "--k-time", dist: "--k-dist", blur: "--k-blur", scale: "--k-scale", loops: "--k-loops" };

/** The profile in force right now, read from the document so script-driven effects obey the same dial as CSS. */
export function readProfile(): MotionProfile {
  const style = getComputedStyle(document.documentElement);
  const out: MotionProfile = { ...PROFILES.full };
  for (const key of Object.keys(NAMES) as (keyof MotionProfile)[]) {
    const v = parseFloat(style.getPropertyValue(NAMES[key]));
    if (Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/** A CSS cubic-bezier(x1, y1, x2, y2) as a function of progress, so script-driven motion matches the stylesheet. */
export function bezier(css: string): (t: number) => number {
  const m = String(css).match(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
  if (!m) return (t) => t;
  const [x1, y1, x2, y2] = m.slice(1).map(parseFloat);
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 8; i++) {
      const dx = ((ax * s + bx) * s + cx) * s - t;
      const d = (3 * ax * s + 2 * bx) * s + cx;
      if (Math.abs(dx) < 1e-6 || d === 0) break;
      s -= dx / d;
    }
    return ((ay * s + by) * s + cy) * s;
  };
}

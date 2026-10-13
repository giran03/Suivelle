export type MatrixVariant = "scan" | "twinkle" | "orbit" | "pulse";

const CORNERS = [0, 3, 12, 15];
/** The clockwise ring around the edge, without the corners. */
const RING = [1, 2, 7, 11, 14, 13, 8, 4];
const INNER = [5, 6, 9, 10];
const TWINKLE = [7, 2, 11, 5, 14, 9, 0, 12, 3, 15, 6, 10, 13, 1, 8, 4];

/**
 * The 4x4 matrix loader (transitions.dev): all four variants share one colour pulse, and a delay per dot gives each
 * its character. Returns 16 delays in ms; `null` is a dot that takes no part (a rounded corner is empty, the centre of
 * an orbit holds still).
 */
export function matrixDelays(variant: MatrixVariant, cycle = 1200, rounded = false): (number | null)[] {
  return Array.from({ length: 16 }, (_, i) => {
    if (rounded && CORNERS.includes(i)) return null;
    if (variant === "scan") return Math.round((i % 4) * (cycle / 10));
    if (variant === "twinkle") return Math.round(TWINKLE[i] * (cycle / 16));
    if (variant === "orbit") {
      const k = RING.indexOf(i);
      return k === -1 ? null : Math.round(k * (cycle / 8));
    }
    return INNER.includes(i) ? 0 : Math.round(cycle * 0.16);
  });
}

/** Which dots are left out entirely (rounded corners), as opposed to present but still. */
export function matrixGaps(rounded: boolean): number[] {
  return rounded ? CORNERS : [];
}

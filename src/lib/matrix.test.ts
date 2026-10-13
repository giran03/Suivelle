import { describe, expect, it } from "vitest";
import { matrixDelays, matrixGaps } from "./matrix";

describe("matrixDelays", () => {
  it("always describes sixteen dots", () => {
    for (const v of ["scan", "twinkle", "orbit", "pulse"] as const) expect(matrixDelays(v)).toHaveLength(16);
  });
  it("scans by column: every dot in a column shares a delay, and columns step in order", () => {
    const d = matrixDelays("scan", 1000);
    expect(d[0]).toBe(d[4]);
    expect(d[1]).toBe(100);
    expect(d[3]).toBe(300);
  });
  it("orbits the ring and holds the centre still", () => {
    const d = matrixDelays("orbit", 800);
    expect(d[5]).toBeNull();
    expect(d[1]).toBe(0);
    expect(d[2]).toBe(100);
    expect(d.filter((x) => x !== null)).toHaveLength(8);
  });
  it("pulses the middle first and the rest a beat behind", () => {
    const d = matrixDelays("pulse", 1000);
    expect([5, 6, 9, 10].every((i) => d[i] === 0)).toBe(true);
    expect(d[0]).toBe(160);
  });
  it("gives every dot of a twinkle its own slot", () => {
    expect(new Set(matrixDelays("twinkle", 1600)).size).toBe(16);
  });
  it("empties the four corners when rounded", () => {
    expect(matrixGaps(true)).toEqual([0, 3, 12, 15]);
    expect(matrixDelays("scan", 1200, true)[15]).toBeNull();
    expect(matrixGaps(false)).toEqual([]);
  });
});

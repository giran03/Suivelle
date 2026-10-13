import { describe, expect, it } from "vitest";
import { CHOICES, sanitize } from "../stores/preferences";
import { bezier, PROFILES, profileOf } from "./motion";

// Vitest stubs CSS imports, so the stylesheet is read from disk (no Node typings in this project).
// @ts-ignore
const { readFileSync } = (await import("node:fs")) as { readFileSync: (path: URL, encoding: string) => string };
const css = readFileSync(new URL("../motion.css", import.meta.url), "utf8");

/** The --k-* values a rule block of motion.css sets. */
function multipliers(selector: string): Record<string, number> {
  const at = css.indexOf(selector + " {");
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(at, css.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/--k-(\w+):\s*([\d.]+);/g)].map((m) => [m[1], Number(m[2])]));
}

describe("profileOf", () => {
  it("gives System full motion, or the reduced path when the OS asks", () => {
    expect(profileOf("system", false)).toBe(PROFILES.full);
    expect(profileOf("system", true)).toBe(PROFILES.reduced);
  });
  it("lets an explicit choice win over the OS", () => {
    expect(profileOf("subtle", true)).toBe(PROFILES.subtle);
    expect(profileOf("reduced", false)).toBe(PROFILES.reduced);
  });
  it("treats an unknown value as System", () => {
    expect(profileOf("bogus", false)).toBe(PROFILES.full);
  });
  it("keeps fades alive but moves nothing when reduced", () => {
    expect(PROFILES.reduced.time).toBeGreaterThan(0);
    expect(PROFILES.reduced.dist).toBe(0);
    expect(PROFILES.reduced.blur).toBe(0);
    expect(PROFILES.reduced.scale).toBe(0);
    expect(PROFILES.reduced.loops).toBe(0);
  });
  it("is gentler than full at every step", () => {
    for (const key of ["time", "dist", "blur", "scale"] as const) {
      expect(PROFILES.subtle[key]).toBeLessThanOrEqual(PROFILES.full[key]);
      expect(PROFILES.reduced[key]).toBeLessThanOrEqual(PROFILES.subtle[key]);
    }
  });
});

describe("motion.css", () => {
  it("matches the profile table for each level", () => {
    expect(multipliers(":root")).toEqual(PROFILES.full);
    expect(multipliers(':root[data-motion="subtle"]')).toEqual(PROFILES.subtle);
    expect(multipliers(':root[data-motion="reduced"]')).toEqual(PROFILES.reduced);
    expect(multipliers("  :root:not([data-motion])")).toEqual(PROFILES.reduced);
  });
});

describe("Settings > Motion", () => {
  it("offers System, Subtle and Reduced", () => {
    expect(CHOICES.motion.options.map((o) => o.id)).toEqual(["system", "subtle", "reduced"]);
  });
  it("accepts Subtle and falls back for anything else", () => {
    expect(sanitize({ motion: "subtle" }).motion).toBe("subtle");
    expect(sanitize({ motion: "off" }).motion).toBe("system");
  });
});

describe("bezier", () => {
  const ease = bezier("cubic-bezier(0.22, 1, 0.36, 1)");
  it("runs from 0 to 1 and stays monotonic", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    let last = 0;
    for (let i = 1; i <= 20; i++) {
      const v = ease(i / 20);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
  it("decelerates: more than half done at the midpoint", () => {
    expect(ease(0.5)).toBeGreaterThan(0.8);
  });
  it("is linear when given something that is not a bezier", () => {
    expect(bezier("ease-in-out")(0.3)).toBe(0.3);
  });
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { loadIconFont } from "./iconFont";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.iconFont;
});

it("restores symbols when a slow local font loads after the fallback timeout", async () => {
  vi.useFakeTimers();
  let finish!: (faces: FontFace[]) => void;
  const load = vi.fn(() => new Promise<FontFace[]>((resolve) => { finish = resolve; }));
  Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
  loadIconFont();
  expect(document.documentElement.dataset.iconFont).toBe("loading");
  await vi.advanceTimersByTimeAsync(3000);
  expect(document.documentElement.dataset.iconFont).toBe("failed");
  finish([{} as FontFace]);
  await Promise.resolve();
  expect(document.documentElement.dataset.iconFont).toBe("ready");
});

it.each([() => Promise.reject(new Error("missing local font")), () => Promise.resolve([])])("uses text fallbacks when the font cannot load", async (load) => {
  Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
  loadIconFont();
  await Promise.resolve();
  expect(document.documentElement.dataset.iconFont).toBe("failed");
});

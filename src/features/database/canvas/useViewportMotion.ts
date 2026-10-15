import { useCallback, useEffect, useRef, useState } from "react";
import { clampZoom, easeOutCubic, lerpViewport, toWorld, type Viewport } from "./viewport";

const TWEEN_MS = 260;
/** Share of the remaining zoom distance covered per 60 Hz frame while a wheel zoom settles. */
const SETTLE = 0.22;

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * The canvas viewport with motion. Buttons and shortcuts glide to their target (`animateTo`); wheel
 * and pinch zoom settle toward a goal zoom around the pointer (`zoomBy`), so a flick of the wheel
 * eases rather than jumps. Dragging and panning set the viewport directly (`jump`) and cancel
 * whatever was gliding.
 */
export function useViewportMotion(initial: Viewport) {
  const [vp, setVp] = useState(initial);
  const ref = useRef(initial);
  const raf = useRef(0);
  const goal = useRef<{ k: number; sx: number; sy: number; wx: number; wy: number } | null>(null);

  const set = useCallback((v: Viewport) => {
    ref.current = v;
    setVp(v);
  }, []);

  const cancel = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    goal.current = null;
  }, []);

  const jump = useCallback(
    (v: Viewport) => {
      cancel();
      set(v);
    },
    [cancel, set],
  );

  const animateTo = useCallback(
    (target: Viewport, ms = TWEEN_MS) => {
      cancel();
      if (ms <= 0 || reducedMotion()) return set(target);
      const from = ref.current;
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / ms);
        set(t >= 1 ? target : lerpViewport(from, target, easeOutCubic(t)));
        raf.current = t < 1 ? requestAnimationFrame(step) : 0;
      };
      raf.current = requestAnimationFrame(step);
    },
    [cancel, set],
  );

  /** Zooms by `factor` around the screen point (sx, sy), easing toward the new zoom. */
  const zoomBy = useCallback(
    (sx: number, sy: number, factor: number) => {
      if (reducedMotion()) {
        const v = ref.current;
        const k = clampZoom(v.k * factor);
        const w = toWorld(v, sx, sy);
        return jump({ k, x: sx - w.x * k, y: sy - w.y * k });
      }
      const g = goal.current;
      const moved = !g || Math.abs(g.sx - sx) > 1 || Math.abs(g.sy - sy) > 1;
      const w = moved ? toWorld(ref.current, sx, sy) : { x: g!.wx, y: g!.wy };
      goal.current = { k: clampZoom((g?.k ?? ref.current.k) * factor), sx, sy, wx: w.x, wy: w.y };
      if (raf.current) return;
      let last = performance.now();
      const step = (now: number) => {
        const g2 = goal.current;
        if (!g2) {
          raf.current = 0;
          return;
        }
        const frames = Math.min(4, (now - last) / 16.67);
        last = now;
        const v = ref.current;
        const ratio = g2.k / v.k;
        const done = Math.abs(Math.log(ratio)) < 0.0015;
        const k = done ? g2.k : v.k * ratio ** (1 - (1 - SETTLE) ** frames);
        set({ k, x: g2.sx - g2.wx * k, y: g2.sy - g2.wy * k });
        if (done) {
          goal.current = null;
          raf.current = 0;
        } else raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    },
    [jump, set],
  );

  useEffect(() => cancel, [cancel]);

  return { vp, vpRef: ref, jump, animateTo, zoomBy, cancel };
}

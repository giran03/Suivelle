import { readProfile } from "../../lib/motion";

export interface Span {
  x: number;
  w: number;
}

/** Where each word sits along a line of text, given a way to measure a piece of it. Spaces take room but have no span. */
export function wordSpans(text: string, measure: (piece: string) => number): Span[] {
  const spans: Span[] = [];
  let x = 0;
  for (const piece of text.split(/(\s+)/)) {
    const w = measure(piece);
    if (piece.trim()) spans.push({ x, w });
    x += w;
  }
  return spans;
}

/** The stack of soft streaks drawn under each word as it dissolves: four overlapping ellipses per word along the bottom edge. */
export function glowLayers(spans: Span[], opts: { padLeft: number; width: number; rgb: string; spread: number }): string {
  const layers: string[] = [];
  for (const s of spans) {
    const cx = opts.padLeft + s.x + s.w / 2;
    const hw = Math.max(s.w * 0.45, 8) * opts.spread;
    for (const [dx, rw, rh, a] of [[0, 0.8, 7, 0.22], [hw * 0.45, 0.55, 8, 0.18], [-hw * 0.4, 0.65, 6, 0.16], [hw * 0.15, 0.9, 5, 0.14]]) {
      const at = (((cx + dx) / opts.width) * 100).toFixed(2);
      layers.push(`radial-gradient(ellipse ${Math.max(hw * rw, 2).toFixed(1)}px ${rh}px at ${at}% 100%, rgba(${opts.rgb},${a}), transparent)`);
    }
  }
  return layers.join(", ");
}

/** Whether text in this colour sits on a dark surface (light text), read from the field itself so any theme works. */
export function onDark(color: string): boolean {
  const m = color.match(/[\d.]+/g)?.map(Number);
  return !!m && m.length >= 3 && (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 > 0.5;
}

const canvas = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Clearing a field (the transitions.dev input clear): the typed words drop away blurred while a soft streak lights up
 * under each of them. The caller empties the field at once; this draws the words that were in it over the top, inside
 * `host` (which must be position: relative), and removes them when done. Settings > Motion
 * scales it: Subtle shortens and keeps the streak, Reduced is a short fade with no movement or streak.
 */
export async function dissolve(host: HTMLElement, input: HTMLInputElement, text: string): Promise<void> {
  const p = readProfile();
  const style = getComputedStyle(input);
  const outMs = Math.round(400 * p.time);
  const totalMs = Math.round(1000 * p.time);
  const fly = 12 * p.dist;
  const blur = 2 * p.blur;

  const padLeft = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
  // Everything is drawn inside a clipping layer of its own, so the host can leave the field's focus ring unclipped.
  const fx = document.createElement("span");
  fx.setAttribute("aria-hidden", "true");
  Object.assign(fx.style, { position: "absolute", inset: "0", overflow: "hidden", borderRadius: "inherit", pointerEvents: "none" });
  host.append(fx);
  const ghost = document.createElement("span");
  ghost.textContent = text;
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    position: "absolute",
    left: `${input.offsetLeft + padLeft}px`,
    top: `${input.offsetTop}px`,
    height: `${input.offsetHeight}px`,
    display: "flex",
    alignItems: "center",
    whiteSpace: "pre",
    pointerEvents: "none",
    font: style.font,
    letterSpacing: style.letterSpacing,
    color: style.color,
  });
  fx.append(ghost);

  const animations: Animation[] = [
    ghost.animate(
      [
        { opacity: 1, transform: "translateY(0)", filter: "blur(0px)" },
        { opacity: 0, transform: `translateY(${fly}px)`, filter: `blur(${blur}px)` },
      ],
      { duration: outMs, easing: EASE, fill: "forwards" },
    ),
  ];

  let glow: HTMLElement | null = null;
  if (p.dist > 0 && canvas) {
    canvas.font = style.font;
    const dark = onDark(style.color);
    const layers = glowLayers(wordSpans(text, (s) => canvas.measureText(s).width), {
      padLeft: input.offsetLeft + padLeft,
      width: host.clientWidth || 280,
      rgb: dark ? "255,255,255" : "0,0,0",
      spread: 1.5,
    });
    glow = document.createElement("span");
    glow.setAttribute("aria-hidden", "true");
    Object.assign(glow.style, { position: "absolute", inset: "0", pointerEvents: "none", opacity: "0", background: layers, mixBlendMode: dark ? "screen" : "multiply" });
    fx.append(glow);
    const peak = dark ? 0.85 : 0.42;
    animations.push(glow.animate([{ opacity: 0 }, { opacity: peak, offset: 0.15 }, { opacity: 0 }], { duration: totalMs, delay: Math.round(50 * p.time), easing: "ease-out", fill: "both" }));
  }

  // The empty field's placeholder fades in, where the browser lets a pseudo-element be animated.
  try {
    animations.push(input.animate([{ opacity: 0 }, { opacity: 1 }], { duration: outMs, easing: EASE, pseudoElement: "::placeholder" }));
  } catch {
    /* the placeholder just appears */
  }

  // A page that is not drawing (hidden, or throttled) never finishes its animations, so do not wait for them forever.
  const done = Promise.allSettled(animations.map((a) => a.finished));
  const cap = new Promise((resolve) => window.setTimeout(resolve, totalMs + 250));
  await Promise.race([done, cap]);
  animations.forEach((a) => a.cancel());
  fx.remove();
}

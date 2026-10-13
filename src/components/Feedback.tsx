import { useEffect, useRef } from "react";

/** A checkmark that fades and settles in while its stroke is drawn (the transitions.dev success check). Decorative. */
export function SuccessCheck({ size = 16 }: { size?: number }) {
  return (
    <span className="t-success-check" data-state="in" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 12.5l5 5L20 6.5" />
      </svg>
    </span>
  );
}

/**
 * A number whose changed characters pop in, each a beat after the last (the transitions.dev number pop-in).
 * Characters that stay the same do not move, and nothing animates on the first render.
 */
export function PopNumber({ text }: { text: string }) {
  const previous = useRef<string | null>(null);
  const before = previous.current;
  useEffect(() => {
    previous.current = text;
  });
  const chars = [...text];
  let order = 0;
  return (
    <span className="t-digits">
      {chars.map((ch, i) => {
        const changed = before !== null && [...before][i] !== ch;
        return (
          <span key={`${i}:${ch}`} className={changed ? "t-digit pop" : "t-digit"} style={changed ? ({ "--n": order++ } as React.CSSProperties) : undefined}>
            {ch}
          </span>
        );
      })}
    </span>
  );
}

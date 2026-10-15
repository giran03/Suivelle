import { useEffect, useRef } from "react";
import { Icon } from "./Icon";

/** A decorative checkmark that fades and settles in. */
export function SuccessCheck({ size = 16 }: { size?: number }) {
  return (
    <span className="t-success-check" data-state="in" aria-hidden="true">
      <Icon name="check" size={size} />
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

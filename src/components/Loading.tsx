import { matrixDelays, matrixGaps, type MatrixVariant } from "../lib/matrix";

const DELAYS: Record<string, (number | null)[]> = {};
function delays(variant: MatrixVariant, rounded: boolean): (number | null)[] {
  const key = `${variant}:${rounded}`;
  return (DELAYS[key] ??= matrixDelays(variant, 1200, rounded));
}

/** The 4x4 dot loader (transitions.dev matrix loader). Decorative: pair it with a label or use Loading. */
export function MatrixLoader({ variant = "scan", rounded = true }: { variant?: MatrixVariant; rounded?: boolean }) {
  const gaps = matrixGaps(rounded);
  const table = delays(variant, rounded);
  return (
    <span className="t-matrix" aria-hidden="true">
      {table.map((delay, i) => (
        <i key={i} className={gaps.includes(i) ? "is-gap" : delay === null ? "is-still" : undefined} style={delay ? ({ "--d": delay } as React.CSSProperties) : undefined} />
      ))}
    </span>
  );
}

/** A quiet "Loading…" line with the dot loader beside it. Screen readers get the words; the dots are for the eye. */
export function Loading({ label = "Loading…", variant = "scan" }: { label?: string; variant?: MatrixVariant }) {
  return (
    <span className="loading">
      <MatrixLoader variant={variant} />
      <span>{label}</span>
    </span>
  );
}

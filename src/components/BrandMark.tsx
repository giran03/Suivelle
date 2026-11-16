/**
 * The Suivelle mark: a rounded frame left open at the top right, with a dot stepping into the gap.
 * Colours come from the --brand-* tokens, so the mark follows the theme. Without a tile it is
 * the frame and dot alone, for use on surfaces that already have a background.
 */
export function BrandMark({ size = 24, tile = true, title }: { size?: number; tile?: boolean; title?: string }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 96 96" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {tile && <rect x="1" y="1" width="94" height="94" rx="22" fill="var(--brand-tile)" stroke="var(--brand-edge)" strokeWidth="2" />}
      <g transform="translate(48 48) scale(0.28) translate(-127 -128)">
        <path d="M130 46H80A36 36 0 0 0 44 82V174A36 36 0 0 0 80 210H174A36 36 0 0 0 210 174V126" fill="none" stroke="var(--brand-frame)" strokeWidth="30" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="184" cy="72" r="28" fill="var(--brand-dot)" />
      </g>
    </svg>
  );
}

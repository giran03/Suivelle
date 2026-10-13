/**
 * The Suivelle mark: an S made of two half circles, with a four-point star where it begins.
 * Colours come from the --brand-* tokens, so the mark follows the theme. Without a tile it is
 * the S and star alone, for use on surfaces that already have a background.
 */
export function BrandMark({ size = 24, tile = true, title }: { size?: number; tile?: boolean; title?: string }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 96 96" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {tile && <rect x="1" y="1" width="94" height="94" rx="22" fill="var(--brand-tile)" stroke="var(--brand-edge)" strokeWidth="2" />}
      <g transform="translate(48 48) scale(1.08) translate(-55 -47)">
        <path d="M66 28H48A12 12 0 0 0 48 52A12 12 0 0 1 48 76H30" fill="none" stroke="var(--brand-s)" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M70 13C71.6 23.5 74.5 26.4 85 28C74.5 29.6 71.6 32.5 70 43C68.4 32.5 65.5 29.6 55 28C65.5 26.4 68.4 23.5 70 13Z" fill="var(--brand-star)" />
      </g>
    </svg>
  );
}

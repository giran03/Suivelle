import type { NumberFormat } from "../../types";

/**
 * Display-only number formatting. A property's stored values are never touched: the format only
 * changes how a number is shown (and what the totals row and selection strip show for it).
 *
 * Without a format a number keeps the app's long-standing look: locale grouping, up to ten decimals.
 * With one, grouping is opt-in so "no thousands separator" is something you can actually choose.
 */
export function formatNumberWith(n: unknown, fmt?: NumberFormat | null, locale?: string): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  if (!fmt) return n.toLocaleString(locale, { maximumFractionDigits: 10 });
  const value = fmt.percent ? n * 100 : n;
  const digits = typeof fmt.decimals === "number" ? Math.min(10, Math.max(0, Math.floor(fmt.decimals))) : undefined;
  const body = Math.abs(value).toLocaleString(locale, {
    useGrouping: !!fmt.thousands,
    minimumFractionDigits: digits ?? 0,
    maximumFractionDigits: digits ?? 10,
  });
  // "-0" would only appear after rounding a tiny negative; show it as plain zero.
  const negative = value < 0 && /[1-9]/.test(body);
  const unit = fmt.unit?.trim();
  return `${negative ? "-" : ""}${fmt.currency ?? ""}${body}${fmt.percent ? "%" : ""}${unit ? `${/^[\p{L}\p{N}]/u.test(unit) ? " " : ""}${unit}` : ""}`;
}

/** How full a progress bar is, from 0 to 1; null when the format asks for no bar or there is no number. */
export function barFraction(n: unknown, fmt?: NumberFormat | null): number | null {
  if (!fmt?.bar || typeof n !== "number" || !Number.isFinite(n)) return null;
  const max = fmt.barMax && fmt.barMax > 0 ? fmt.barMax : fmt.percent ? 1 : 100;
  return Math.min(1, Math.max(0, n / max));
}

/** True when the format changes nothing, so it can be left out of a saved config. */
export const isPlainFormat = (fmt: NumberFormat | null | undefined): boolean =>
  !fmt || (fmt.decimals === undefined && !fmt.thousands && !fmt.percent && !fmt.currency && !fmt.unit && !fmt.bar && fmt.barMax === undefined);

/** Drops empty and default entries; returns undefined when nothing is left. */
export function cleanFormat(fmt: NumberFormat): NumberFormat | undefined {
  const out: NumberFormat = {};
  if (typeof fmt.decimals === "number") out.decimals = fmt.decimals;
  if (fmt.thousands) out.thousands = true;
  if (fmt.percent) out.percent = true;
  if (fmt.currency?.trim()) out.currency = fmt.currency.trim();
  if (fmt.unit?.trim()) out.unit = fmt.unit.trim();
  if (fmt.bar) out.bar = true;
  if (fmt.bar && typeof fmt.barMax === "number" && fmt.barMax > 0) out.barMax = fmt.barMax;
  return isPlainFormat(out) ? undefined : out;
}

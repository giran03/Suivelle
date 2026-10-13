import { createContext, useContext, useMemo } from "react";
import type { FilterNode } from "../../types";

/**
 * A filter applied on top of whatever a view already filters by. A dashboard provides its shared
 * filters this way, so the views it embeds do not need to know about dashboards.
 */
export const ExtraFilterContext = createContext<FilterNode | null>(null);

export const useExtraFilter = () => useContext(ExtraFilterContext);

/** Both filters must hold. */
export function andFilters(a: FilterNode | null | undefined, b: FilterNode | null | undefined): FilterNode | null {
  if (a && b) return { op: "and", children: [a, b] };
  return a ?? b ?? null;
}

/** Keeps the object's identity while its content is unchanged, so effects do not re-run needlessly. */
export function useStable<T>(value: T): T {
  const key = JSON.stringify(value);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => value, [key]);
}

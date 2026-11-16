import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import { useLiveData } from "../../lib/liveData";
import type { Aggregates, DbView } from "../../types";
import { useExtraFilter, useStable } from "./extraFilter";

/** The visible columns that carry a summary, as a stable text key. */
export const aggregateKey = (view: DbView | undefined): string =>
  (view?.config.columns ?? [])
    .filter((c) => !c.hidden && c.aggregate)
    .map((c) => `${c.propertyId}:${c.aggregate}`)
    .join("|");

/**
 * The totals row's numbers, computed by the backend over the whole filtered set. They refresh when
 * the view's filter or summaries change, when records are edited, and after the view has been saved
 * (a summary just picked must reach the server before it can be computed).
 */
export function useAggregates(
  databaseId: string | undefined,
  view: DbView | undefined,
  queryVersion: number,
  edits: number,
  flushView: () => Promise<unknown>,
  byGroup: boolean,
  enabled: boolean,
): Aggregates | null {
  const extraFilter = useStable(useExtraFilter());
  const [data, setData] = useState<{ key: string; value: Aggregates } | null>(null);
  const latest = useRef(0);
  const viewId = view?.id;
  const live = useLiveData();
  const key = useMemo(() => `${viewId}|${aggregateKey(view)}|${byGroup}`, [viewId, view, byGroup]);
  const active = enabled && !!databaseId && !!viewId && aggregateKey(view) !== "";

  useEffect(() => {
    if (!active || !databaseId || !viewId) return;
    const ticket = ++latest.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await flushView();
          const value = await ipc.viewAggregates(databaseId, viewId, extraFilter, byGroup);
          if (ticket === latest.current) setData({ key, value });
        } catch {
          // The totals are a convenience: a failure leaves the last numbers in place.
        }
      })();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [active, databaseId, viewId, key, queryVersion, live, edits, extraFilter, byGroup, flushView]);

  return active ? (data?.value ?? null) : null;
}

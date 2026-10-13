import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import type { RecordPreview, RecordRange, RecordRow } from "../../types";
import { useExtraFilter, useStable } from "./extraFilter";

/** The most records a calendar or timeline window loads. */
export const WINDOW_LIMIT = 1000;

interface Options {
  databaseId: string;
  viewId: string;
  queryVersion: number;
  /** Fetch only records dated in this window (or, with no bounds, undated records). */
  range?: RecordRange | null;
  pageSize: number;
  /** Keep fetching until every record (up to WINDOW_LIMIT) is loaded. */
  loadAll?: boolean;
  /** Also fetch gallery previews for the records as they arrive. */
  previews?: boolean;
  /** Skip loading entirely (for views that are not configured yet). */
  enabled?: boolean;
}

/** An append-only list of one view's records, fetched page by page. */
export function usePagedRecords({ databaseId, viewId, queryVersion, range, pageSize, loadAll = false, previews = false, enabled = true }: Options) {
  const extraFilter = useStable(useExtraFilter());
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewMap, setPreviewMap] = useState<Record<string, RecordPreview>>({});
  const gen = useRef(0);
  const rangeKey = range ? `${range.propertyId}|${range.from ?? ""}|${range.to ?? ""}` : "";

  const fetchPreviews = useCallback(async (batch: RecordRow[], mine: number) => {
    for (let i = 0; i < batch.length; i += 100) {
      if (mine !== gen.current) return;
      try {
        const got = await ipc.recordPreviews(batch.slice(i, i + 100).map((r) => r.id));
        if (mine !== gen.current) return;
        setPreviewMap((m) => ({ ...m, ...Object.fromEntries(got.map((p) => [p.recordId, p])) }));
      } catch {
        // previews are decoration; a failure leaves the card without one
      }
    }
  }, []);

  const fetchPage = useCallback(
    async (cursor: string | null, mine: number, already: number) => {
      setLoading(true);
      try {
        const res = await ipc.queryRecords({ databaseId, viewId, cursor, limit: pageSize, skipTotal: true, range, extraFilter });
        if (mine !== gen.current) return;
        let got = res.rows;
        let more = res.nextCursor;
        if (already + got.length >= WINDOW_LIMIT && loadAll) {
          got = got.slice(0, WINDOW_LIMIT - already);
          if (more || got.length < res.rows.length) setTruncated(true);
          more = null;
        }
        setRows((r) => (cursor ? [...r, ...got] : got));
        setNext(more);
        if (previews) void fetchPreviews(got, mine);
        if (loadAll && more) return void fetchPage(more, mine, already + got.length);
        setLoading(false);
        setDone(true);
      } catch (e) {
        if (mine !== gen.current) return;
        setError(toAppError(e).message);
        setLoading(false);
        setDone(true);
      }
    },
    // rangeKey stands in for range's identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [databaseId, viewId, pageSize, loadAll, previews, rangeKey, fetchPreviews, extraFilter],
  );

  const reload = useCallback(() => {
    const mine = ++gen.current;
    setRows([]);
    setPreviewMap({});
    setNext(null);
    setDone(false);
    setTruncated(false);
    setError(null);
    if (!enabled) return void setLoading(false);
    void fetchPage(null, mine, 0);
  }, [enabled, fetchPage]);

  useEffect(() => {
    reload();
    return () => { gen.current++; };
  }, [reload, queryVersion]);

  const loadMore = useCallback(() => {
    if (next && !loading) void fetchPage(next, gen.current, rows.length);
  }, [next, loading, fetchPage, rows.length]);

  const replaceRow = useCallback((row: RecordRow) => setRows((r) => r.map((x) => (x.id === row.id ? row : x))), []);
  const removeRow = useCallback((id: string) => setRows((r) => r.filter((x) => x.id !== id)), []);
  const addRow = useCallback((row: RecordRow) => setRows((r) => [row, ...r]), []);

  return { rows, hasMore: !!next, loading, done, truncated, error, previews: previewMap, loadMore, reload, replaceRow, removeRow, addRow };
}

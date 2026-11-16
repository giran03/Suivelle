import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import type { DbView, GroupCount, RecordRow } from "../../types";
import { cursorFor, pageOf } from "./gridNav";
import { useLiveData } from "../../lib/liveData";
import { useExtraFilter, useStable } from "./extraFilter";
import { buildLayout, locate, type HeaderSegment, type Layout } from "./groups";

import { trimRecordPages } from "./recordCache";

export const PAGE_SIZE = 100;

interface State {
  total: number | null;
  groups: GroupCount[] | null;
  pages: Map<string, RecordRow[]>;
  /** Records created in this session, shown below the loaded rows even if they would be filtered out. */
  extras: RecordRow[];
  error: string | null;
}

const fresh = (): State => ({ total: null, groups: null, pages: new Map(), extras: [], error: null });
const keyOf = (g: string | null, s: string | null, page: number) => `${g ?? ""}|${s ?? ""}|${page}`;

export type Item = { type: "row"; row: RecordRow | null } | { type: "header"; header: HeaderSegment };

/**
 * A windowed view of one saved view's records. Only the pages near the viewport are fetched (the
 * server filters, sorts, groups and pages), so a table of 50,000 rows never loads at once. When the
 * view is grouped the list is flattened into group headers and records, each group paged on its own.
 */
export function useRecordTable(databaseId: string | undefined, view: DbView | undefined, queryVersion: number, collapsed: ReadonlySet<string>) {
  const extraFilter = useStable(useExtraFilter());
  const [state, setState] = useState<State>(fresh);
  const requested = useRef(new Set<string>());
  /** Counts edits to loaded records, so numbers derived from them (totals) can refresh. */
  const [edits, setEdits] = useState(0);
  const generation = useRef(0);
  const cached = useRef(new Map<string, RecordRow[]>());
  const wanted = useRef(new Set<string>());
  const argsOf = useRef(new Map<string, [string | null, string | null, number]>());
  const live = useLiveData();
  const seenLive = useRef(live);
  const viewId = view?.id;
  const grouped = !!view?.config.group;

  const fail = (gen: number, e: unknown) => {
    if (gen === generation.current) setState((s) => ({ ...s, error: toAppError(e).message }));
  };

  const fetchPage = useCallback(
    async (g: string | null, s: string | null, page: number) => {
      if (!databaseId || !viewId) return;
      const key = keyOf(g, s, page);
      if (requested.current.has(key) || cached.current.has(key)) return;
      requested.current.add(key);
      argsOf.current.set(key, [g, s, page]);
      const gen = generation.current;
      try {
        const res = await ipc.queryRecords({
          databaseId,
          viewId,
          groupKey: g,
          subgroupKey: s,
          cursor: cursorFor(page, PAGE_SIZE),
          limit: PAGE_SIZE,
          skipTotal: grouped || page > 0,
          extraFilter,
        });
        if (gen !== generation.current) return;
        const pages = new Map(cached.current);
        pages.set(key, res.rows);
        cached.current = trimRecordPages(pages, wanted.current);
        setState((st) => ({ ...st, total: res.total ?? st.total, pages: cached.current, error: null }));
      } catch (e) {
        fail(gen, e);
      } finally {
        if (gen === generation.current) requested.current.delete(key);
      }
    },
    [databaseId, viewId, grouped, extraFilter],
  );

  const reload = useCallback(() => {
    generation.current++;
    requested.current = new Set();
    cached.current = new Map();
    wanted.current = new Set();
    setState(fresh());
    setEdits((n) => n + 1);
    if (!databaseId || !viewId) return;
    if (grouped) {
      const gen = generation.current;
      ipc
        .groupCounts(databaseId, viewId, extraFilter)
        .then((groups) => gen === generation.current && setState((s) => ({ ...s, groups, error: null })))
        .catch((e) => fail(gen, e));
    } else void fetchPage(null, null, 0);
  }, [databaseId, viewId, grouped, fetchPage, extraFilter]);

  /** Refetches the pages already loaded and swaps them in place, so rows do not blank while changes elsewhere arrive. */
  const refresh = useCallback(async () => {
    if (!databaseId || !viewId) return;
    const gen = generation.current;
    const keys = [...cached.current.keys()];
    try {
      let groupTotal: number | null = null;
      let newGroups: GroupCount[] | null = null;
      if (grouped) {
        newGroups = await ipc.groupCounts(databaseId, viewId, extraFilter);
        groupTotal = newGroups.reduce((n, g) => n + g.count, 0);
      }
      const results = await Promise.all(
        keys.map(async (key) => {
          const [g, s, page] = argsOf.current.get(key) ?? [null, null, 0];
          const res = await ipc.queryRecords({ databaseId, viewId, groupKey: g, subgroupKey: s, cursor: cursorFor(page, PAGE_SIZE), limit: PAGE_SIZE, skipTotal: grouped || page > 0, extraFilter });
          return [key, page, res] as const;
        }),
      );
      if (gen !== generation.current) return;
      const pages = new Map(cached.current);
      let total: number | null = null;
      for (const [key, page, res] of results) {
        pages.set(key, res.rows);
        if (!grouped && page === 0 && res.total != null) total = res.total;
      }
      cached.current = pages;
      // A record made here is shown below the list until the list itself includes it. Once the server count has
      // grown by that many, the list has it, so showing it again would duplicate the row.
      setState((st) => {
        const before = grouped ? (st.groups?.reduce((n, g) => n + g.count, 0) ?? null) : st.total;
        const now = grouped ? groupTotal : total;
        const counted = now !== null && before !== null && now >= before + st.extras.length;
        return { ...st, total: total ?? st.total, groups: newGroups ?? st.groups, pages, extras: counted ? [] : st.extras, error: null };
      });
      setEdits((n) => n + 1);
    } catch (e) {
      fail(gen, e);
    }
  }, [databaseId, viewId, grouped, extraFilter]);

  useEffect(() => {
    if (seenLive.current === live) return;
    seenLive.current = live;
    void refresh();
  }, [live, refresh]);

  useEffect(() => {
    if (databaseId && viewId) reload();
    return () => { generation.current++; };
  }, [databaseId, viewId, queryVersion, reload]);

  const layout: Layout | null = useMemo(() => (grouped && state.groups ? buildLayout(state.groups, collapsed) : null), [grouped, state.groups, collapsed]);
  const base = grouped ? (layout?.size ?? 0) : (state.total ?? 0);
  const rowCount = base + state.extras.length;
  const recordCount = grouped ? (state.groups?.reduce((n, g) => n + g.count, 0) ?? 0) : (state.total ?? 0);
  const loaded = grouped ? state.groups !== null : state.total !== null;

  const itemAt = useCallback(
    (index: number): Item => {
      if (index >= base) return { type: "row", row: state.extras[index - base] ?? null };
      if (!layout) return { type: "row", row: state.pages.get(keyOf(null, null, pageOf(index, PAGE_SIZE)))?.[index % PAGE_SIZE] ?? null };
      const at = locate(layout, index);
      if (!at) return { type: "row", row: null };
      if (at.segment.kind === "header") return { type: "header", header: at.segment };
      const { groupKey, subKey } = at.segment;
      return { type: "row", row: state.pages.get(keyOf(groupKey, subKey ?? null, pageOf(at.offset, PAGE_SIZE)))?.[at.offset % PAGE_SIZE] ?? null };
    },
    [base, layout, state.pages, state.extras],
  );

  const rowAt = useCallback((index: number): RecordRow | null => {
    const item = itemAt(index);
    return item.type === "row" ? item.row : null;
  }, [itemAt]);

  /** Fetches whatever pages are needed to show list entries first..last. */
  const ensureRange = useCallback(
    (first: number, last: number, pinned: number[] = []) => {
      const needed = new Map<string, [string | null, string | null, number]>();
      const addRange = (from: number, to: number) => {
        if (!layout) {
          const end = Math.min(to, (state.total ?? 0) - 1);
          for (let p = pageOf(from, PAGE_SIZE); p <= pageOf(end, PAGE_SIZE); p++) {
            needed.set(keyOf(null, null, p), [null, null, p]);
          }
          return;
        }
        for (const seg of layout.segments) {
          if (seg.kind !== "rows" || seg.start + seg.count <= from || seg.start > to) continue;
          const start = pageOf(Math.max(from, seg.start) - seg.start, PAGE_SIZE);
          const end = pageOf(Math.min(to, seg.start + seg.count - 1) - seg.start, PAGE_SIZE);
          for (let p = start; p <= end; p++) {
            needed.set(keyOf(seg.groupKey, seg.subKey ?? null, p), [seg.groupKey, seg.subKey ?? null, p]);
          }
        }
      };
      addRange(first, last);
      pinned.forEach((index) => addRange(index, index));
      wanted.current = new Set(needed.keys());
      // Move visited pages to the end so eviction keeps the most recently used pages.
      for (const key of needed.keys()) {
        const rows = cached.current.get(key);
        if (rows) { cached.current.delete(key); cached.current.set(key, rows); }
      }
      for (const args of needed.values()) void fetchPage(...args);
    },
    [layout, state.total, fetchPage],
  );

  /** Swaps an edited row into the cache wherever it is held. */
  const replaceRow = useCallback((row: RecordRow) => {
    setState((s) => {
      const pages = new Map(s.pages);
      for (const [k, rows] of pages) {
        if (rows.some((r) => r.id === row.id)) pages.set(k, rows.map((r) => (r.id === row.id ? row : r)));
      }
      cached.current = pages;
      return { ...s, pages, extras: s.extras.map((r) => (r.id === row.id ? row : r)) };
    });
    setEdits((n) => n + 1);
  }, []);

  /** Swaps many edited rows into the cache at once. */
  const replaceRows = useCallback((rows: RecordRow[]) => {
    if (rows.length === 0) return;
    const byId = new Map(rows.map((r) => [r.id, r]));
    setState((s) => {
      const swap = (list: RecordRow[]) => (list.some((r) => byId.has(r.id)) ? list.map((r) => byId.get(r.id) ?? r) : list);
      const pages = new Map(s.pages);
      for (const [k, list] of pages) pages.set(k, swap(list));
      cached.current = pages;
      return { ...s, pages, extras: swap(s.extras) };
    });
    setEdits((n) => n + 1);
  }, []);

  const loadedRows = useCallback((): { index: number; row: RecordRow }[] => {
    const out: { index: number; row: RecordRow }[] = [];
    const append = (key: string, start: number, count: number) => {
      const prefix = `${key}|`;
      for (const [pageKey, rows] of state.pages) {
        if (!pageKey.startsWith(prefix)) continue;
        const offset = Number(pageKey.slice(prefix.length)) * PAGE_SIZE;
        rows.forEach((row, i) => { if (offset + i < count) out.push({ index: start + offset + i, row }); });
      }
    };
    if (!layout) append("|", 0, base);
    else for (const seg of layout.segments) {
      if (seg.kind === "rows") append(`${seg.groupKey}|${seg.subKey ?? ""}`, seg.start, seg.count);
    }
    state.extras.forEach((row, i) => out.push({ index: base + i, row }));
    return out.sort((a, b) => a.index - b.index);
  }, [state.pages, state.extras, layout, base]);

  /** A loaded record by id, wherever it is held; undefined when it is not in memory. */
  const findRow = useCallback((id: string): RecordRow | undefined => {
    for (const rows of state.pages.values()) {
      const hit = rows.find((r) => r.id === id);
      if (hit) return hit;
    }
    return state.extras.find((r) => r.id === id);
  }, [state.pages, state.extras]);

  const addExtra = useCallback((row: RecordRow) => {
    setState((s) => ({ ...s, extras: [...s.extras, row] }));
    setEdits((n) => n + 1);
  }, []);

  /** Forgets a record that was shown below the loaded rows (it was trashed or undone). */
  const removeExtra = useCallback((id: string) => {
    setState((s) => ({ ...s, extras: s.extras.filter((r) => r.id !== id) }));
    setEdits((n) => n + 1);
  }, []);

  return { edits, removeExtra, total: recordCount, loaded, rowCount, error: state.error, groups: state.groups, itemAt, rowAt, loadedRows, findRow, ensureRange, replaceRow, replaceRows, addExtra, reload };
}

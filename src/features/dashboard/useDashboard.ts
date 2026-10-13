import { useCallback, useEffect, useRef, useState } from "react";
import { READ_ONLY } from "../../lib/access";
import { registerFlusher } from "../editor/flushRegistry";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { DashboardLayout, DatabaseDetail, DatabaseRef } from "../../types";

const SAVE_DELAY = 400;

/** Loads a dashboard and saves layout edits shortly after they stop. Leaving the page saves at once. */
export function useDashboard(pageId: string) {
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setGlobalError = useWorkspace((s) => s.setError);
  const pending = useRef<DashboardLayout | null>(null);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<number | undefined>(undefined);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    if (!next) return chain.current;
    pending.current = null;
    chain.current = chain.current.then(async () => {
      try { await ipc.dashboardSave(pageId, next); return true; }
      catch (e) { if (!pending.current) pending.current = next; setGlobalError(`The dashboard could not be saved. ${toAppError(e).message}`); return false; }
    });
    return chain.current;
  }, [pageId, setGlobalError]);

  useEffect(() => registerFlusher(async () => { if (!await flush() || pending.current) throw new Error("Save the dashboard before switching workspaces. Try again to retry the save."); }), [flush]);

  useEffect(() => {
    let cancelled = false;
    setLayout(null);
    setError(null);
    ipc
      .dashboardGet(pageId)
      .then((d) => !cancelled && setLayout(d.layout))
      .catch((e) => !cancelled && setError(toAppError(e).message));
    return () => {
      cancelled = true;
      void flush();
    };
  }, [pageId, flush]);

  const update = useCallback(
    (next: DashboardLayout, immediate = false) => {
      setLayout(next);
      if (READ_ONLY) return; // Showcase filters are temporary display state, never saved content.
      pending.current = next;
      window.clearTimeout(timer.current);
      if (immediate) void flush();
      else timer.current = window.setTimeout(() => void flush(), SAVE_DELAY);
    },
    [flush],
  );

  return { layout, error, update };
}

/** The databases a dashboard's widgets use: their names, properties and views, loaded once each. */
export function useDashboardDatabases(workspaceId: string | undefined, databaseIds: string[]) {
  const [refs, setRefs] = useState<DatabaseRef[] | null>(null);
  const [details, setDetails] = useState<Record<string, DatabaseDetail>>({});
  const asked = useRef(new Set<string>());
  const key = [...new Set(databaseIds)].sort().join(",");

  const loadRefs = useCallback(() => {
    if (workspaceId) void ipc.databaseList(workspaceId).then(setRefs).catch(() => setRefs([]));
  }, [workspaceId]);
  useEffect(loadRefs, [loadRefs]);

  useEffect(() => {
    if (!refs) return;
    for (const id of key ? key.split(",") : []) {
      const ref = refs.find((r) => r.id === id);
      if (!ref || asked.current.has(id)) continue;
      asked.current.add(id);
      ipc
        .databaseGet(ref.pageId)
        .then((d) => setDetails((s) => ({ ...s, [id]: d })))
        .catch(() => asked.current.delete(id));
    }
  }, [refs, key]);

  /** Fetches a database that is not part of the layout yet (the add-widget flow). */
  const fetchDetail = useCallback(
    async (ref: DatabaseRef) => {
      const d = await ipc.databaseGet(ref.pageId);
      asked.current.add(ref.id);
      setDetails((s) => ({ ...s, [ref.id]: d }));
      return d;
    },
    [],
  );

  return { refs, details, fetchDetail, reloadRefs: loadRefs };
}

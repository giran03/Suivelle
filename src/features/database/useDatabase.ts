import "../../lib/legacy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerFlusher } from "../editor/flushRegistry";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { DatabaseDetail, DbView, Property, PropertyType, ViewColumn, ViewConfig, ViewType } from "../../types";

export interface Column {
  property: Property;
  column: ViewColumn;
}

const activeKey = (databaseId: string) => `suivelle.view.${databaseId}`;

function readActive(databaseId: string): string | null {
  try {
    return localStorage.getItem(activeKey(databaseId));
  } catch {
    return null;
  }
}

/**
 * Loads a database and owns its schema and saved views. View edits apply immediately and are saved
 * (filters debounced); the server's normalized config replaces the local one when it comes back.
 */
export function useDatabase(pageId: string, forcedViewId?: string) {
  const [detail, setDetail] = useState<DatabaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Bumped whenever the set of rows may have changed (filter, sort, grouping, schema). */
  const [queryVersion, setQueryVersion] = useState(0);
  const pendingSave = useRef<(() => Promise<void>) | null>(null);
  const saveChain = useRef<Promise<boolean>>(Promise.resolve(true));
  const saveVersion = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);
  const setGlobalError = useWorkspace((s) => s.setError);
  const dataEpoch = useWorkspace((s) => s.dataEpoch);
  const seenEpoch = useRef(dataEpoch);
  // A button or an automation changed records somewhere: every view reloads its rows.
  useEffect(() => {
    if (seenEpoch.current === dataEpoch) return;
    seenEpoch.current = dataEpoch;
    setQueryVersion((v) => v + 1);
  }, [dataEpoch]);

  const fail = useCallback((e: unknown) => setGlobalError(toAppError(e).message), [setGlobalError]);

  const flushView = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const job = pendingSave.current;
    if (!job) return saveChain.current;
    pendingSave.current = null;
    saveChain.current = saveChain.current.then(async () => {
      try { await job(); return true; }
      catch (e) { if (!pendingSave.current) pendingSave.current = job; fail(e); return false; }
    });
    return saveChain.current;
  }, [fail]);
  useEffect(() => {
    const unregister = registerFlusher(async () => { if (!await flushView() || pendingSave.current) throw new Error("Save the database view before switching workspaces. Try again to retry the save."); });
    return () => { unregister(); void flushView(); };
  }, [flushView]);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    ipc
      .databaseGet(pageId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        const remembered = readActive(d.database.id);
        setActiveId(forcedViewId && d.views.some((v) => v.id === forcedViewId) ? forcedViewId : d.views.some((v) => v.id === remembered) ? remembered : d.views[0].id);
      })
      .catch((e) => !cancelled && setError(toAppError(e).message));
    return () => {
      cancelled = true;
    };
  }, [pageId, forcedViewId]);

  const views = detail?.views;
  const view: DbView | undefined = useMemo(() => views?.find((v) => v.id === activeId) ?? views?.[0], [views, activeId]);
  const properties = detail?.properties;
  const config = view?.config;
  const viewId = view?.id;
  const byId = useMemo(() => new Map((properties ?? []).map((p) => [p.id, p])), [properties]);

  /** Columns in view order, each with its property, hidden ones included. */
  const allColumns = useMemo<Column[]>(
    () =>
      (config?.columns ?? []).flatMap((column) => {
        const property = byId.get(column.propertyId);
        return property ? [{ property, column }] : [];
      }),
    [config, byId],
  );
  const columns = useMemo(() => allColumns.filter((c) => !c.column.hidden), [allColumns]);

  const replaceView = useCallback((saved: DbView) => setDetail((d) => (d ? { ...d, views: d.views.map((v) => (v.id === saved.id ? saved : v)) } : d)), []);

  const setActiveView = useCallback(
    (id: string) => {
      setActiveId(id);
      if (detail && !forcedViewId) {
        try {
          localStorage.setItem(activeKey(detail.database.id), id);
        } catch {
          // remembering the tab is a convenience only
        }
      }
    },
    [detail, forcedViewId],
  );

  const saveView = useCallback(
    (next: ViewConfig, rowsChanged: boolean, debounce = 0) => {
      if (!viewId) return;
      setDetail((d) => (d ? { ...d, views: d.views.map((v) => (v.id === viewId ? { ...v, config: next } : v)) } : d));
      window.clearTimeout(saveTimer.current);
      const version = ++saveVersion.current;
      pendingSave.current = async () => {
        const saved = await ipc.viewUpdate(viewId, next);
        if (version === saveVersion.current) replaceView(saved);
        if (rowsChanged) setQueryVersion((v) => v + 1);
      };
      if (debounce) saveTimer.current = window.setTimeout(() => void flushView(), debounce);
      else void flushView();
    },
    [viewId, flushView, replaceView],
  );

  const updateView = useCallback(
    (patch: Partial<ViewConfig>, opts: { rows?: boolean; debounce?: number } = {}) => {
      if (!config) return;
      saveView({ ...config, ...patch }, opts.rows ?? false, opts.debounce ?? 0);
    },
    [config, saveView],
  );

  const patchColumn = useCallback(
    (propertyId: string, patch: Partial<ViewColumn>) => {
      if (!config) return;
      updateView({ columns: config.columns.map((c) => (c.propertyId === propertyId ? { ...c, ...patch } : c)) });
    },
    [config, updateView],
  );

  /** Swaps a column with its visible neighbour. */
  const moveColumn = useCallback(
    (propertyId: string, dir: -1 | 1) => {
      if (!config) return;
      const cols = [...config.columns];
      const i = cols.findIndex((c) => c.propertyId === propertyId);
      let j = i + dir;
      while (j >= 0 && j < cols.length && cols[j].hidden) j += dir;
      if (i < 0 || j < 0 || j >= cols.length) return;
      [cols[i], cols[j]] = [cols[j], cols[i]];
      updateView({ columns: cols });
    },
    [config, updateView],
  );

  const createView = useCallback(
    async (type: ViewType, name?: string) => {
      if (!detail) return;
      try {
        const created = await ipc.viewCreate(detail.database.id, type, name);
        setDetail((d) => (d ? { ...d, views: [...d.views, created] } : d));
        setActiveView(created.id);
      } catch (e) {
        fail(e);
      }
    },
    [detail, fail, setActiveView],
  );

  const renameView = useCallback(
    async (id: string, name: string) => {
      const target = views?.find((v) => v.id === id);
      if (!target || !name.trim()) return;
      try {
        replaceView(await ipc.viewUpdate(id, target.config, name));
      } catch (e) {
        fail(e);
      }
    },
    [views, fail, replaceView],
  );

  const duplicateView = useCallback(
    async (id: string) => {
      try {
        const copy = await ipc.viewDuplicate(id);
        setDetail((d) => (d ? { ...d, views: [...d.views, copy] } : d));
        setActiveView(copy.id);
      } catch (e) {
        fail(e);
      }
    },
    [fail, setActiveView],
  );

  const deleteView = useCallback(
    async (id: string) => {
      if (!detail) return;
      try {
        await ipc.viewDelete(id);
        const remaining = detail.views.filter((v) => v.id !== id);
        setDetail({ ...detail, views: remaining });
        if (activeId === id) setActiveView(remaining[0].id);
      } catch (e) {
        fail(e);
      }
    },
    [detail, activeId, fail, setActiveView],
  );

  const addProperty = useCallback(
    async (name: string, type: PropertyType, config?: unknown) => {
      if (!detail) return null;
      try {
        const prop = await ipc.propertyCreate({ databaseId: detail.database.id, name, type, config });
        // Other views learn about the new column too; refetch so every tab agrees with the server.
        setDetail(await ipc.databaseGet(pageId));
        // Calculated values are computed when rows load, so existing rows need another look.
        if (type === "formula" || type === "rollup") setQueryVersion((v) => v + 1);
        return prop;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [detail, pageId, fail],
  );

  const updateProperty = useCallback(
    async (id: string, patch: { name?: string; config?: unknown }) => {
      try {
        const prop = await ipc.propertyUpdate({ id, ...patch });
        setDetail((d) => (d ? { ...d, properties: d.properties.map((p) => (p.id === id ? prop : p)) } : d));
        // A rename rewrites formulas that use the name, and a formula or rollup edit changes values:
        // take the server's version of the schema and reload the rows.
        if (patch.name !== undefined || prop.type === "formula" || prop.type === "rollup") {
          setDetail(await ipc.databaseGet(pageId));
          setQueryVersion((v) => v + 1);
        }
        return prop;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [fail, pageId],
  );

  const deleteProperty = useCallback(
    async (id: string) => {
      try {
        await ipc.propertyDelete(id);
        setDetail(await ipc.databaseGet(pageId));
        setQueryVersion((v) => v + 1);
      } catch (e) {
        fail(e);
      }
    },
    [pageId, fail],
  );

  return {
    detail,
    error,
    queryVersion,
    /** Reloads the records a view shows (after one was added elsewhere). */
    refreshRows: () => setQueryVersion((v) => v + 1),
    byId,
    views,
    view,
    columns,
    allColumns,
    updateView,
    patchColumn,
    moveColumn,
    setActiveView,
    createView,
    renameView,
    duplicateView,
    deleteView,
    addProperty,
    updateProperty,
    deleteProperty,
  };
}

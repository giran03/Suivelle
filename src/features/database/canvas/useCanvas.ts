import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc, toAppError } from "../../../lib/ipc";
import type { CanvasData, CanvasOp } from "../../../types";

const FLUSH_MS = 300;

/** The same edits the backend makes, applied locally so the board responds before the save lands. */
export function applyOps(data: CanvasData, ops: CanvasOp[]): CanvasData {
  let { items, edges } = data;
  for (const op of ops) {
    if (op.op === "upsert_item") {
      items = items.some((i) => i.id === op.item.id) ? items.map((i) => (i.id === op.item.id ? op.item : i)) : [...items, op.item];
    } else if (op.op === "delete_item") {
      items = items.filter((i) => i.id !== op.id);
      edges = edges.filter((e) => e.fromItem !== op.id && e.toItem !== op.id);
    } else if (op.op === "upsert_edge") {
      edges = edges.some((e) => e.id === op.edge.id) ? edges.map((e) => (e.id === op.edge.id ? op.edge : e)) : [...edges, op.edge];
    } else {
      edges = edges.filter((e) => e.id !== op.id);
    }
  }
  return { items, edges };
}

/** The edits that undo `ops` when applied to the state they were applied to (`before`). */
export function inverseOf(before: CanvasData, ops: CanvasOp[]): CanvasOp[] {
  let cur = before;
  const groups: CanvasOp[][] = [];
  for (const op of ops) {
    const g: CanvasOp[] = [];
    if (op.op === "upsert_item") {
      const old = cur.items.find((i) => i.id === op.item.id);
      g.push(old ? { op: "upsert_item", item: old } : { op: "delete_item", id: op.item.id });
    } else if (op.op === "delete_item") {
      const old = cur.items.find((i) => i.id === op.id);
      if (old) {
        g.push({ op: "upsert_item", item: old });
        for (const e of cur.edges) if (e.fromItem === op.id || e.toItem === op.id) g.push({ op: "upsert_edge", edge: e });
      }
    } else if (op.op === "upsert_edge") {
      const old = cur.edges.find((e) => e.id === op.edge.id);
      g.push(old ? { op: "upsert_edge", edge: old } : { op: "delete_edge", id: op.edge.id });
    } else {
      const old = cur.edges.find((e) => e.id === op.id);
      if (old) g.push({ op: "upsert_edge", edge: old });
    }
    groups.push(g);
    cur = applyOps(cur, [op]);
  }
  return groups.reverse().flat();
}

const HISTORY_LIMIT = 100;
interface HistoryEntry {
  undo: CanvasOp[];
  redo: CanvasOp[];
}

/** Folds repeated edits to the same item or arrow into the last one, so a drag sends one update. */
export function coalesce(ops: CanvasOp[]): CanvasOp[] {
  const out: CanvasOp[] = [];
  const at = new Map<string, number>();
  for (const op of ops) {
    const key = op.op === "upsert_item" ? `i:${op.item.id}` : op.op === "upsert_edge" ? `e:${op.edge.id}` : null;
    if (key && at.has(key)) {
      out[at.get(key)!] = op;
    } else {
      // A later re-add must not be folded into an upsert that comes before this delete.
      if (op.op === "delete_item") at.delete(`i:${op.id}`);
      if (op.op === "delete_edge") at.delete(`e:${op.id}`);
      if (key) at.set(key, out.length);
      out.push(op);
    }
  }
  return out;
}

/**
 * One canvas's items and arrows (a database view's, or with `scope` "board" a workspace board's). `apply` updates the board at once and saves the batch a moment
 * later; if the save is refused the board is reloaded from the database and the reason is shown.
 */
export function useCanvas(viewId: string, scope: "view" | "board" = "view") {
  const [data, setData] = useState<CanvasData | null>(null);
  const dataRef = useRef<CanvasData | null>(null);
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const [, setHistoryVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<CanvasOp[]>([]);
  const timer = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = scope === "board" ? await ipc.canvasBoardLoad(viewId) : await ipc.canvasLoad(viewId);
      if (!alive.current) return;
      dataRef.current = d;
      setData(d);
    } catch (e) {
      if (alive.current) setError(toAppError(e).message);
    }
  }, [viewId, scope]);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const ops = coalesce(pending.current);
    pending.current = [];
    if (!ops.length) return chain.current;
    chain.current = chain.current.then(async () => {
      try {
        await (scope === "board" ? ipc.canvasBoardApply(viewId, ops) : ipc.canvasApply(viewId, ops));
      } catch (e) {
        if (!alive.current) return;
        setError(toAppError(e).message);
        await load();
      }
    });
    return chain.current;
  }, [viewId, scope, load]);

  useEffect(() => {
    alive.current = true;
    dataRef.current = null;
    undoStack.current = [];
    redoStack.current = [];
    setData(null);
    setError(null);
    void load();
    return () => {
      alive.current = false;
      void flush();
    };
  }, [load, flush]);

  const apply = useCallback(
    (ops: CanvasOp[]) => {
      if (!ops.length || !dataRef.current) return;
      dataRef.current = applyOps(dataRef.current, ops);
      setData(dataRef.current);
      pending.current.push(...ops);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), FLUSH_MS);
    },
    [flush],
  );

  const record = useCallback((entry: HistoryEntry) => {
    if (!entry.undo.length && !entry.redo.length) return;
    undoStack.current.push(entry);
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = [];
    setHistoryVersion((v) => v + 1);
  }, []);

  /** An undoable edit: applies `ops` and remembers how to take them back. */
  const commit = useCallback(
    (ops: CanvasOp[]) => {
      if (!ops.length || !dataRef.current) return;
      record({ undo: inverseOf(dataRef.current, ops), redo: ops });
      apply(ops);
    },
    [apply, record],
  );

  /** Remembers an edit that was already applied live (a drag), given the state from before it began. */
  const commitApplied = useCallback(
    (before: CanvasData, ops: CanvasOp[]) => record({ undo: inverseOf(before, ops), redo: ops }),
    [record],
  );

  const undo = useCallback(() => {
    const e = undoStack.current.pop();
    if (!e) return;
    redoStack.current.push(e);
    apply(e.undo);
    setHistoryVersion((v) => v + 1);
  }, [apply]);

  const redo = useCallback(() => {
    const e = redoStack.current.pop();
    if (!e) return;
    undoStack.current.push(e);
    apply(e.redo);
    setHistoryVersion((v) => v + 1);
  }, [apply]);

  const snapshot = useCallback(() => dataRef.current, []);
  const canUndo = undoStack.current.length > 0;
  const canRedo = redoStack.current.length > 0;

  const clearError = useCallback(() => setError(null), []);
  return useMemo(
    () => ({ data, error, clearError, apply, commit, commitApplied, undo, redo, canUndo, canRedo, snapshot, flush, reload: load }),
    [data, error, clearError, apply, commit, commitApplied, undo, redo, canUndo, canRedo, snapshot, flush, load],
  );
}

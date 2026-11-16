import { useEffect, useMemo, useRef, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { syncDialog } from "../../lib/dialog";
import { useWorkspace } from "../../stores/workspace";
import type { Property, RecordRow } from "../../types";
import { useExtraFilter, useStable } from "./extraFilter";
import { CELL_LIMIT, isReplaceable, planReplace, SCAN_LIMIT, writes } from "./findReplace";

interface Props {
  open: boolean;
  onClose: () => void;
  databaseId: string;
  viewId: string;
  /** The properties this view shows. */
  properties: Property[];
  /** Reload the table after records changed. */
  onChanged: () => void;
}

/**
 * Find and replace over the text of the records in the current view's filtered set, not just the rows
 * on screen. Nothing changes until "Replace" is pressed, the preview shows the count first, and one
 * Undo puts every cell back.
 */
export function FindReplaceDialog({ open, onClose, ...rest }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current) syncDialog(ref.current, open);
  }, [open]);
  return (
    <dialog ref={ref} className="palette tpl-dialog data-dialog" aria-label="Find and replace" onClose={onClose} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {open && <Body onClose={onClose} {...rest} />}
    </dialog>
  );
}

function Body({ onClose, databaseId, viewId, properties, onChanged }: Omit<Props, "open">) {
  const notify = useWorkspace((s) => s.notify);
  const setError = useWorkspace((s) => s.setError);
  const extraFilter = useStable(useExtraFilter());
  const textProps = useMemo(() => properties.filter(isReplaceable), [properties]);
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeCell, setWholeCell] = useState(false);
  const [scope, setScope] = useState("*");
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanCut, setScanCut] = useState(false);
  const [busy, setBusy] = useState(false);

  // Read the filtered set once; typing then only re-plans in memory.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all: RecordRow[] = [];
      let cursor: string | null = null;
      let cut = false;
      try {
        do {
          const page = await ipc.queryRecords({ databaseId, viewId, cursor, limit: 200, skipTotal: true, extraFilter });
          all.push(...page.rows);
          cursor = page.nextCursor;
          if (all.length >= SCAN_LIMIT) {
            cut = !!cursor || all.length > SCAN_LIMIT;
            all.length = Math.min(all.length, SCAN_LIMIT);
            break;
          }
        } while (cursor && !cancelled);
        if (!cancelled) {
          setRows(all);
          setScanCut(cut);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(toAppError(e).message);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [databaseId, viewId, extraFilter, setError]);

  const targets = useMemo(() => (scope === "*" ? textProps : textProps.filter((p) => p.id === scope)), [scope, textProps]);
  const plan = useMemo(() => planReplace(rows, targets, { find, replace, matchCase, wholeCell }), [rows, targets, find, replace, matchCase, wholeCell]);
  const byId = useMemo(() => new Map(properties.map((p) => [p.id, p])), [properties]);
  const names = (id: string) => byId.get(id)?.name ?? "";

  const apply = async () => {
    if (plan.changes.length === 0) return;
    setBusy(true);
    try {
      const count = plan.changes.length;
      const touched = plan.records;
      await ipc.recordSetCells(writes(plan, byId, "apply"));
      onChanged();
      onClose();
      notify(`Replaced in ${count.toLocaleString()} cell${count === 1 ? "" : "s"} of ${touched.toLocaleString()} record${touched === 1 ? "" : "s"}`, async () => {
        try {
          await ipc.recordSetCells(writes(plan, byId, "undo"));
        } catch (e) {
          setError(toAppError(e).message);
        }
        onChanged();
      });
    } catch (e) {
      setError(toAppError(e).message);
      setBusy(false);
    }
  };

  const sample = plan.changes.slice(0, 5);
  return (
    <form
      className="data-body"
      onSubmit={(e) => {
        e.preventDefault();
        void apply();
      }}
    >
      <h2 className="data-title">Find and replace</h2>
      <div className="data-fields">
        <label className="field">
          <span>Find</span>
          <input autoFocus value={find} maxLength={200} onChange={(e) => setFind(e.target.value)} />
        </label>
        <label className="field">
          <span>Replace with</span>
          <input value={replace} maxLength={2000} onChange={(e) => setReplace(e.target.value)} />
        </label>
        <label className="field">
          <span>Look in</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="*">All text properties in this view</option>
            {textProps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="data-options">
        <label className="check-row">
          <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
          Match case
        </label>
        <label className="check-row">
          <input type="checkbox" checked={wholeCell} onChange={(e) => setWholeCell(e.target.checked)} />
          Whole cell only
        </label>
      </div>
      <div className="data-preview" role="status" aria-live="polite">
        {loading ? (
          <p className="picker-muted">Reading the records…</p>
        ) : !find ? (
          <p className="picker-muted">
            {rows.length.toLocaleString()} record{rows.length === 1 ? "" : "s"} in this view
            {targets.length === 0 ? ". It shows no text properties, so there is nothing to replace." : "."}
          </p>
        ) : plan.changes.length === 0 ? (
          <p className="picker-muted">No matches{plan.skipped ? `, and ${plan.skipped} would not be valid for their property` : ""}.</p>
        ) : (
          <>
            <p>
              <strong>{plan.changes.length.toLocaleString()}</strong> cell{plan.changes.length === 1 ? "" : "s"} in <strong>{plan.records.toLocaleString()}</strong> record{plan.records === 1 ? "" : "s"} will change.
              {plan.skipped > 0 && <span className="picker-muted"> {plan.skipped} more would not be valid for their property and are left alone.</span>}
            </p>
            <ul className="data-sample">
              {sample.map((c) => (
                <li key={`${c.recordId}-${c.propertyId}`}>
                  <span className="picker-muted">{names(c.propertyId)}: </span>
                  <del>{c.before}</del> <ins>{c.after || "(empty)"}</ins>
                </li>
              ))}
            </ul>
          </>
        )}
        {scanCut && (
          <p className="picker-muted">
            This view has more than {SCAN_LIMIT.toLocaleString()} records, so only the first {SCAN_LIMIT.toLocaleString()} were searched. Narrow the view with a filter to reach the rest.
          </p>
        )}
        {plan.capped && <p className="picker-muted">More than {CELL_LIMIT.toLocaleString()} cells match. This run changes the first {CELL_LIMIT.toLocaleString()}; run it again for the rest.</p>}
      </div>
      <div className="picker-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={busy || loading || plan.changes.length === 0}>
          {plan.changes.length ? `Replace ${plan.changes.length.toLocaleString()}` : "Replace"}
        </button>
      </div>
    </form>
  );
}

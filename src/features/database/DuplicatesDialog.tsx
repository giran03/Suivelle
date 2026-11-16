import { useEffect, useRef, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import { syncDialog } from "../../lib/dialog";
import { useWorkspace } from "../../stores/workspace";
import type { DuplicateReport, Property } from "../../types";
import { supportsChecks } from "./DataChecks";

interface Props {
  open: boolean;
  onClose: () => void;
  databaseId: string;
  properties: Property[];
  onChanged: () => void;
}

const MAX_PICKED = 5;
const SHOWN_GROUPS = 8;

export function DuplicatesDialog({ open, onClose, ...rest }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current) syncDialog(ref.current, open);
  }, [open]);
  return (
    <dialog ref={ref} className="palette tpl-dialog data-dialog" aria-label="Remove duplicates" onClose={onClose} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {open && <Body onClose={onClose} {...rest} />}
    </dialog>
  );
}

/**
 * Pick the properties that must match, preview the groups of duplicate records, then move the extras
 * to the trash. The oldest record of each group stays, and Undo restores the rest.
 */
function Body({ onClose, databaseId, properties, onChanged }: Omit<Props, "open">) {
  const notify = useWorkspace((s) => s.notify);
  const setError = useWorkspace((s) => s.setError);
  const choices = properties.filter((p) => supportsChecks(p.type));
  const [picked, setPicked] = useState<string[]>(() => choices.filter((p) => p.type === "title").map((p) => p.id));
  const [report, setReport] = useState<DuplicateReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (picked.length === 0) {
      setReport(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    ipc
      .recordDuplicates(databaseId, picked)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((e) => {
        if (!cancelled) {
          setReport(null);
          setError(toAppError(e).message);
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [databaseId, picked, setError]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_PICKED ? [...p, id] : p));

  const extras = report ? report.groups.flatMap((g) => g.records.slice(1)) : [];

  const remove = async () => {
    if (extras.length === 0) return;
    setBusy(true);
    const trashed: string[] = [];
    let failed = 0;
    let first: string | undefined;
    for (const r of extras) {
      try {
        await ipc.pageDelete(r.pageId);
        trashed.push(r.pageId);
      } catch (e) {
        failed++;
        first ??= toAppError(e).message;
      }
    }
    onChanged();
    onClose();
    if (failed) setError(`${failed} record${failed === 1 ? "" : "s"} could not be moved to the trash. ${first ?? ""}`);
    if (trashed.length) {
      notify(`Moved ${trashed.length.toLocaleString()} duplicate${trashed.length === 1 ? "" : "s"} to trash`, async () => {
        for (const id of trashed) await ipc.pageRestore(id).catch((e) => setError(toAppError(e).message));
        onChanged();
      });
    }
  };

  return (
    <form
      className="data-body"
      onSubmit={(e) => {
        e.preventDefault();
        void remove();
      }}
    >
      <h2 className="data-title">Remove duplicates</h2>
      <fieldset className="data-fields dup-props">
        <legend className="picker-muted">Records are duplicates when all of these match (up to {MAX_PICKED})</legend>
        {choices.map((p) => (
          <label key={p.id} className="check-row">
            <input type="checkbox" checked={picked.includes(p.id)} disabled={!picked.includes(p.id) && picked.length >= MAX_PICKED} onChange={() => toggle(p.id)} />
            {p.name}
          </label>
        ))}
      </fieldset>
      <div className="data-preview" role="status" aria-live="polite">
        {picked.length === 0 ? (
          <p className="picker-muted">Choose at least one property.</p>
        ) : loading && !report ? (
          <p className="picker-muted">Looking for duplicates…</p>
        ) : report && report.groupCount === 0 ? (
          <p className="picker-muted">No duplicates found.</p>
        ) : report ? (
          <>
            <p>
              <strong>{report.groupCount.toLocaleString()}</strong> group{report.groupCount === 1 ? "" : "s"} of duplicates. <strong>{extras.length.toLocaleString()}</strong> record{extras.length === 1 ? "" : "s"} will move to the trash; the oldest of each group stays.
            </p>
            <ul className="data-sample">
              {report.groups.slice(0, SHOWN_GROUPS).map((g, i) => (
                <li key={i}>
                  {g.label || g.records[0].title || "Untitled"} <span className="picker-muted">× {g.records.length}</span>
                </li>
              ))}
              {report.groups.length > SHOWN_GROUPS && <li className="picker-muted">and {(report.groups.length - SHOWN_GROUPS).toLocaleString()} more groups</li>}
            </ul>
            {report.truncated && <p className="picker-muted">There are {report.groupCount.toLocaleString()} groups; this run handles the first {report.groups.length.toLocaleString()}. Run it again for the rest.</p>}
          </>
        ) : null}
      </div>
      <div className="picker-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn danger" disabled={busy || loading || extras.length === 0}>
          {extras.length ? `Move ${extras.length.toLocaleString()} to trash` : "Move to trash"}
        </button>
      </div>
    </form>
  );
}

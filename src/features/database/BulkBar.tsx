import { useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { Popover, anchorOf, type Anchor } from "../../components/Popover";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Property, RecordRow, ViewConfig } from "../../types";
import { DateEditor, OptionPicker, parseEntry } from "./editors";
import { isOptionType, TYPE_META } from "./model";
import type { useDatabase } from "./useDatabase";
import type { useRecordTable } from "./useRecordTable";

type Db = ReturnType<typeof useDatabase>;
type Table = ReturnType<typeof useRecordTable>;

/** Types a bulk edit can set to one value for every selected record. */
export const BULK_SETTABLE = (p: Property) => TYPE_META[p.type].editable && !["title", "relation", "button"].includes(p.type);

type Step = { kind: "pick"; anchor: Anchor } | { kind: "edit"; prop: Property; anchor: Anchor };

/**
 * What can be done to the selected records at once: set one property for all of them, duplicate
 * them, or move them to the trash. Everything has an Undo, and a failure part-way is reported with
 * the count that did change rather than hidden.
 */
export function BulkBar({ rows, view, db, table, onClear, onRowUpdated }: { rows: RecordRow[]; view: ViewConfig; db: Db; table: Table; onClear: () => void; onRowUpdated: (row: RecordRow) => void }) {
  const [step, setStep] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const notify = useWorkspace((s) => s.notify);
  const setError = useWorkspace((s) => s.setError);
  const settable = useMemo(() => db.allColumns.map((c) => c.property).filter(BULK_SETTABLE), [db.allColumns]);

  /** Runs `fn` for every record, one at a time, and says how many worked. */
  const each = async (fn: (row: RecordRow) => Promise<void>): Promise<{ done: number; failed: number; first?: string }> => {
    let done = 0;
    let failed = 0;
    let first: string | undefined;
    for (const row of rows) {
      try {
        await fn(row);
        done++;
      } catch (e) {
        failed++;
        first ??= toAppError(e).message;
      }
    }
    return { done, failed, first };
  };

  const noun = (n: number) => (n === 1 ? "record" : "records");
  const report = (verb: string, r: { done: number; failed: number; first?: string }, undo?: () => Promise<void>) => {
    if (r.failed) setError(`${r.failed} of ${r.done + r.failed} ${noun(r.done + r.failed)} could not be changed. ${r.first ?? ""}`.trim());
    if (r.done) notify(`${verb} ${r.done} ${noun(r.done)}`, undo);
  };

  const applyRows = (updated: RecordRow[]) => {
    for (const row of updated) {
      table.replaceRow(row);
      onRowUpdated(row);
    }
  };

  /** All-or-nothing: if any record refuses the value, none of them change. */
  const setProperty = async (prop: Property, value: unknown) => {
    setStep(null);
    setBusy(true);
    const ids = rows.map((r) => r.id);
    // Undo puts back what each record had, one batch per distinct old value.
    const groups = new Map<string, { value: unknown; ids: string[] }>();
    for (const r of rows) {
      const old = r.values[prop.id] ?? null;
      const key = JSON.stringify(old);
      const g = groups.get(key) ?? { value: old, ids: [] };
      g.ids.push(r.id);
      groups.set(key, g);
    }
    try {
      applyRows(await ipc.recordBulkSet(prop.id, ids, value));
      if (view.group?.propertyId === prop.id || view.subgroup?.propertyId === prop.id) table.reload();
      notify(`Updated “${prop.name}” on ${ids.length} ${noun(ids.length)}`, async () => {
        try {
          for (const g of groups.values()) applyRows(await ipc.recordBulkSet(prop.id, g.ids, g.value));
          table.reload();
        } catch (e) {
          setError(toAppError(e).message);
        }
      });
    } catch (e) {
      setError(`Nothing was changed. ${toAppError(e).message}`);
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    setBusy(true);
    const r = await each(async (row) => table.addExtra(await ipc.recordDuplicate(row.id)));
    setBusy(false);
    report("Duplicated", r);
  };

  const trash = async () => {
    setBusy(true);
    const trashed: RecordRow[] = [];
    const r = await each(async (row) => {
      await ipc.pageDelete(row.pageId);
      trashed.push(row);
    });
    table.reload();
    setBusy(false);
    if (r.done) onClear();
    report("Moved to trash:", r, async () => {
      for (const row of trashed) await ipc.pageRestore(row.pageId).catch((e) => setError(toAppError(e).message));
      table.reload();
    });
  };

  const count = rows.length;
  return (
    <div
      className="bulk-bar"
      role="toolbar"
      aria-label={`${count} selected`}
      onKeyDown={(e) => {
        // Arrow keys move between the buttons, as a toolbar should.
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
        const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)")];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (at < 0) return;
        e.preventDefault();
        const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
      }}
    >
      <span className="bulk-count">
        {count} selected
      </span>
      <button type="button" className="bulk-btn" disabled={busy || !settable.length} onClick={(e) => setStep({ kind: "pick", anchor: anchorOf(e.currentTarget) })}>
        <Icon name="edit" size={14} />
        Set property
      </button>
      <button type="button" className="bulk-btn" disabled={busy} onClick={() => void duplicate()}>
        <Icon name="duplicate" size={14} />
        Duplicate
      </button>
      <button type="button" className="bulk-btn danger" disabled={busy} onClick={() => void trash()}>
        <Icon name="trash" size={14} />
        Move to trash
      </button>
      <button type="button" className="icon-btn" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear}>
        <Icon name="close" size={14} />
      </button>

      {step?.kind === "pick" && (
        <Popover anchor={step.anchor} onClose={() => setStep(null)} label="Choose a property" className="picker bulk-pick">
          <p className="picker-muted">Set for {count} {noun(count)}</p>
          {settable.map((p) => (
            <button key={p.id} type="button" className="bulk-prop" onClick={() => setStep({ kind: "edit", prop: p, anchor: step.anchor })}>
              <Icon name={TYPE_META[p.type].icon} size={14} />
              {p.name}
            </button>
          ))}
        </Popover>
      )}

      {step?.kind === "edit" && (
        <ValueEditor
          prop={step.prop}
          anchor={step.anchor}
          db={db}
          count={count}
          onApply={(v) => void setProperty(step.prop, v)}
          onClose={() => setStep(null)}
        />
      )}
    </div>
  );
}

/** The right editor for one property type, starting empty and applying one value to everything. */
function ValueEditor({ prop, anchor, db, count, onApply, onClose }: { prop: Property; anchor: Anchor; db: Db; count: number; onApply: (value: unknown) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (isOptionType(prop.type)) {
    return (
      <OptionPicker
        prop={prop}
        current={prop.type === "multi_select" ? [] : null}
        multi={prop.type === "multi_select"}
        anchor={anchor}
        onChange={(v) => onApply(v)}
        onCreate={async (name) => {
          const opts = (prop.config.options ?? []).map((o) => ({ ...o }));
          const updated = await db.updateProperty(prop.id, { config: { options: [...opts, { name, color: "gray", group: "todo" }] } });
          return updated?.config.options?.find((o) => o.name === name) ?? null;
        }}
        onClose={onClose}
      />
    );
  }
  if (prop.type === "date") return <DateEditor current={null} anchor={anchor} onChange={onApply} onClose={onClose} />;
  if (prop.type === "checkbox") {
    return (
      <Popover anchor={anchor} onClose={onClose} label={`Set ${prop.name}`} className="picker">
        <p className="picker-muted">{prop.name} for {count} records</p>
        <div className="picker-actions">
          <button type="button" className="btn" onClick={() => onApply(false)}>
            Unchecked
          </button>
          <button type="button" className="btn primary" onClick={() => onApply(true)}>
            Checked
          </button>
        </div>
      </Popover>
    );
  }
  return (
    <Popover anchor={anchor} onClose={onClose} label={`Set ${prop.name}`} className="picker">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = parseEntry(prop.type, text);
          if ("error" in parsed) setError(parsed.error);
          else onApply(parsed.value);
        }}
      >
        <label className="field">
          <span>
            {prop.name} for {count} records
          </span>
          <input
            value={text}
            placeholder="Leave empty to clear"
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="picker-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Apply
          </button>
        </div>
      </form>
    </Popover>
  );
}

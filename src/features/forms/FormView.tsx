import { useId, useState } from "react";
import "./forms.css";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { DbView, FormField, FormSpec, Property, RecordRow } from "../../types";
import { optionsOf, TYPE_META } from "../database/model";
import { Tag } from "../database/cells";
import type { useDatabase } from "../database/useDatabase";
import { isFillable, labelOf, shownFields, toValues, validate, type Entry, type ShownField } from "./form";
import { SuccessCheck } from "../../components/Feedback";

type Db = ReturnType<typeof useDatabase>;

function Control({ item, entry, error, onChange, describedBy }: { item: ShownField; entry: Entry | undefined; error?: string; onChange: (e: Entry) => void; describedBy?: string }) {
  const { prop } = item;
  const common = { id: `f-${prop.id}`, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy, "aria-required": item.field.required || undefined };
  const text = typeof entry === "string" ? entry : "";
  switch (prop.type) {
    case "checkbox":
      return (
        <label className="form-check">
          <input type="checkbox" {...common} checked={entry === true} onChange={(e) => onChange(e.target.checked)} />
          <span>{labelOf(item)}</span>
        </label>
      );
    case "select":
    case "status":
      return (
        <select {...common} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {optionsOf(prop).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case "multi_select": {
      const chosen = Array.isArray(entry) ? entry : [];
      return (
        <div className="form-options" role="group" aria-labelledby={`l-${prop.id}`} aria-describedby={describedBy}>
          {optionsOf(prop).map((o) => (
            <label key={o.id} className={`form-opt${chosen.includes(o.id) ? " on" : ""}`}>
              <input type="checkbox" checked={chosen.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...chosen, o.id] : chosen.filter((x) => x !== o.id))} />
              <Tag option={o} />
            </label>
          ))}
          {optionsOf(prop).length === 0 && <span className="picker-muted">No options yet. Add some in the table.</span>}
        </div>
      );
    }
    case "number":
      return <input {...common} type="number" step="any" inputMode="decimal" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "date":
      return <input {...common} type="date" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "email":
      return <input {...common} type="email" autoComplete="email" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "url":
      return <input {...common} type="url" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "phone":
      return <input {...common} type="tel" autoComplete="tel" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "text":
      return <textarea {...common} rows={3} value={text} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input {...common} type="text" maxLength={500} value={text} onChange={(e) => onChange(e.target.value)} />;
  }
}

function Fill({ view, props, spec, onEdit }: { view: DbView; props: Property[]; spec: FormSpec | null | undefined; onEdit?: () => void }) {
  const fields = shownFields(spec, props);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<RecordRow | null>(null);
  const openPage = useWorkspace((s) => s.openPage);
  const uid = useId();
  const title = fields.find((f) => f.prop.type === "title");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const found = validate(fields, entries);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) {
      document.getElementById(`f-${Object.keys(found)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const t = title ? entries[title.prop.id] : "";
      setDone(await ipc.formSubmit(view.id, typeof t === "string" && t.trim() ? t.trim() : null, toValues(fields, entries)));
    } catch (err) {
      setFailure(toAppError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="form-done" role="status">
        <span className="form-done-mark" aria-hidden="true">
          <SuccessCheck size={22} />
        </span>
        <h2>{spec?.successMessage?.trim() || "Thanks, your answers were saved."}</h2>
        <p className="picker-muted">A new record was added to this database.</p>
        <div className="form-done-actions">
          <button
            type="button"
            className="btn primary"
            autoFocus
            onClick={() => {
              setEntries({});
              setErrors({});
              setDone(null);
            }}
          >
            Submit another
          </button>
          <button type="button" className="btn" onClick={() => void openPage(done.pageId)}>
            Open the record
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="form-fill" onSubmit={(e) => void submit(e)} noValidate>
      <div className="form-head">
        <h2>{view.name}</h2>
        {onEdit && (
          <button type="button" className="btn" onClick={onEdit}>
            <Icon name="columns" size={14} />
            Edit form
          </button>
        )}
      </div>
      {spec?.intro?.trim() && <p className="form-intro">{spec.intro}</p>}
      {failure && (
        <p className="field-error" role="alert">
          {failure}
        </p>
      )}
      {fields.map((item) => {
        const { prop, field } = item;
        const err = errors[prop.id];
        const hint = `${uid}-${prop.id}`;
        return (
          <div className={`form-field${err ? " bad" : ""}`} key={prop.id}>
            {prop.type !== "checkbox" && (
              <label id={`l-${prop.id}`} htmlFor={`f-${prop.id}`} className="form-label">
                {labelOf(item)}
                {field.required ? <span className="form-req" aria-hidden="true"> *</span> : <span className="form-opt-note"> (optional)</span>}
              </label>
            )}
            {field.help && (
              <p className="form-help" id={`${hint}-help`}>
                {field.help}
              </p>
            )}
            <Control item={item} entry={entries[prop.id]} error={err} onChange={(v) => setEntries((s) => ({ ...s, [prop.id]: v }))} describedBy={[field.help ? `${hint}-help` : "", err ? `${hint}-err` : ""].filter(Boolean).join(" ") || undefined} />
            {err && (
              <p className="field-error" id={`${hint}-err`}>
                {err}
              </p>
            )}
          </div>
        );
      })}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Sending…" : spec?.submitLabel?.trim() || "Submit"}
        </button>
        {fields.some((f) => f.field.required) && <span className="picker-muted">* required</span>}
      </div>
    </form>
  );
}

function Editor({ db, view, onDone }: { db: Db; view: DbView; onDone: () => void }) {
  const props = db.detail!.properties;
  const spec = view.config.form ?? { fields: shownFields(null, props).map((f) => f.field) };
  const fields = shownFields(spec, props);
  const unused = props.filter((p) => isFillable(p) && !fields.some((f) => f.prop.id === p.id));
  const save = (next: FormSpec, debounce = 0) => db.updateView({ form: next }, { debounce });
  const patchField = (id: string, patch: Partial<FormField>, debounce = 0) => save({ ...spec, fields: spec.fields.map((f) => (f.propertyId === id ? { ...f, ...patch } : f)) }, debounce);
  const move = (i: number, dir: -1 | 1) => {
    const list = [...spec.fields];
    const j = i + dir;
    // The title always stays first.
    if (j < 1 || j >= list.length || i < 1) return;
    [list[i], list[j]] = [list[j], list[i]];
    save({ ...spec, fields: list });
  };
  // Typing is held locally and saved shortly after, so a keystroke is not a round trip.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const text = (key: string, saved: string | null | undefined) => draft[key] ?? saved ?? "";
  const type = (key: string, value: string, apply: (v: string) => void) => {
    setDraft((d) => ({ ...d, [key]: value }));
    apply(value);
  };

  return (
    <div className="form-edit">
      <div className="form-head">
        <h2>Edit form</h2>
        <button type="button" className="btn primary" onClick={onDone}>
          Done
        </button>
      </div>
      <p className="picker-muted">Choose what the form asks for. Answers become a new record in this database.</p>
      <label className="field">
        <span>Introduction</span>
        <textarea rows={2} maxLength={2000} value={text("intro", spec.intro)} onChange={(e) => type("intro", e.target.value, (v) => save({ ...spec, intro: v }, 400))} />
      </label>
      <ol className="form-fields" aria-label="Form fields">
        {spec.fields.map((f, i) => {
          const prop = props.find((p) => p.id === f.propertyId);
          if (!prop) return null;
          const isTitle = prop.type === "title";
          return (
            <li key={f.propertyId} className="form-edit-row">
              <div className="form-edit-head">
                <Icon name={TYPE_META[prop.type].icon} size={14} />
                <b>{prop.name}</b>
                <span className="picker-muted">{TYPE_META[prop.type].label}</span>
                <span className="form-edit-actions">
                  <button type="button" className="icon-btn" aria-label={`Move ${prop.name} up`} disabled={isTitle || i <= 1} onClick={() => move(i, -1)}>
                    <Icon name="arrowUp" size={14} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Move ${prop.name} down`} disabled={isTitle || i >= spec.fields.length - 1} onClick={() => move(i, 1)}>
                    <Icon name="arrowDown" size={14} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Remove ${prop.name} from the form`} title={isTitle ? "The title is always asked for" : "Remove from the form"} disabled={isTitle} onClick={() => save({ ...spec, fields: spec.fields.filter((x) => x.propertyId !== f.propertyId) })}>
                    <Icon name="eyeOff" size={14} />
                  </button>
                </span>
              </div>
              <div className="form-edit-grid">
                <label className="field">
                  <span>Label</span>
                  <input value={text(`l:${f.propertyId}`, f.label)} maxLength={80} placeholder={prop.name} onChange={(e) => type(`l:${f.propertyId}`, e.target.value, (v) => patchField(f.propertyId, { label: v }, 400))} />
                </label>
                <label className="field">
                  <span>Help text</span>
                  <input value={text(`h:${f.propertyId}`, f.help)} maxLength={200} onChange={(e) => type(`h:${f.propertyId}`, e.target.value, (v) => patchField(f.propertyId, { help: v }, 400))} />
                </label>
                <label className="check-row">
                  <input type="checkbox" checked={f.required} disabled={isTitle} onChange={(e) => patchField(f.propertyId, { required: e.target.checked })} />
                  Required
                </label>
              </div>
            </li>
          );
        })}
      </ol>
      {unused.length > 0 && (
        <div className="form-add">
          <span className="picker-muted">Not in the form:</span>
          {unused.map((p) => (
            <button key={p.id} type="button" className="btn" onClick={() => save({ ...spec, fields: [...spec.fields, { propertyId: p.id, required: false }] })}>
              <Icon name="plus" size={14} />
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="form-edit-grid">
        <label className="field">
          <span>Button label</span>
          <input value={text("submit", spec.submitLabel)} maxLength={40} placeholder="Submit" onChange={(e) => type("submit", e.target.value, (v) => save({ ...spec, submitLabel: v }, 400))} />
        </label>
        <label className="field">
          <span>Confirmation message</span>
          <input value={text("success", spec.successMessage)} maxLength={200} placeholder="Thanks, your answers were saved." onChange={(e) => type("success", e.target.value, (v) => save({ ...spec, successMessage: v }, 400))} />
        </label>
      </div>
      {fields.length === 0 && <p className="error-text">A form needs at least a title.</p>}
    </div>
  );
}

/** A database view that is a form: fill it in to add a record, or edit which fields it asks for. */
export function FormView({ db, view, locked = false }: { db: Db; view: DbView; locked?: boolean }) {
  const [editing, setEditing] = useState(false);
  const props = db.detail!.properties;
  return (
    <div className="form-view">
      {editing ? <Editor db={db} view={view} onDone={() => setEditing(false)} /> : <Fill key={view.id} view={view} props={props} spec={view.config.form} onEdit={locked ? undefined : () => setEditing(true)} />}
    </div>
  );
}

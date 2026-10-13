import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { Popover, anchorOf, type Anchor } from "../../components/Popover";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { RecordTemplate } from "../../types";

export function useRecordTemplates(databaseId: string | undefined) {
  const [templates, setTemplates] = useState<RecordTemplate[]>([]);
  const setError = useWorkspace((s) => s.setError);
  const reload = useCallback(async () => {
    if (!databaseId) return;
    try {
      setTemplates(await ipc.recordTemplateList(databaseId));
    } catch (e) {
      setError(toAppError(e).message);
    }
  }, [databaseId, setError]);
  useEffect(() => void reload(), [reload]);
  return { templates, reload };
}

function Manager({ anchor, templates, onClose, onChanged }: { anchor: Anchor; templates: RecordTemplate[]; onClose: () => void; onChanged: () => void }) {
  const setError = useWorkspace((s) => s.setError);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(toAppError(e).message);
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} label="Record templates" className="picker rt-manager">
      <div className="picker-group">Templates</div>
      <ul className="rt-list">
        {templates.map((t) => (
          <li key={t.id} className="rt-row">
            <input
              aria-label={`Name of the ${t.name} template`}
              defaultValue={t.name}
              maxLength={60}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name && name !== t.name) void run(() => ipc.recordTemplateUpdate(t.id, { name }));
                else e.target.value = t.name;
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <button
              type="button"
              className={`icon-btn${t.isDefault ? " on" : ""}`}
              aria-pressed={t.isDefault}
              aria-label={t.isDefault ? `${t.name} is the default; click to stop` : `Make ${t.name} the default`}
              title={t.isDefault ? "The default for New record" : "Make this the default"}
              onClick={() => void run(() => ipc.recordTemplateUpdate(t.id, { isDefault: !t.isDefault }))}
            >
              <Icon name="star" filled={t.isDefault} size={14} />
            </button>
            <button type="button" className="icon-btn" aria-label={`Delete the ${t.name} template`} onClick={() => void run(() => ipc.recordTemplateDelete(t.id))}>
              <Icon name="trash" size={14} />
            </button>
          </li>
        ))}
      </ul>
      <p className="picker-muted">To make a template, open a record you have set up and choose “Save as template”.</p>
    </Popover>
  );
}

/** "New record", with a menu of this database's record templates when it has any. */
export function NewRecordButton({ databaseId, onCreate }: { databaseId: string; onCreate: (templateId: string | null) => void }) {
  const { templates, reload } = useRecordTemplates(databaseId);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [managing, setManaging] = useState<Anchor | null>(null);
  const fallback = templates.find((t) => t.isDefault);

  return (
    <span className="new-record">
      <button type="button" className={`btn primary db-new${templates.length ? " split" : ""}`} onClick={() => onCreate(fallback?.id ?? null)}>
        <Icon name="plus" size={14} />
        New record
      </button>
      {templates.length > 0 && (
        <button type="button" className="btn primary db-new-more" aria-label="Choose a template" aria-haspopup="menu" aria-expanded={!!menu} onClick={(e) => setMenu(anchorOf(e.currentTarget))}>
          <Icon name="chevron" size={12} />
        </button>
      )}
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} label="New record from" className="picker view-types">
          <div className="picker-group">New record from</div>
          <button type="button" className="view-type" onClick={() => (setMenu(null), onCreate(null))}>
            <Icon name="page" />
            <span>
              <b>Empty record</b>
              <small>Start with nothing filled in</small>
            </span>
          </button>
          {templates.map((t) => (
            <button key={t.id} type="button" className="view-type" onClick={() => (setMenu(null), onCreate(t.id))}>
              <Icon name="layers" />
              <span>
                <b>
                  {t.name}
                  {t.isDefault && <span className="rt-default"> · default</span>}
                </b>
                <small>
                  {Object.keys(t.values).length} {Object.keys(t.values).length === 1 ? "value" : "values"}, {t.blockCount} {t.blockCount === 1 ? "block" : "blocks"}
                </small>
              </span>
            </button>
          ))}
          <button
            type="button"
            className="view-type"
            onClick={(e) => {
              const a = anchorOf(e.currentTarget);
              setMenu(null);
              setManaging(a);
            }}
          >
            <Icon name="columns" />
            <span>
              <b>Manage templates…</b>
            </span>
          </button>
        </Popover>
      )}
      {managing && <Manager anchor={managing} templates={templates} onClose={() => setManaging(null)} onChanged={() => void reload()} />}
    </span>
  );
}

/** A small form that saves the open record as a template of its database. */
export function SaveAsTemplate({ databaseId, recordId, title, anchor, onClose }: { databaseId: string; recordId: string; title: string; anchor: Anchor; onClose: () => void }) {
  const [name, setName] = useState(title.trim() || "Template");
  const [busy, setBusy] = useState(false);
  const notify = useWorkspace((s) => s.notify);
  const setError = useWorkspace((s) => s.setError);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const t = await ipc.recordTemplateCreate(databaseId, name.trim(), recordId);
      onClose();
      notify(`Saved the “${t.name}” template`);
    } catch (err) {
      setError(toAppError(err).message);
      setBusy(false);
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} label="Save as template" className="picker">
      <form onSubmit={(e) => void save(e)}>
        <label className="field">
          <span>Template name</span>
          <input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="picker-muted">New records can start with this record’s title, values and content.</p>
        <div className="picker-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            Save template
          </button>
        </div>
      </form>
    </Popover>
  );
}

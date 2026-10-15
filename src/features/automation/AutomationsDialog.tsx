import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { anchorOf, type Anchor } from "../../components/Popover";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Action, Automation, AutomationRun, DatabaseDetail, FilterNode, Property, RecordRow, RecordTemplate, Trigger } from "../../types";
import { countConditions } from "../database/filter";
import { formatStamp, isFilterable, optionsOf } from "../database/model";
import { FilterPanel } from "../database/Panels";
import { syncDialog } from "../../lib/dialog";
import "./automation.css";
import {
  ACTION_TYPES,
  describeAction,
  describeTrigger,
  isSettable,
  isWatchable,
  newAction,
  newTrigger,
  problemWith,
  TRIGGER_TYPES,
  triggerHasRecord,
  WEEKDAYS,
  type ActionType,
  type TriggerType,
  defaultValue,
} from "./automation";

interface Draft {
  id?: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  conditions: FilterNode | null;
  actions: Action[];
}

const STATUS_LABEL = { ok: "Worked", failed: "Failed", skipped: "Skipped" } as const;

function StatusChip({ status }: { status: "ok" | "failed" | "skipped" | null }) {
  if (!status) return <span className="picker-muted">Never run</span>;
  return <span className={`run-chip ${status}`}>{STATUS_LABEL[status]}</span>;
}

/** One value for one property: the right control for its type. Text may use {{title}}, {{today}} and {{now}}. */
function ValueField({ prop, value, onChange }: { prop: Property; value: unknown; onChange: (v: unknown) => void }) {
  const label = `Value for ${prop.name}`;
  switch (prop.type) {
    case "checkbox":
      return (
        <select aria-label={label} value={value === false ? "no" : "yes"} onChange={(e) => onChange(e.target.value === "yes")}>
          <option value="yes">Checked</option>
          <option value="no">Unchecked</option>
        </select>
      );
    case "select":
    case "status":
      return (
        <select aria-label={label} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {optionsOf(prop).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case "number":
      return <input aria-label={label} type="number" step="any" value={typeof value === "number" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} />;
    case "date": {
      const start = value && typeof value === "object" ? String((value as { start?: string }).start ?? "") : "";
      const today = start === "{{today}}";
      return (
        <span className="value-pair">
          <select aria-label={`${label}: which date`} value={today ? "today" : "fixed"} onChange={(e) => onChange({ start: e.target.value === "today" ? "{{today}}" : new Date().toISOString().slice(0, 10) })}>
            <option value="today">The day it runs</option>
            <option value="fixed">A fixed date</option>
          </select>
          {!today && <input aria-label={`${label}: date`} type="date" value={start} onChange={(e) => onChange({ start: e.target.value })} />}
        </span>
      );
    }
    default:
      return <input aria-label={label} value={String(value ?? "")} maxLength={500} placeholder="Text, or {{title}}, {{today}}" onChange={(e) => onChange(e.target.value)} />;
  }
}

/** A list of property = value rows with add and remove. */
function ValueRows({ props, values, onChange }: { props: Property[]; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const settable = props.filter(isSettable);
  const unused = settable.filter((p) => !(p.id in values));
  return (
    <div className="value-rows">
      {Object.entries(values).map(([id, v]) => {
        const prop = props.find((p) => p.id === id);
        return (
          <div className="value-row" key={id}>
            <select
              aria-label="Property"
              value={id}
              onChange={(e) => {
                const next = props.find((p) => p.id === e.target.value);
                if (!next) return;
                const { [id]: _drop, ...rest } = values; // eslint-disable-line @typescript-eslint/no-unused-vars
                onChange({ ...rest, [next.id]: defaultValue(next) });
              }}
            >
              {[...(prop ? [prop] : []), ...unused].map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span aria-hidden="true">=</span>
            {prop ? <ValueField prop={prop} value={v} onChange={(nv) => onChange({ ...values, [id]: nv })} /> : <span className="picker-muted">Property removed</span>}
            <button type="button" className="icon-btn" aria-label="Remove this property" onClick={() => onChange(Object.fromEntries(Object.entries(values).filter(([k]) => k !== id)))}>
              <Icon name="close" size={14} />
            </button>
          </div>
        );
      })}
      {unused.length > 0 && (
        <button type="button" className="link" onClick={() => onChange({ ...values, [unused[0].id]: defaultValue(unused[0]) })}>
          + Add a property
        </button>
      )}
    </div>
  );
}

function TriggerFields({ trigger, props, onChange, onAddButton }: { trigger: Trigger; props: Property[]; onChange: (t: Trigger) => void; onAddButton: () => void }) {
  switch (trigger.type) {
    case "property_changed": {
      const prop = props.find((p) => p.id === trigger.propertyId);
      const optionLike = prop && (prop.type === "select" || prop.type === "status");
      return (
        <div className="auto-fields">
          <label className="field">
            <span>Property</span>
            <select value={trigger.propertyId} onChange={(e) => onChange({ type: "property_changed", propertyId: e.target.value })}>
              {props.filter(isWatchable).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {(optionLike || prop?.type === "checkbox") && (
            <label className="field">
              <span>Only when it becomes</span>
              <select
                value={trigger.to === undefined || trigger.to === null ? "" : String(trigger.to)}
                onChange={(e) => onChange({ ...trigger, to: e.target.value === "" ? undefined : prop?.type === "checkbox" ? e.target.value === "true" : e.target.value })}
              >
                <option value="">Anything (any change)</option>
                {prop?.type === "checkbox" ? (
                  <>
                    <option value="true">Checked</option>
                    <option value="false">Unchecked</option>
                  </>
                ) : (
                  optionsOf(prop!).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))
                )}
              </select>
            </label>
          )}
        </div>
      );
    }
    case "date_reached": {
      const dates = props.filter((p) => p.type === "date");
      if (dates.length === 0) return <p className="picker-muted">This database has no date property yet.</p>;
      const dir = trigger.offsetDays < 0 ? "before" : trigger.offsetDays > 0 ? "after" : "on";
      const days = Math.abs(trigger.offsetDays);
      const set = (d: number, which: string) => onChange({ ...trigger, offsetDays: which === "before" ? -d : which === "after" ? d : 0 });
      return (
        <div className="auto-fields">
          <label className="field">
            <span>Date property</span>
            <select value={trigger.propertyId} onChange={(e) => onChange({ ...trigger, propertyId: e.target.value })}>
              {dates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>When</span>
            <span className="value-pair">
              {dir !== "on" && <input aria-label="Days" type="number" min={1} max={365} value={days} onChange={(e) => set(Math.max(1, Number(e.target.value) || 1), dir)} />}
              <select aria-label="Before, on or after" value={dir} onChange={(e) => set(Math.max(1, days), e.target.value)}>
                <option value="on">On the date</option>
                <option value="before">Days before</option>
                <option value="after">Days after</option>
              </select>
            </span>
          </label>
          <label className="field">
            <span>At</span>
            <input type="time" value={trigger.time} onChange={(e) => onChange({ ...trigger, time: e.target.value || "09:00" })} />
          </label>
        </div>
      );
    }
    case "schedule":
      return (
        <div className="auto-fields">
          <label className="field">
            <span>Repeat</span>
            <select value={trigger.every} onChange={(e) => onChange({ ...trigger, every: e.target.value as typeof trigger.every, interval: 1 })}>
              <option value="minutes">Every few minutes</option>
              <option value="hours">Every few hours</option>
              <option value="daily">Every day</option>
              <option value="weekly">On chosen days</option>
            </select>
          </label>
          {(trigger.every === "minutes" || trigger.every === "hours") && (
            <label className="field">
              <span>Every</span>
              <span className="value-pair">
                <input type="number" min={1} max={trigger.every === "minutes" ? 1440 : 168} value={trigger.interval} onChange={(e) => onChange({ ...trigger, interval: Math.max(1, Number(e.target.value) || 1) })} />
                <span>{trigger.every}</span>
              </span>
            </label>
          )}
          {(trigger.every === "daily" || trigger.every === "weekly") && (
            <label className="field">
              <span>At</span>
              <input type="time" value={trigger.time} onChange={(e) => onChange({ ...trigger, time: e.target.value || "09:00" })} />
            </label>
          )}
          {trigger.every === "weekly" && (
            <div className="weekdays" role="group" aria-label="Days of the week">
              {WEEKDAYS.map((d, i) => (
                <button key={d} type="button" className={`chip${trigger.days.includes(i) ? " on" : ""}`} aria-pressed={trigger.days.includes(i)} onClick={() => onChange({ ...trigger, days: trigger.days.includes(i) ? trigger.days.filter((x) => x !== i) : [...trigger.days, i].sort() })}>
                  {d}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    case "button": {
      const buttons = props.filter((p) => p.type === "button");
      return buttons.length === 0 ? (
        <div className="auto-fields">
          <p className="picker-muted">This database has no button property yet.</p>
          <button type="button" className="btn" onClick={onAddButton}>
            <Icon name="plus" size={14} />
            Add a button property
          </button>
        </div>
      ) : (
        <div className="auto-fields">
          <label className="field">
            <span>Button</span>
            <select value={trigger.propertyId} onChange={(e) => onChange({ type: "button", propertyId: e.target.value })}>
              {buttons.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.config.label || "Run"})
                </option>
              ))}
            </select>
          </label>
        </div>
      );
    }
    default:
      return null;
  }
}

function ActionFields({ action, props, templates, onChange }: { action: Action; props: Property[]; templates: RecordTemplate[]; onChange: (a: Action) => void }) {
  switch (action.type) {
    case "update_properties":
      return <ValueRows props={props} values={action.values} onChange={(values) => onChange({ ...action, values })} />;
    case "set_status": {
      const choices = props.filter((p) => p.type === "status" || p.type === "select");
      const prop = props.find((p) => p.id === action.propertyId);
      return choices.length === 0 ? (
        <p className="picker-muted">This database has no status or select property.</p>
      ) : (
        <div className="value-row">
          <select aria-label="Property" value={action.propertyId} onChange={(e) => onChange({ ...action, propertyId: e.target.value, optionId: optionsOf(props.find((p) => p.id === e.target.value)!)[0]?.id ?? "" })}>
            {choices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Icon name="arrowRight" />
          <select aria-label="Option" value={action.optionId} onChange={(e) => onChange({ ...action, optionId: e.target.value })}>
            {prop && optionsOf(prop).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case "create_record":
      return (
        <div className="auto-fields">
          <label className="field">
            <span>Title</span>
            <input value={action.title ?? ""} maxLength={500} placeholder="For example Follow up on {{title}}" onChange={(e) => onChange({ ...action, title: e.target.value })} />
          </label>
          {templates.length > 0 && (
            <label className="field">
              <span>Start from template</span>
              <select value={action.templateId ?? ""} onChange={(e) => onChange({ ...action, templateId: e.target.value || null })}>
                <option value="">None</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ValueRows props={props} values={action.values} onChange={(values) => onChange({ ...action, values })} />
        </div>
      );
    case "notify":
      return (
        <div className="auto-fields">
          <label className="field">
            <span>Title</span>
            <input value={action.title} maxLength={100} placeholder="For example Done: {{title}}" onChange={(e) => onChange({ ...action, title: e.target.value })} />
          </label>
          <label className="field">
            <span>Message</span>
            <input value={action.body ?? ""} maxLength={300} onChange={(e) => onChange({ ...action, body: e.target.value })} />
          </label>
        </div>
      );
    default:
      return null;
  }
}

function Editor({ draft, setDraft, detail, templates, onSave, onCancel, onAddButton, onTest, saved }: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  detail: DatabaseDetail;
  templates: RecordTemplate[];
  onSave: () => void;
  onCancel: () => void;
  onAddButton: () => void;
  onTest: () => void;
  saved: boolean;
}) {
  const props = detail.properties;
  const [filterAt, setFilterAt] = useState<Anchor | null>(null);
  const problem = problemWith(draft.name, draft.trigger, draft.actions, props);
  const hasRecord = triggerHasRecord(draft.trigger);
  const move = (i: number, dir: -1 | 1) => {
    const list = [...draft.actions];
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setDraft({ ...draft, actions: list });
  };
  const conditions = countConditions(draft.conditions);

  return (
    <form
      className="auto-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) onSave();
      }}
    >
      <label className="field">
        <span>Name</span>
        <input value={draft.name} maxLength={80} autoFocus placeholder="For example Mark finished tasks" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>

      <section className="auto-step" aria-label="When">
        <h3>When</h3>
        <label className="field">
          <span>Trigger</span>
          <select value={draft.trigger.type} onChange={(e) => setDraft({ ...draft, trigger: newTrigger(e.target.value as TriggerType, props), conditions: triggerHasRecord(newTrigger(e.target.value as TriggerType, props)) ? draft.conditions : null })}>
            {TRIGGER_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <p className="picker-muted">{TRIGGER_TYPES.find((t) => t.type === draft.trigger.type)?.hint}</p>
        <TriggerFields trigger={draft.trigger} props={props} onChange={(trigger) => setDraft({ ...draft, trigger })} onAddButton={onAddButton} />
        {(draft.trigger.type === "schedule" || draft.trigger.type === "date_reached") && <p className="picker-muted">Runs while Suivelle is open. If it was closed at the time, it runs once when you next open it.</p>}
      </section>

      {hasRecord && (
        <section className="auto-step" aria-label="Only if">
          <h3>Only if</h3>
          <button type="button" className={`tbtn${conditions ? " on" : ""}`} onClick={(e) => setFilterAt(anchorOf(e.currentTarget))}>
            <Icon name="filter" size={14} />
            {conditions ? `${conditions} condition${conditions === 1 ? "" : "s"}` : "Add conditions"}
          </button>
          <span className="picker-muted"> The record must match; with none, it always runs.</span>
          {filterAt && <FilterPanel anchor={filterAt} onClose={() => setFilterAt(null)} props={props.filter(isFilterable)} filter={draft.conditions} onChange={(conditions) => setDraft({ ...draft, conditions })} />}
        </section>
      )}

      <section className="auto-step" aria-label="Then">
        <h3>Then</h3>
        <ol className="auto-actions">
          {draft.actions.map((a, i) => (
            <li key={i} className="auto-action">
              <div className="auto-action-head">
                <span className="auto-num" aria-hidden="true">{i + 1}</span>
                <select
                  aria-label={`Action ${i + 1}`}
                  value={a.type}
                  onChange={(e) => setDraft({ ...draft, actions: draft.actions.map((x, j) => (j === i ? newAction(e.target.value as ActionType, props) : x)) })}
                >
                  {ACTION_TYPES.filter((t) => hasRecord || !t.needsRecord).map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <span className="form-edit-actions">
                  <button type="button" className="icon-btn" aria-label={`Move action ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <Icon name="arrowUp" size={14} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Move action ${i + 1} down`} disabled={i === draft.actions.length - 1} onClick={() => move(i, 1)}>
                    <Icon name="arrowDown" size={14} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Remove action ${i + 1}`} onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== i) })}>
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              </div>
              <ActionFields action={a} props={props} templates={templates} onChange={(next) => setDraft({ ...draft, actions: draft.actions.map((x, j) => (j === i ? next : x)) })} />
            </li>
          ))}
        </ol>
        <button type="button" className="btn" onClick={() => setDraft({ ...draft, actions: [...draft.actions, newAction(hasRecord ? "update_properties" : "notify", props)] })} disabled={draft.actions.length >= 10}>
          <Icon name="plus" size={14} />
          Add an action
        </button>
        <p className="picker-muted">If any action fails, none of this run’s changes are kept. Changes can trigger other automations, up to three in a row, and an automation never runs twice in one chain.</p>
      </section>

      {problem && <p className="field-error" role="status">{problem}</p>}
      <div className="picker-actions auto-foot">
        {saved && (
          <button type="button" className="btn" onClick={onTest} title="Runs the actions for real">
            <Icon name="play" size={14} />
            Test run…
          </button>
        )}
        <span className="auto-spacer" />
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!!problem}>
          Save
        </button>
      </div>
    </form>
  );
}

function TestRun({ automation, detail, onClose, onResult }: { automation: Automation; detail: DatabaseDetail; onClose: () => void; onResult: (message: string) => void }) {
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [record, setRecord] = useState("");
  const [busy, setBusy] = useState(false);
  const hasRecord = triggerHasRecord(automation.trigger);
  useEffect(() => {
    if (!hasRecord) return;
    ipc
      .queryRecords({ databaseId: detail.database.id, limit: 50, skipTotal: true })
      .then((p) => {
        setRows(p.rows);
        setRecord(p.rows[0]?.id ?? "");
      })
      .catch(() => setRows([]));
  }, [detail.database.id, hasRecord]);
  const run = async () => {
    setBusy(true);
    try {
      const r = await ipc.automationRunNow(automation.id, hasRecord ? record : null);
      onResult(`${r.status === "ok" ? "Worked" : r.status === "failed" ? "Failed" : "Skipped"}: ${r.message}`);
      useWorkspace.getState().bumpData();
    } catch (e) {
      onResult(`Failed: ${toAppError(e).message}`);
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return (
    <div className="auto-test" role="group" aria-label="Test run">
      <p>
        <b>This really runs “{automation.name}”</b>, changing records and showing notifications. Its trigger is ignored, but its conditions still apply.
      </p>
      {hasRecord && (
        <label className="field">
          <span>Run it on</span>
          <select value={record} onChange={(e) => setRecord(e.target.value)}>
            {rows?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title || "Untitled"}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="picker-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy || (hasRecord && !record)} onClick={() => void run()}>
          {busy ? "Running…" : "Run now"}
        </button>
      </div>
    </div>
  );
}

function Log({ databaseId }: { databaseId: string }) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const load = useCallback(() => void ipc.automationRuns(databaseId).then(setRuns).catch(() => setRuns([])), [databaseId]);
  useEffect(load, [load]);
  return (
    <div className="auto-log">
      <div className="auto-log-head">
        <p className="picker-muted">The last 100 runs, newest first.</p>
        <button type="button" className="btn" onClick={load}>
          Refresh
        </button>
      </div>
      {runs?.length === 0 && <p className="picker-muted">Nothing has run yet.</p>}
      <ul aria-busy={!runs}>
        {runs?.map((r) => (
          <li key={r.id} className="run-row">
            <StatusChip status={r.status} />
            <span className="run-text">
              <b>{r.automationName}</b>
              {r.recordTitle ? <> on “{r.recordTitle}”</> : null}
              <span className="picker-muted"> {r.message}</span>
            </span>
            <time className="picker-muted" dateTime={r.startedAt}>
              {formatStamp(r.startedAt)}
              {r.depth > 0 ? ` · step ${r.depth + 1}` : ""}
            </time>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Body({ detail, onClose, onAddButton }: { detail: DatabaseDetail; onClose: () => void; onAddButton: () => Promise<void> }) {
  const databaseId = detail.database.id;
  const props = detail.properties;
  const [list, setList] = useState<Automation[] | null>(null);
  const [tab, setTab] = useState<"list" | "log">("list");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [templates, setTemplates] = useState<RecordTemplate[]>([]);
  const [testing, setTesting] = useState<Automation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setGlobalError = useWorkspace((s) => s.setError);
  const confirmRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setList(await ipc.automationList(databaseId));
    } catch (e) {
      setError(toAppError(e).message);
    }
  }, [databaseId]);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => void ipc.recordTemplateList(databaseId).then(setTemplates).catch(() => setTemplates([])), [databaseId]);

  const edit = (a: Automation | null) => {
    setError(null);
    setMessage(null);
    setTesting(null);
    setDraft(a ? { id: a.id, name: a.name, enabled: a.enabled, trigger: a.trigger, conditions: a.conditions, actions: a.actions } : { name: "", enabled: true, trigger: newTrigger("record_created", props), conditions: null, actions: [newAction("update_properties", props)] });
  };

  const save = async () => {
    if (!draft) return;
    try {
      const saved = await ipc.automationSave({ ...draft, databaseId });
      await refresh();
      setDraft({ id: saved.id, name: saved.name, enabled: saved.enabled, trigger: saved.trigger, conditions: saved.conditions, actions: saved.actions });
      setDraft(null);
      setMessage(`Saved “${saved.name}”.`);
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  const toggle = async (a: Automation) => {
    try {
      await ipc.automationSetEnabled(a.id, !a.enabled);
      await refresh();
    } catch (e) {
      setGlobalError(toAppError(e).message);
    }
  };

  const remove = async (a: Automation) => {
    try {
      await ipc.automationDelete(a.id);
      await refresh();
      setMessage(`Deleted “${a.name}”.`);
    } catch (e) {
      setGlobalError(toAppError(e).message);
    }
  };

  if (draft) {
    const current = draft.id ? list?.find((a) => a.id === draft.id) : undefined;
    return (
      <div className="auto" ref={confirmRef}>
        <header className="tpl-head">
          <h2>{draft.id ? "Edit automation" : "New automation"}</h2>
        </header>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {testing && current ? (
          <TestRun automation={current} detail={detail} onClose={() => setTesting(null)} onResult={(m) => (setMessage(m), setDraft(null))} />
        ) : (
          <Editor
            draft={draft}
            setDraft={setDraft}
            detail={detail}
            templates={templates}
            saved={!!current}
            onSave={() => void save()}
            onCancel={() => setDraft(null)}
            onAddButton={() => void onAddButton()}
            onTest={() => current && setTesting(current)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="auto">
      <header className="tpl-head">
        <h2>Automations</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="seg" role="tablist" aria-label="Automations">
        <button type="button" role="tab" aria-selected={tab === "list"} className={`seg-btn${tab === "list" ? " on" : ""}`} onClick={() => setTab("list")}>
          Automations
        </button>
        <button type="button" role="tab" aria-selected={tab === "log"} className={`seg-btn${tab === "log" ? " on" : ""}`} onClick={() => setTab("log")}>
          Run log
        </button>
      </div>
      {message && (
        <p className="picker-muted" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {tab === "log" ? (
        <Log databaseId={databaseId} />
      ) : (
        <>
          <p className="picker-muted">Rules that run on this computer when records change, on a schedule, or when a button is pressed. Schedules and dates run only while Suivelle is open.</p>
          <ul className="auto-list" aria-busy={!list}>
            {list?.length === 0 && <li className="picker-muted">No automations yet.</li>}
            {list?.map((a) => (
              <li key={a.id} className="auto-row">
                <label className="auto-switch">
                  <input type="checkbox" checked={a.enabled} onChange={() => void toggle(a)} aria-label={`${a.name} is ${a.enabled ? "on" : "off"}`} />
                </label>
                <span className="auto-text">
                  <b>{a.name}</b>
                  <span className="picker-muted">
                    {describeTrigger(a.trigger, props)} · {a.actions.length === 1 ? describeAction(a.actions[0], props) : `${a.actions.length} actions`}
                  </span>
                </span>
                <StatusChip status={a.lastStatus} />
                <button type="button" className="btn" onClick={() => edit(a)}>
                  Edit
                </button>
                <button type="button" className="icon-btn" aria-label={`Delete ${a.name}`} onClick={() => void remove(a)}>
                  <Icon name="trash" size={14} />
                </button>
              </li>
            ))}
          </ul>
          <div className="picker-actions">
            <button type="button" className="btn primary" onClick={() => edit(null)}>
              <Icon name="plus" size={14} />
              New automation
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The automations of one database: a list, a builder (when, only if, then) and a run log. */
export function AutomationsDialog({ open, detail, onClose, onAddButton }: { open: boolean; detail: DatabaseDetail; onClose: () => void; onAddButton: () => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    syncDialog(d, open);
  }, [open]);
  return (
    <dialog ref={ref} className="palette tpl-dialog auto-dialog" aria-label="Automations" onClose={onClose} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {open && <Body detail={detail} onClose={onClose} onAddButton={onAddButton} />}
    </dialog>
  );
}

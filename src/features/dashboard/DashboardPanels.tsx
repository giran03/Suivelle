import { useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { Popover, anchorOf, type Anchor } from "../../components/Popover";
import { toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { DatabaseDetail, DatabaseRef, SharedFilter, Widget, WidgetType } from "../../types";
import { ChartSettings } from "../charts/ChartView";
import { defaultChartSpec } from "../charts/chartModel";
import { isFilterable } from "../database/model";
import { FilterPanel } from "../database/Panels";
import { VIEW_META } from "../database/ViewTabs";
import { slotFor } from "./layout";
import { choicesFrom, DAY_PRESETS, defaultValue, describe, type FilterChoice } from "./sharedFilters";
import { Loading } from "../../components/Loading";

type Kind = "text" | "chart" | "kpi" | "linked_view";

const KINDS: { kind: Kind; icon: IconName; label: string; blurb: string }[] = [
  { kind: "chart", icon: "chart", label: "Chart", blurb: "Bars, lines, pies from a database" },
  { kind: "kpi", icon: "dashboard", label: "Number", blurb: "One figure: a count, sum or average" },
  { kind: "linked_view", icon: "table", label: "Linked view", blurb: "A saved view of a database, live" },
  { kind: "text", icon: "text", label: "Text", blurb: "A note or a heading" },
];

const newId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Chooses what to add, then the database (and view) it shows. */
export function AddWidget({
  anchor,
  widgets,
  refs,
  fetchDetail,
  onAdd,
  onClose,
}: {
  anchor: Anchor;
  widgets: Widget[];
  refs: DatabaseRef[] | null;
  fetchDetail: (ref: DatabaseRef) => Promise<DatabaseDetail>;
  onAdd: (w: Widget) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [ref, setRef] = useState<{ ref: DatabaseRef; detail: DatabaseDetail } | null>(null);
  const [busy, setBusy] = useState(false);
  const setError = useWorkspace((s) => s.setError);

  const add = (type: WidgetType, size: [number, number], extra: Partial<Widget>) => {
    onAdd({ id: newId(), type, ...slotFor(widgets, size[0], size[1]), ...extra });
    onClose();
  };

  const choose = async (r: DatabaseRef) => {
    setBusy(true);
    try {
      const detail = await fetchDetail(r);
      if (kind === "linked_view") return void setRef({ ref: r, detail });
      add("chart", kind === "kpi" ? [3, 2] : [6, 5], { databaseId: r.id, chart: { ...defaultChartSpec(detail.properties), chartType: kind === "kpi" ? "kpi" : "bar" } });
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover anchor={anchor} onClose={onClose} label="Add a widget" className="picker view-types">
      {!kind && (
        <>
          <div className="picker-group">Add a widget</div>
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              className="view-type"
              onClick={() => (k.kind === "text" ? add("text", [4, 2], { text: "" }) : setKind(k.kind))}
            >
              <Icon name={k.icon} />
              <span>
                <b>{k.label}</b>
                <small>{k.blurb}</small>
              </span>
            </button>
          ))}
        </>
      )}
      {kind && !ref && (
        <>
          <div className="picker-group">
            <button type="button" className="link" onClick={() => setKind(null)}>
              Back
            </button>{" "}
            · Which database?
          </div>
          {refs === null && <p className="picker-muted"><Loading /></p>}
          {refs?.length === 0 && <p className="picker-muted">There are no databases yet. Make one first.</p>}
          {refs?.map((r) => (
            <button key={r.id} type="button" className="view-type" disabled={busy} onClick={() => void choose(r)}>
              <Icon name="table" />
              <span>
                <b>{r.title || "Untitled"}</b>
              </span>
            </button>
          ))}
        </>
      )}
      {ref && (
        <>
          <div className="picker-group">
            <button type="button" className="link" onClick={() => setRef(null)}>
              Back
            </button>{" "}
            · Which view of {ref.ref.title || "Untitled"}?
          </div>
          {ref.detail.views.map((v) => (
            <button key={v.id} type="button" className="view-type" onClick={() => add("linked_view", [v.type === "table" || v.type === "board" ? 12 : 6, 7], { databaseId: ref.ref.id, viewId: v.id })}>
              <Icon name={VIEW_META[v.type].icon} />
              <span>
                <b>{v.name}</b>
                <small>{VIEW_META[v.type].label}</small>
              </span>
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}

/** Edits one widget: its title, its text, what its chart draws, or which view it shows. */
export function WidgetSettings({
  anchor,
  widget,
  detail,
  onChange,
  onRemove,
  onClose,
}: {
  anchor: Anchor;
  widget: Widget;
  detail: DatabaseDetail | undefined;
  onChange: (patch: Partial<Widget>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [filterAt, setFilterAt] = useState<Anchor | null>(null);
  return (
    <Popover anchor={anchor} onClose={onClose} label="Widget settings" className="picker dw-settings">
      <label className="field">
        <span>Title</span>
        <input value={widget.title ?? ""} maxLength={80} placeholder={widget.type === "text" ? "None" : "Automatic"} onChange={(e) => onChange({ title: e.target.value })} />
      </label>
      {widget.type === "text" && (
        <label className="field">
          <span>Text</span>
          <textarea rows={5} maxLength={5000} value={widget.text ?? ""} onChange={(e) => onChange({ text: e.target.value })} />
        </label>
      )}
      {widget.type === "chart" && detail && (
        <>
          <ChartSettings spec={widget.chart ?? defaultChartSpec(detail.properties)} props={detail.properties} onChange={(chart) => onChange({ chart })} />
          <button type="button" className={`tbtn${widget.filter ? " on" : ""}`} onClick={(e) => setFilterAt(anchorOf(e.currentTarget))}>
            <Icon name="filter" size={14} />
            Filter this chart
          </button>
          {filterAt && <FilterPanel anchor={filterAt} onClose={() => setFilterAt(null)} props={detail.properties.filter(isFilterable)} filter={widget.filter ?? null} onChange={(filter) => onChange({ filter })} />}
        </>
      )}
      {widget.type === "linked_view" && detail && (
        <label className="field">
          <span>View</span>
          <select value={widget.viewId ?? ""} onChange={(e) => onChange({ viewId: e.target.value })}>
            {detail.views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({VIEW_META[v.type].label})
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="picker-actions">
        <button type="button" className="btn danger" onClick={onRemove}>
          Remove widget
        </button>
        <button type="button" className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Popover>
  );
}

function FilterEditor({ choice, filter, anchor, onSave, onRemove, onClose }: { choice: FilterChoice; filter: SharedFilter | null; anchor: Anchor; onSave: (f: SharedFilter) => void; onRemove?: () => void; onClose: () => void }) {
  const [value, setValue] = useState<unknown>(filter?.value ?? defaultValue(choice));
  const save = () => onSave({ id: filter?.id ?? `f${Date.now().toString(36)}`, propertyName: choice.name, type: choice.type, value });
  return (
    <Popover anchor={anchor} onClose={onClose} label={`Filter by ${choice.name}`} className="picker">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field">
          <span>{choice.name}</span>
          {choice.type === "option" && (
            <select value={String(value ?? "")} onChange={(e) => setValue(e.target.value)}>
              {choice.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          )}
          {choice.type === "checkbox" && (
            <select aria-label="Checkbox value" value={value === true ? "yes" : "no"} onChange={(e) => setValue(e.target.value === "yes")}>
              <option value="yes">Checked</option>
              <option value="no">Unchecked</option>
            </select>
          )}
          {choice.type === "text" && <input aria-label="Text to match" value={String(value ?? "")} maxLength={200} placeholder="Contains…" onChange={(e) => setValue(e.target.value)} />}
          {choice.type === "date_days" && (
            <select aria-label="Time range" value={String(value)} onChange={(e) => setValue(Number(e.target.value))}>
              {DAY_PRESETS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
        </label>
        <p className="picker-muted">Applies to every widget whose database has a property with this name.</p>
        <div className="picker-actions">
          {onRemove && (
            <button type="button" className="btn danger" onClick={onRemove}>
              Remove
            </button>
          )}
          <button type="submit" className="btn primary" disabled={choice.type === "text" && !String(value ?? "").trim()}>
            {filter ? "Update" : "Add filter"}
          </button>
        </div>
      </form>
    </Popover>
  );
}

/** The dashboard's shared filters: chips that narrow every widget at once. */
export function FiltersBar({ filters, databases, onChange }: { filters: SharedFilter[]; databases: DatabaseDetail[]; onChange: (next: SharedFilter[]) => void }) {
  const choices = choicesFrom(databases.map((d) => d.properties));
  const [adding, setAdding] = useState<Anchor | null>(null);
  const [picked, setPicked] = useState<{ choice: FilterChoice; anchor: Anchor } | null>(null);
  const [editing, setEditing] = useState<{ filter: SharedFilter; anchor: Anchor } | null>(null);
  const choiceOf = (f: SharedFilter) => choices.find((c) => c.name.toLowerCase() === f.propertyName.toLowerCase()) ?? { name: f.propertyName, type: f.type, options: typeof f.value === "string" ? [f.value] : [] };

  return (
    <div className="dash-filters" role="group" aria-label="Dashboard filters">
      {filters.map((f) => (
        <button key={f.id} type="button" className="chip on" onClick={(e) => setEditing({ filter: f, anchor: anchorOf(e.currentTarget) })} aria-label={`Filter: ${describe(f)}. Click to change.`}>
          <Icon name="filter" size={12} />
          {describe(f)}
        </button>
      ))}
      {choices.length > 0 && filters.length < 8 && (
        <button type="button" className="tbtn" aria-haspopup="menu" onClick={(e) => setAdding(anchorOf(e.currentTarget))}>
          <Icon name="plus" size={14} />
          Filter
        </button>
      )}
      {filters.length > 0 && (
        <button type="button" className="link" onClick={() => onChange([])}>
          Clear all
        </button>
      )}
      {adding && (
        <Popover anchor={adding} onClose={() => setAdding(null)} label="Filter by" className="picker view-types">
          <div className="picker-group">Filter every widget by</div>
          {choices.map((c) => (
            <button
              key={c.name}
              type="button"
              className="view-type"
              onClick={(e) => {
                const anchor = anchorOf(e.currentTarget);
                setAdding(null);
                setPicked({ choice: c, anchor });
              }}
            >
              <Icon name={c.type === "option" ? "tag" : c.type === "checkbox" ? "todo" : c.type === "text" ? "text" : "calendar"} />
              <span>
                <b>{c.name}</b>
              </span>
            </button>
          ))}
        </Popover>
      )}
      {picked && (
        <FilterEditor
          choice={picked.choice}
          filter={null}
          anchor={picked.anchor}
          onClose={() => setPicked(null)}
          onSave={(f) => {
            setPicked(null);
            onChange([...filters, f]);
          }}
        />
      )}
      {editing && (
        <FilterEditor
          choice={choiceOf(editing.filter)}
          filter={editing.filter}
          anchor={editing.anchor}
          onClose={() => setEditing(null)}
          onSave={(f) => {
            setEditing(null);
            onChange(filters.map((x) => (x.id === f.id ? f : x)));
          }}
          onRemove={() => {
            const id = editing.filter.id;
            setEditing(null);
            onChange(filters.filter((x) => x.id !== id));
          }}
        />
      )}
    </div>
  );
}

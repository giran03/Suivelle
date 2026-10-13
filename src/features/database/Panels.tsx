import { useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { Popover, type Anchor } from "../../components/Popover";
import type { FilterGroup, FilterLeaf, FilterNode, Property, PropertyType, ViewColumn, ViewSort } from "../../types";
import { addTo, compact, isGroup, newCondition, removeAt, rootOf, updateAt } from "./filter";
import { NewProperty } from "./NewProperty";
import { defaultFilterValue, isSortable, operatorNeedsValue, operatorsFor, optionsOf, TYPE_META, valueType } from "./model";
import { IconSwap } from "../../components/Swap";

// ---------------------------------------------------------------------------------------------
// filter
// ---------------------------------------------------------------------------------------------

const dayKind = (v: unknown): "today" | "yesterday" | "tomorrow" | "exact" =>
  v && typeof v === "object" ? ((v as { relativeDays: number }).relativeDays === 0 ? "today" : (v as { relativeDays: number }).relativeDays === -1 ? "yesterday" : "tomorrow") : "exact";

function DayEditor({ value, onChange, label }: { value: unknown; onChange: (v: unknown) => void; label: string }) {
  const kind = dayKind(value);
  return (
    <span className="day-editor">
      <select
        aria-label={label}
        value={kind}
        onChange={(e) => {
          const k = e.target.value;
          onChange(k === "today" ? { relativeDays: 0 } : k === "yesterday" ? { relativeDays: -1 } : k === "tomorrow" ? { relativeDays: 1 } : new Date().toISOString().slice(0, 10));
        }}
      >
        <option value="today">Today</option>
        <option value="yesterday">Yesterday</option>
        <option value="tomorrow">Tomorrow</option>
        <option value="exact">Exact date</option>
      </select>
      {kind === "exact" && <input type="date" aria-label={`${label} date`} value={typeof value === "string" ? value.slice(0, 10) : ""} onChange={(e) => onChange(e.target.value || null)} />}
    </span>
  );
}

function ValueEditor({ prop, leaf, onChange }: { prop: Property; leaf: FilterLeaf; onChange: (v: unknown) => void }) {
  const vt = valueType(prop);
  if (!operatorNeedsValue(vt, leaf.operator)) return <span className="cond-none" />;
  const v = leaf.value;
  switch (vt) {
    case "number":
    case "unique_id":
      return <input type="number" aria-label="Value" value={typeof v === "number" ? v : ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
    case "select":
    case "status":
    case "multi_select":
      return (
        <select aria-label="Value" value={typeof v === "string" ? v : ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Choose…</option>
          {optionsOf(prop).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case "checkbox":
      return (
        <select aria-label="Value" value={String(v)} onChange={(e) => onChange(e.target.value === "true")}>
          <option value="true">Checked</option>
          <option value="false">Unchecked</option>
        </select>
      );
    case "date":
    case "created_time":
    case "updated_time":
      return leaf.operator === "between" && Array.isArray(v) ? (
        <span className="between">
          <DayEditor label="From" value={v[0]} onChange={(a) => onChange([a, v[1]])} />
          <DayEditor label="To" value={v[1]} onChange={(b) => onChange([v[0], b])} />
        </span>
      ) : (
        <DayEditor label="Date" value={v} onChange={onChange} />
      );
    default:
      return <input type="text" aria-label="Value" value={typeof v === "string" ? v : ""} placeholder="Value" onChange={(e) => onChange(e.target.value)} />;
  }
}

function Condition({ leaf, props, onChange, onRemove }: { leaf: FilterLeaf; props: Property[]; onChange: (l: FilterLeaf) => void; onRemove: () => void }) {
  const prop = props.find((p) => p.id === leaf.propertyId);
  return (
    <div className="cond">
      <select
        aria-label="Property"
        value={leaf.propertyId}
        onChange={(e) => {
          const next = props.find((p) => p.id === e.target.value);
          if (next) onChange(newCondition(next));
        }}
      >
        {!prop && <option value={leaf.propertyId}>Deleted property</option>}
        {props.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {prop && (
        <>
          <select
            aria-label="Operator"
            value={leaf.operator}
            onChange={(e) => {
              const operator = e.target.value;
              const sameShape = (leaf.operator === "between") === (operator === "between") && operatorNeedsValue(valueType(prop), operator) === operatorNeedsValue(valueType(prop), leaf.operator);
              onChange({ propertyId: leaf.propertyId, operator, value: sameShape ? leaf.value : defaultFilterValue(prop, operator) });
            }}
          >
            {operatorsFor(valueType(prop)).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <ValueEditor prop={prop} leaf={leaf} onChange={(value) => onChange({ ...leaf, value })} />
        </>
      )}
      <button type="button" className="icon-btn" aria-label="Remove condition" onClick={onRemove}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export function FilterPanel({ anchor, onClose, props, filter, onChange }: { anchor: Anchor; onClose: () => void; props: Property[]; filter: FilterNode | null; onChange: (f: FilterNode | null) => void }) {
  const [draft, setDraft] = useState<FilterGroup>(() => rootOf(filter));
  const byId = useMemo(() => new Map(props.map((p) => [p.id, p])), [props]);
  const set = (next: FilterGroup) => {
    setDraft(next);
    onChange(compact(next, byId)); // only complete conditions are saved; the rest stay in the editor
  };
  const first = props[0];

  const renderGroup = (g: FilterGroup, path: number[]) => (
    <div className={path.length ? "group-box" : undefined}>
      {g.children.length > 0 && (
        <label className="match">
          Match
          <select aria-label={path.length ? "Group match" : "Match"} value={g.op} onChange={(e) => set(updateAt(draft, path, (n) => ({ ...(n as FilterGroup), op: e.target.value as "and" | "or" })))}>
            <option value="and">all</option>
            <option value="or">any</option>
          </select>
          of these
        </label>
      )}
      {g.children.map((c, i) =>
        isGroup(c) ? (
          <div key={i}>{renderGroup(c, [...path, i])}</div>
        ) : (
          <Condition key={i} leaf={c} props={props} onChange={(l) => set(updateAt(draft, [...path, i], () => l))} onRemove={() => set(removeAt(draft, [...path, i]))} />
        ),
      )}
      <div className="filter-actions">
        {first && (
          <button type="button" className="btn" onClick={() => set(addTo(draft, path, newCondition(first)))}>
            <Icon name="plus" size={14} />
            Add condition
          </button>
        )}
        {path.length === 0 && first && (
          <button type="button" className="btn" onClick={() => set(addTo(draft, [], { op: "or", children: [newCondition(first)] }))}>
            <Icon name="plus" size={14} />
            Add group
          </button>
        )}
        {path.length > 0 && (
          <button type="button" className="btn" onClick={() => set(removeAt(draft, path))}>
            Remove group
          </button>
        )}
      </div>
    </div>
  );

  return (
    <Popover anchor={anchor} onClose={onClose} label="Filter" className="picker filter-panel">
      {draft.children.length === 0 && <p className="picker-muted">No filters. Add a condition to narrow the records shown.</p>}
      {renderGroup(draft, [])}
    </Popover>
  );
}

// ---------------------------------------------------------------------------------------------
// sort
// ---------------------------------------------------------------------------------------------

export function SortPanel({ anchor, onClose, props, sorts, onChange }: { anchor: Anchor; onClose: () => void; props: Property[]; sorts: ViewSort[]; onChange: (s: ViewSort[]) => void }) {
  const sortable = props.filter(isSortable);
  const unused = sortable.find((p) => !sorts.some((s) => s.propertyId === p.id));
  return (
    <Popover anchor={anchor} onClose={onClose} label="Sort" className="picker">
      {sorts.length === 0 && <p className="picker-muted">No sorting. Records appear in the order they were created.</p>}
      {sorts.map((s, i) => (
        <div className="cond" key={s.propertyId}>
          <select
            aria-label="Sort property"
            value={s.propertyId}
            onChange={(e) => onChange(sorts.map((x, j) => (j === i ? { ...x, propertyId: e.target.value } : x)).filter((x, j, a) => a.findIndex((y) => y.propertyId === x.propertyId) === j))}
          >
            {sortable
              .filter((p) => p.id === s.propertyId || !sorts.some((x) => x.propertyId === p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <select aria-label="Direction" value={s.direction} onChange={(e) => onChange(sorts.map((x, j) => (j === i ? { ...x, direction: e.target.value as "asc" | "desc" } : x)))}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button type="button" className="icon-btn" aria-label="Remove sort" onClick={() => onChange(sorts.filter((_, j) => j !== i))}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
      {unused && sorts.length < 5 && (
        <button type="button" className="btn" onClick={() => onChange([...sorts, { propertyId: unused.id, direction: "asc" }])}>
          <Icon name="plus" size={14} />
          Add sort
        </button>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------------------------------------
// properties (show / hide / add)
// ---------------------------------------------------------------------------------------------

export function PropertiesPanel({
  anchor,
  onClose,
  columns,
  databaseId,
  properties,
  onToggle,
  onAdd,
}: {
  anchor: Anchor;
  onClose: () => void;
  columns: { property: Property; column: ViewColumn }[];
  databaseId: string;
  properties: Property[];
  onToggle: (id: string, hidden: boolean) => void;
  onAdd: (name: string, type: PropertyType, config?: unknown) => Promise<unknown>;
}) {
  return (
    <Popover anchor={anchor} onClose={onClose} label="Properties" className="picker">
      <div className="picker-group">Shown in the table</div>
      <ul className="prop-list">
        {columns.map(({ property, column }) => (
          <li key={property.id}>
            <Icon name={TYPE_META[property.type].icon} size={14} />
            <span className="prop-name">{property.name}</span>
            {property.type === "title" ? (
              <span className="picker-muted">Always shown</span>
            ) : (
              <button type="button" className="icon-btn" aria-pressed={!column.hidden} aria-label={column.hidden ? `Show ${property.name}` : `Hide ${property.name}`} onClick={() => onToggle(property.id, !column.hidden)}>
                <IconSwap name={column.hidden ? "eyeOff" : "eye"} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <NewProperty databaseId={databaseId} properties={properties} onAdd={onAdd} />
    </Popover>
  );
}

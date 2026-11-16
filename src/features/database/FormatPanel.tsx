import { useState } from "react";
import { Icon } from "../../components/Icon";
import { Popover, type Anchor } from "../../components/Popover";
import type { FilterNode, FormatRule, Property, Tone } from "../../types";
import { ruleColumn } from "./conditional";
import { FilterEditor } from "./Panels";

const TONES: Tone[] = ["red", "orange", "green", "blue", "violet", "gray"];
const MAX_RULES = 20;

interface Draft {
  id: string;
  filter: FilterNode | null;
  target: FormatRule["target"];
  propertyId: string | null;
  color: Tone;
}

const toDraft = (r: FormatRule): Draft => ({ id: r.id, filter: r.filter, target: r.target, propertyId: r.propertyId ?? null, color: r.color });

/**
 * Conditional formatting for the table: each rule colours a row or one column's cell when its
 * condition holds. The first matching rule wins. Display only; records are never changed.
 */
export function FormatPanel({
  anchor,
  onClose,
  props,
  columns,
  rules,
  onChange,
}: {
  anchor: Anchor;
  onClose: () => void;
  /** Properties a condition can test. */
  props: Property[];
  /** Properties a cell rule can colour. */
  columns: Property[];
  rules: FormatRule[];
  onChange: (rules: FormatRule[]) => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => rules.map(toDraft));
  const set = (next: Draft[]) => {
    setDrafts(next);
    // A rule without a complete condition stays in the editor until it has one.
    onChange(
      next.flatMap((d) =>
        d.filter ? [{ id: d.id, filter: d.filter, target: d.target, propertyId: d.target === "cell" ? d.propertyId : null, color: d.color }] : [],
      ),
    );
  };
  const patch = (id: string, change: Partial<Draft>) => set(drafts.map((d) => (d.id === id ? { ...d, ...change } : d)));
  const first = props[0];

  return (
    <Popover anchor={anchor} onClose={onClose} label="Conditional formatting" className="picker filter-panel format-panel">
      {drafts.length === 0 && <p className="picker-muted">No rules. A rule colours a row or a cell when its condition holds, for example overdue dates in red.</p>}
      {drafts.map((d, i) => {
        const testedColumn = d.filter ? ruleColumn({ id: d.id, filter: d.filter, target: "cell", color: d.color }) : null;
        return (
          <section key={d.id} className="format-rule" aria-label={`Rule ${i + 1}`}>
            <div className="format-rule-head">
              <div className="swatches" role="radiogroup" aria-label="Colour">
                {TONES.map((t) => (
                  <button key={t} type="button" role="radio" aria-checked={d.color === t} aria-label={t} className="swatch-btn" data-tone={t} onClick={() => patch(d.id, { color: t })} />
                ))}
              </div>
              <select aria-label="Colour" value={d.target} onChange={(e) => patch(d.id, { target: e.target.value as Draft["target"] })}>
                <option value="row">the whole row</option>
                <option value="cell">a cell</option>
              </select>
              {d.target === "cell" && (
                <select aria-label="Which cell" value={d.propertyId ?? ""} onChange={(e) => patch(d.id, { propertyId: e.target.value || null })}>
                  <option value="">{testedColumn ? `The tested one (${columns.find((p) => p.id === testedColumn)?.name ?? "column"})` : "The tested column"}</option>
                  {columns.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              <button type="button" className="icon-btn" aria-label={`Remove rule ${i + 1}`} onClick={() => set(drafts.filter((x) => x.id !== d.id))}>
                <Icon name="close" size={14} />
              </button>
            </div>
            <FilterEditor props={props} filter={d.filter} onChange={(filter) => patch(d.id, { filter })} emptyText="Add a condition to start this rule." />
          </section>
        );
      })}
      <div className="filter-actions">
        {first && drafts.length < MAX_RULES && (
          <button
            type="button"
            className="btn"
            onClick={() => set([...drafts, { id: crypto.randomUUID(), filter: null, target: "row", propertyId: null, color: TONES[drafts.length % TONES.length] }])}
          >
            <Icon name="plus" size={14} />
            Add rule
          </button>
        )}
      </div>
    </Popover>
  );
}

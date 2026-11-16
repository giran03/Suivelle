import { useState } from "react";
import { Icon } from "../../components/Icon";
import { Popover, anchorOf, type Anchor } from "../../components/Popover";
import type { AggregateKind, Aggregates, Property } from "../../types";
import type { Column } from "./useDatabase";
import { valueType } from "./model";
import { AGGREGATE_LABELS, aggregatesFor, formatAggregate } from "./totals";

/**
 * The table's totals row: one summary per column, computed by the backend over the whole filtered
 * set. Clicking a cell picks the summary; the choice is saved with the view.
 */
export function TotalsFooter({
  columns,
  template,
  height,
  totals,
  locked,
  onPick,
}: {
  columns: Column[];
  template: string;
  height: number;
  totals: Aggregates | null;
  /** The summary can be read but not changed. */
  locked: boolean;
  onPick: (propertyId: string, kind: AggregateKind | null) => void;
}) {
  const [picking, setPicking] = useState<{ prop: Property; current: AggregateKind | null; anchor: Anchor } | null>(null);
  const values = new Map(totals?.values.map((v) => [v.propertyId, v]));

  return (
    <>
      <div className="grid-footer" role="row" aria-label="Totals" style={{ gridTemplateColumns: template, height }}>
        {columns.map((c, i) => {
          const kind = c.column.aggregate ?? null;
          const value = kind ? values.get(c.property.id) : undefined;
          const text = kind && value ? formatAggregate(kind, value.value, c.property) : "";
          const numeric = ["number", "unique_id"].includes(valueType(c.property));
          const choices = aggregatesFor(c.property);
          const name = `${c.property.name} summary`;
          return (
            <div key={c.property.id} role="gridcell" className={`fcell${i === 0 ? " sticky" : ""}${numeric ? " num" : ""}`}>
              {choices.length > 0 && (
                <button
                  type="button"
                  className={`fbtn${kind ? " set" : ""}`}
                  disabled={locked}
                  aria-haspopup="menu"
                  aria-label={kind ? `${name}: ${AGGREGATE_LABELS[kind]} ${text || "no value"}` : `${name}: choose a calculation`}
                  title={kind ? `${AGGREGATE_LABELS[kind]} of ${c.property.name}. Click to change.` : `Calculate for ${c.property.name}`}
                  onClick={(e) => setPicking({ prop: c.property, current: kind, anchor: anchorOf(e.currentTarget) })}
                >
                  {kind ? (
                    <>
                      <span className="flabel">{AGGREGATE_LABELS[kind]}</span>
                      <span className="fval">{text || "–"}</span>
                    </>
                  ) : (
                    <span className="fhint">Calculate</span>
                  )}
                </button>
              )}
            </div>
          );
        })}
        <div className="fcell filler" role="presentation" />
      </div>
      {picking && (
        <Popover anchor={picking.anchor} onClose={() => setPicking(null)} label={`Calculate ${picking.prop.name}`} className="picker totals-picker">
          <div role="menu" aria-label={`Calculate ${picking.prop.name}`}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={picking.current === null}
              className="picker-item"
              onClick={() => {
                onPick(picking.prop.id, null);
                setPicking(null);
              }}
            >
              <span>None</span>
              {picking.current === null && <Icon name="check" size={14} />}
            </button>
            {aggregatesFor(picking.prop).map((k) => (
              <button
                key={k}
                type="button"
                role="menuitemradio"
                aria-checked={picking.current === k}
                className="picker-item"
                onClick={() => {
                  onPick(picking.prop.id, k);
                  setPicking(null);
                }}
              >
                <span>{AGGREGATE_LABELS[k]}</span>
                {picking.current === k && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

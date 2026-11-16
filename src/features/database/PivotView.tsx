import { useEffect, useMemo, useRef, useState } from "react";
import { Loading } from "../../components/Loading";
import { ipc, toAppError } from "../../lib/ipc";
import { useLiveData } from "../../lib/liveData";
import type { DateBucket, DbView, FilterNode, PivotData, PivotSpec, Property } from "../../types";
import { AGGREGATIONS } from "../charts/chartModel";
import "../charts/charts.css";
import { andFilters, useExtraFilter, useStable } from "./extraFilter";
import { buildPivotModel, canPivotAxis, canPivotMeasure, defaultPivotSpec, formatPivotValue, updatePivotSpec, valueLabel } from "./pivot";
import type { useDatabase } from "./useDatabase";
import "./pivot.css";

type Db = ReturnType<typeof useDatabase>;

/** Fetches the pivot and refetches when anything it depends on changes, shared filters included. */
function usePivotData(input: { databaseId: string; viewId: string; pivot: PivotSpec; version: number; enabled: boolean }) {
  const extra = useExtraFilter();
  const filter = useStable<FilterNode | null>(andFilters(null, extra));
  const pivot = useStable(input.pivot);
  const [state, setState] = useState<{ data: PivotData | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const gen = useRef(0);
  const { databaseId, viewId, enabled } = input;
  const version = input.version + useLiveData();

  useEffect(() => {
    if (!enabled) return;
    const mine = ++gen.current;
    setState((s) => ({ ...s, loading: true }));
    ipc
      .pivotData({ databaseId, viewId, pivot, filter })
      .then((data) => mine === gen.current && setState({ data, error: null, loading: false }))
      .catch((e) => mine === gen.current && setState({ data: null, error: toAppError(e).message, loading: false }));
  }, [databaseId, viewId, pivot, filter, version, enabled]);

  return state;
}

const BUCKETS: { value: DateBucket; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

const isDated = (p: Property | undefined) => p?.type === "date" || p?.type === "created_time" || p?.type === "updated_time";

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className="csel">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

function PivotSettings({ spec, props, onChange }: { spec: PivotSpec; props: Property[]; onChange: (patch: Partial<PivotSpec>) => void }) {
  const axes = props.filter(canPivotAxis);
  const measures = props.filter(canPivotMeasure);
  const row = props.find((p) => p.id === spec.rowPropertyId);
  const col = props.find((p) => p.id === spec.columnPropertyId);
  const buckets = (
    <>
      {BUCKETS.map((b) => (
        <option key={b.value} value={b.value}>
          {b.label}
        </option>
      ))}
    </>
  );
  return (
    <div className="chart-settings pivot-settings">
      <Select label="Rows" value={spec.rowPropertyId ?? ""} onChange={(v) => onChange({ rowPropertyId: v || null })}>
        <option value="">Choose a property…</option>
        {axes.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      {isDated(row) && (
        <Select label="Rows by" value={spec.rowBucket ?? "month"} onChange={(v) => onChange({ rowBucket: v as DateBucket })}>
          {buckets}
        </Select>
      )}
      <Select label="Columns" value={spec.columnPropertyId ?? ""} onChange={(v) => onChange({ columnPropertyId: v || null })}>
        <option value="">None</option>
        {axes
          .filter((p) => p.id !== spec.rowPropertyId)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </Select>
      {isDated(col) && (
        <Select label="Columns by" value={spec.columnBucket ?? "month"} onChange={(v) => onChange({ columnBucket: v as DateBucket })}>
          {buckets}
        </Select>
      )}
      <Select label="Show" value={spec.aggregation} onChange={(v) => onChange({ aggregation: v as PivotSpec["aggregation"] })}>
        {AGGREGATIONS.filter((a) => a.value === "count" || measures.length > 0).map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </Select>
      {spec.aggregation !== "count" && (
        <Select label="Of" value={spec.valuePropertyId ?? ""} onChange={(v) => onChange({ valuePropertyId: v || null })}>
          {measures.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      )}
      <label className="pivot-check">
        <input type="checkbox" checked={spec.showTotals} onChange={(e) => onChange({ showTotals: e.target.checked })} />
        Totals
      </label>
    </div>
  );
}

function AxisLabel({ item }: { item: { label: string; tone?: string } }) {
  return item.tone ? (
    <span className="tag" data-tone={item.tone}>
      <span className="tag-dot" />
      {item.label}
    </span>
  ) : (
    <>{item.label}</>
  );
}

/** A database view that cross-tabulates its records: one row and one column per value, a calculation in each cell. */
export function PivotView({ db, view, queryVersion, bare = false }: { db: Db; view: DbView; queryVersion: number; bare?: boolean }) {
  const props = db.detail!.properties;
  const spec = view.config.pivot ?? defaultPivotSpec(props);
  const needsRows = !spec.rowPropertyId;
  const pivot = usePivotData({ databaseId: db.detail!.database.id, viewId: view.id, pivot: spec, version: queryVersion, enabled: !needsRows });
  const model = useMemo(() => (pivot.data ? buildPivotModel(spec, props, pivot.data) : null), [spec, props, pivot.data]);
  const fmt = (v: number | null) => formatPivotValue(spec, props, v);
  const rowName = props.find((p) => p.id === spec.rowPropertyId)?.name ?? "";
  const colName = props.find((p) => p.id === spec.columnPropertyId)?.name;
  const totals = spec.showTotals && !!model;

  return (
    <div className={`chart-view pivot-view${bare ? " bare" : ""}`}>
      {!bare && <PivotSettings spec={spec} props={props} onChange={(patch) => db.updateView({ pivot: updatePivotSpec(spec, props, patch) }, { rows: true })} />}
      {pivot.error && !needsRows && (
        <p className="error-text" role="alert">
          {pivot.error}
        </p>
      )}
      {needsRows ? (
        <p className="chart-empty">Choose a property for the rows{props.some(canPivotAxis) ? "." : ". Add a select, status, checkbox or date property first."}</p>
      ) : !model ? (
        !pivot.error && (
          <p className="chart-empty" aria-busy="true">
            <Loading />
          </p>
        )
      ) : model.empty ? (
        <p className="chart-empty">No records to show. Add records, or loosen this view&rsquo;s filter.</p>
      ) : (
        <>
          <div className="pivot-scroll" aria-busy={pivot.loading}>
            <table className="pivot">
              <caption className="sr-only">
                {valueLabel(spec, props)} by {rowName}
                {colName ? ` and ${colName}` : ""}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="pivot-corner">
                    {colName ? `${rowName} / ${colName}` : rowName}
                  </th>
                  {model.columns.map((c) => (
                    <th key={c.key} scope="col" className="pivot-col">
                      <AxisLabel item={c} />
                    </th>
                  ))}
                  {totals && model.columns.length > 1 && (
                    <th scope="col" className="pivot-col pivot-total">
                      Total
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {model.rows.map((r, ri) => (
                  <tr key={r.key}>
                    <th scope="row" className="pivot-row">
                      <AxisLabel item={r} />
                    </th>
                    {model.columns.map((c, ci) => (
                      <td key={c.key} className="pivot-cell">
                        {fmt(model.values[ri][ci])}
                      </td>
                    ))}
                    {totals && model.columns.length > 1 && <td className="pivot-cell pivot-total">{fmt(model.rowTotals[ri])}</td>}
                  </tr>
                ))}
              </tbody>
              {totals && (
                <tfoot>
                  <tr>
                    <th scope="row" className="pivot-row pivot-total">
                      Total
                    </th>
                    {model.columns.map((c, ci) => (
                      <td key={c.key} className="pivot-cell pivot-total">
                        {fmt(model.columnTotals[ci])}
                      </td>
                    ))}
                    {model.columns.length > 1 && <td className="pivot-cell pivot-total">{fmt(model.grand)}</td>}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {pivot.data?.truncated && <p className="chart-note">Only the first rows and columns are shown. Narrow the view&rsquo;s filter to see the rest.</p>}
        </>
      )}
    </div>
  );
}

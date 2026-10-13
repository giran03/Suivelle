import { useEffect, useRef, useState } from "react";
import { ipc, toAppError } from "../../lib/ipc";
import type { ChartData, ChartSpec, DateBucket, DbView, FilterNode, Property } from "../../types";
import { andFilters, useExtraFilter, useStable } from "../database/extraFilter";
import type { useDatabase } from "../database/useDatabase";
import { Chart } from "./Chart";
import { AGGREGATIONS, CHART_TYPES, canAxis, canMeasure, canSeries, defaultChartSpec } from "./chartModel";
import { Loading } from "../../components/Loading";

type Db = ReturnType<typeof useDatabase>;

/** Fetches a chart and refetches when anything it depends on changes (including the shared filters). */
export function useChartData(input: { databaseId: string; viewId?: string | null; chart?: ChartSpec | null; filter?: FilterNode | null; version?: number; enabled?: boolean }) {
  const extra = useExtraFilter();
  const filter = useStable(andFilters(input.filter, extra));
  const chart = useStable(input.chart ?? null);
  const [state, setState] = useState<{ data: ChartData | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const gen = useRef(0);
  const { databaseId, viewId, version = 0, enabled = true } = input;

  useEffect(() => {
    if (!enabled) return;
    const mine = ++gen.current;
    setState((s) => ({ ...s, loading: true }));
    ipc
      .chartData({ databaseId, viewId, chart, filter })
      .then((data) => mine === gen.current && setState({ data, error: null, loading: false }))
      .catch((e) => mine === gen.current && setState({ data: null, error: toAppError(e).message, loading: false }));
  }, [databaseId, viewId, chart, filter, version, enabled]);

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

/** What a chart draws: type, axis, calculation, series and order. Used by chart views and dashboard widgets. */
export function ChartSettings({ spec, props, onChange }: { spec: ChartSpec; props: Property[]; onChange: (next: ChartSpec) => void }) {
  const set = (patch: Partial<ChartSpec>) => onChange({ ...spec, ...patch });
  const kpi = spec.chartType === "kpi";
  const axes = props.filter(canAxis);
  const x = props.find((p) => p.id === spec.xPropertyId);
  const measures = props.filter(canMeasure);
  const splittable = !kpi && spec.chartType !== "pie" && spec.chartType !== "donut";

  return (
    <div className="chart-settings">
      <div className="seg" role="group" aria-label="Chart type">
        {CHART_TYPES.map((t) => (
          <button key={t.value} type="button" className={`seg-btn${spec.chartType === t.value ? " on" : ""}`} aria-pressed={spec.chartType === t.value} onClick={() => set({ chartType: t.value })}>
            {t.label}
          </button>
        ))}
      </div>
      {!kpi && (
        <Select label="Across" value={spec.xPropertyId ?? ""} onChange={(v) => set({ xPropertyId: v || null, bucket: isDated(props.find((p) => p.id === v)) ? (spec.bucket ?? "month") : null })}>
          <option value="">Choose a property…</option>
          {axes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      )}
      {!kpi && isDated(x) && (
        <Select label="By" value={spec.bucket ?? "month"} onChange={(v) => set({ bucket: v as DateBucket })}>
          {BUCKETS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </Select>
      )}
      <Select label="Show" value={spec.aggregation} onChange={(v) => set({ aggregation: v as ChartSpec["aggregation"], yPropertyId: v === "count" ? null : (spec.yPropertyId ?? measures[0]?.id ?? null) })}>
        {AGGREGATIONS.filter((a) => a.value === "count" || measures.length > 0).map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </Select>
      {spec.aggregation !== "count" && (
        <Select label="Of" value={spec.yPropertyId ?? ""} onChange={(v) => set({ yPropertyId: v || null })}>
          <option value="">Choose a number…</option>
          {measures.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      )}
      {splittable && (
        <Select label="Split by" value={spec.groupPropertyId ?? ""} onChange={(v) => set({ groupPropertyId: v || null })}>
          <option value="">Nothing</option>
          {props
            .filter((p) => canSeries(p) && p.id !== spec.xPropertyId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </Select>
      )}
      {!kpi && (
        <Select label="Order" value={spec.sort} onChange={(v) => set({ sort: v as ChartSpec["sort"] })}>
          <option value="x">Natural order</option>
          <option value="value_desc">Largest first</option>
          <option value="value_asc">Smallest first</option>
        </Select>
      )}
    </div>
  );
}

/** A database view that draws its records as a chart. */
export function ChartView({ db, view, queryVersion, bare = false }: { db: Db; view: DbView; queryVersion: number; bare?: boolean }) {
  const props = db.detail!.properties;
  const spec = view.config.chart ?? defaultChartSpec(props);
  const needsAxis = spec.chartType !== "kpi" && !spec.xPropertyId;
  const chart = useChartData({ databaseId: db.detail!.database.id, viewId: view.id, version: queryVersion, enabled: !needsAxis });

  return (
    <div className={`chart-view${bare ? " bare" : ""}`}>
      {!bare && <ChartSettings spec={spec} props={props} onChange={(next) => db.updateView({ chart: next }, { rows: true })} />}
      {chart.error && !needsAxis && (
        <p className="error-text" role="alert">
          {chart.error}
        </p>
      )}
      <div className="chart-stage">
        {needsAxis ? (
          <p className="chart-empty">Choose a property to chart across{props.some(canAxis) ? "." : ". Add a select, status, checkbox or date property first."}</p>
        ) : chart.data ? (
          <Chart spec={spec} props={props} data={chart.data} />
        ) : (
          !chart.error && <p className="chart-empty" aria-busy="true"><Loading /></p>
        )}
      </div>
    </div>
  );
}

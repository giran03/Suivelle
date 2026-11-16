import type { DateBucket, PivotData, PivotSpec, Property, Tone } from "../../types";
import { AGGREGATIONS, EMPTY_KEY, canAxis, canMeasure, categoryLabel } from "../charts/chartModel";
import { formatNumber, numberFormatOf, optionsOf } from "./model";

export { canAxis as canPivotAxis, canMeasure as canPivotMeasure };

/** The key of the single column a pivot without a column property shows. */
export const ALL_KEY = "__all";

export interface PivotAxisItem {
  key: string;
  label: string;
  /** The option's own colour, for a select or status axis. */
  tone?: Tone;
}

export interface PivotModel {
  rows: PivotAxisItem[];
  columns: PivotAxisItem[];
  /** values[row][column]; null where no record falls in the cell. */
  values: (number | null)[][];
  rowTotals: (number | null)[];
  columnTotals: (number | null)[];
  grand: number | null;
  /** Records behind the whole table. */
  records: number;
  empty: boolean;
}

const isDated = (p: Property | undefined) => p?.type === "date" || p?.type === "created_time" || p?.type === "updated_time";

/** The pivot a new view starts with: records per status or select, split by the next one. */
export function defaultPivotSpec(props: Property[]): PivotSpec {
  const pick = (skip?: string) => ["status", "select", "checkbox", "date"].map((t) => props.find((p) => p.type === t && p.id !== skip)).find(Boolean);
  const row = pick();
  const col = pick(row?.id);
  return {
    rowPropertyId: row?.id ?? null,
    columnPropertyId: col?.id ?? null,
    aggregation: "count",
    rowBucket: row && isDated(row) ? "month" : null,
    columnBucket: col && isDated(col) ? "month" : null,
    showTotals: true,
  };
}

/** Option order for selects and statuses, false before true, time order for dates; "no value" always last. */
export function orderAxisKeys(prop: Property | undefined, keys: Iterable<string>): string[] {
  const present = new Set(keys);
  const rest = [...present].filter((k) => k !== EMPTY_KEY);
  let ordered: string[];
  if (!prop || isDated(prop)) ordered = rest.sort();
  else if (prop.type === "checkbox") ordered = ["false", "true"].filter((k) => present.has(k));
  else {
    const known = optionsOf(prop).map((o) => o.id);
    ordered = [...known.filter((k) => present.has(k)), ...rest.filter((k) => !known.includes(k)).sort()];
  }
  return present.has(EMPTY_KEY) ? [...ordered, EMPTY_KEY] : ordered;
}

function axisItem(prop: Property | undefined, key: string, bucket: DateBucket | null | undefined): PivotAxisItem {
  return {
    key,
    label: categoryLabel(prop, key, bucket),
    tone: prop && (prop.type === "select" || prop.type === "status") ? optionsOf(prop).find((o) => o.id === key)?.color : undefined,
  };
}

/** What a cell shows: the record count, or the calculation (null when it has no number). */
const measure = (spec: PivotSpec, p: { value: number | null; count: number }) => (spec.aggregation === "count" ? p.count : p.value);

/** "Records", "Sum of Amount". */
export function valueLabel(spec: PivotSpec, props: Property[]): string {
  if (spec.aggregation === "count") return "Records";
  const y = props.find((p) => p.id === spec.valuePropertyId);
  const agg = AGGREGATIONS.find((a) => a.value === spec.aggregation)?.short ?? "";
  return y ? `${agg} of ${y.name}` : agg;
}

/** Turns the pivot query into an ordered matrix with totals. Without a column property there is one column holding each row's total. */
export function buildPivotModel(spec: PivotSpec, props: Property[], data: PivotData): PivotModel {
  const rowProp = props.find((p) => p.id === spec.rowPropertyId);
  const colProp = props.find((p) => p.id === spec.columnPropertyId);
  const hasColumns = !!colProp;
  const key = (k: string | null) => k ?? EMPTY_KEY;

  const rowKeys = orderAxisKeys(rowProp, [...data.rowTotals.map((p) => key(p.x)), ...data.cells.map((p) => key(p.x))]);
  const colKeys = hasColumns ? orderAxisKeys(colProp, [...data.columnTotals.map((p) => key(p.x)), ...data.cells.map((p) => key(p.group))]) : [ALL_KEY];
  const rowIndex = new Map(rowKeys.map((k, i) => [k, i]));
  const colIndex = new Map(colKeys.map((k, i) => [k, i]));

  const values: (number | null)[][] = rowKeys.map(() => colKeys.map(() => null));
  if (hasColumns) {
    for (const p of data.cells) {
      const r = rowIndex.get(key(p.x));
      const c = colIndex.get(key(p.group));
      if (r !== undefined && c !== undefined) values[r][c] = measure(spec, p);
    }
  } else {
    for (const p of data.rowTotals) {
      const r = rowIndex.get(key(p.x));
      if (r !== undefined) values[r][0] = measure(spec, p);
    }
  }
  const rowTotals: (number | null)[] = rowKeys.map(() => null);
  for (const p of data.rowTotals) {
    const r = rowIndex.get(key(p.x));
    if (r !== undefined) rowTotals[r] = measure(spec, p);
  }
  const columnTotals: (number | null)[] = colKeys.map(() => null);
  if (hasColumns) {
    for (const p of data.columnTotals) {
      const c = colIndex.get(key(p.x));
      if (c !== undefined) columnTotals[c] = measure(spec, p);
    }
  } else columnTotals[0] = measure(spec, data.grand);

  return {
    rows: rowKeys.map((k) => axisItem(rowProp, k, spec.rowBucket)),
    columns: hasColumns ? colKeys.map((k) => axisItem(colProp, k, spec.columnBucket)) : [{ key: ALL_KEY, label: valueLabel(spec, props) }],
    values,
    rowTotals,
    columnTotals,
    grand: measure(spec, data.grand),
    records: data.records,
    empty: rowKeys.length === 0,
  };
}

/** A number as the pivot shows it: counts plain, calculations in the number property's own format. */
export function formatPivotValue(spec: PivotSpec, props: Property[], v: number | null): string {
  if (v === null) return "";
  if (spec.aggregation === "count") return formatNumber(v);
  const prop = props.find((p) => p.id === spec.valuePropertyId);
  return formatNumber(v, prop ? numberFormatOf(prop) : undefined);
}

/** The spec after the user changes one thing, keeping it valid: the value property follows the aggregation and buckets follow date axes. */
export function updatePivotSpec(spec: PivotSpec, props: Property[], patch: Partial<PivotSpec>): PivotSpec {
  const next: PivotSpec = { ...spec, ...patch };
  const measures = props.filter(canMeasure);
  if (next.aggregation === "count") next.valuePropertyId = null;
  else if (!measures.some((p) => p.id === next.valuePropertyId)) next.valuePropertyId = measures[0]?.id ?? null;
  if (next.aggregation !== "count" && !next.valuePropertyId) next.aggregation = "count";
  if (next.columnPropertyId && next.columnPropertyId === next.rowPropertyId) next.columnPropertyId = null;
  const bucket = (id: string | null | undefined, cur: DateBucket | null | undefined) => (isDated(props.find((p) => p.id === id)) ? (cur ?? "month") : null);
  next.rowBucket = bucket(next.rowPropertyId, next.rowBucket);
  next.columnBucket = bucket(next.columnPropertyId, next.columnBucket);
  return next;
}

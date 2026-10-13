import type { Aggregation, ChartData, ChartSpec, ChartType, DateBucket, Property, Tone } from "../../types";
import { formatNumber, formatWhen, optionsOf } from "../database/model";

export const EMPTY_KEY = "__empty";
export const MAX_SLICES = 12;
const GAP_FILL_LIMIT = 400;

export const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: "bar", label: "Bar" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "pie", label: "Pie" },
  { value: "donut", label: "Donut" },
  { value: "kpi", label: "Number" },
];

export const AGGREGATIONS: { value: Aggregation; label: string; short: string }[] = [
  { value: "count", label: "Count of records", short: "Records" },
  { value: "sum", label: "Sum", short: "Sum" },
  { value: "average", label: "Average", short: "Average" },
  { value: "min", label: "Minimum", short: "Minimum" },
  { value: "max", label: "Maximum", short: "Maximum" },
];

/** The order series and slices take their colours from when an option does not choose one. */
export const TONES: Tone[] = ["violet", "blue", "green", "orange", "red", "gray"];

export interface Category {
  key: string;
  label: string;
  /** The option's own colour, when the axis is a select or status. */
  tone?: Tone;
}

export interface Series {
  key: string;
  label: string;
  tone: Tone;
}

export interface ChartModel {
  categories: Category[];
  series: Series[];
  /** values[series][category] */
  values: number[][];
  /** Sum over series, per category (what a pie slice or a stacked bar totals). */
  totals: number[];
  /** Records behind each category. */
  records: number[];
  /** Whether series can be stacked: sums and counts add up, averages and extremes do not. */
  stackable: boolean;
  /** What the numbers are called ("Records", "Sum of Amount"). */
  valueLabel: string;
  empty: boolean;
}

export const isAdditive = (a: Aggregation) => a === "count" || a === "sum";

const isDateType = (p: Property | undefined) => p?.type === "date" || p?.type === "created_time" || p?.type === "updated_time";

/** The chart a new chart view starts with: records per status, select, date or checkbox. */
export function defaultChartSpec(props: Property[]): ChartSpec {
  const pick = ["status", "select", "date", "checkbox", "created_time"].map((t) => props.find((p) => p.type === t)).find(Boolean);
  return { chartType: "bar", xPropertyId: pick?.id ?? null, aggregation: "count", sort: "x", bucket: pick && isDateType(pick) ? "month" : null };
}

/** What a chart's axis can be: properties with a finite set of values or a date. */
export const canAxis = (p: Property) => ["select", "status", "checkbox", "date", "created_time", "updated_time"].includes(p.type);
export const canSeries = (p: Property) => ["select", "status", "checkbox"].includes(p.type);
export const canMeasure = (p: Property) =>
  p.type === "number" || p.type === "unique_id" || (p.type === "formula" && p.config.resultType === "number") || (p.type === "rollup" && p.config.function !== "earliest" && p.config.function !== "latest");

export function bucketLabel(key: string, bucket: DateBucket | null | undefined): string {
  switch (bucket ?? "month") {
    case "day":
      return formatWhen(key);
    case "week": {
      const m = /^(\d{4})-W(\d{2})$/.exec(key);
      return m ? `Week ${Number(m[2])}, ${m[1]}` : key;
    }
    case "month": {
      const m = /^(\d{4})-(\d{2})$/.exec(key);
      return m ? `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1]} ${m[1]}` : key;
    }
    default:
      return key;
  }
}

export function categoryLabel(prop: Property | undefined, key: string, bucket?: DateBucket | null): string {
  if (key === EMPTY_KEY) return isDateType(prop) ? "No date" : "No value";
  if (!prop) return key;
  if (prop.type === "checkbox") return key === "true" ? "Checked" : "Unchecked";
  if (isDateType(prop)) return bucketLabel(key, bucket);
  return optionsOf(prop).find((o) => o.id === key)?.name ?? "Unknown option";
}

/** Every bucket between the first and last, so a gap in time shows as zero instead of vanishing. */
export function fillDates(keys: string[], bucket: DateBucket): string[] {
  if (keys.length < 2 || bucket === "week") return keys;
  const first = keys[0];
  const last = keys[keys.length - 1];
  const out: string[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  if (bucket === "year") {
    for (let y = Number(first); y <= Number(last) && out.length <= GAP_FILL_LIMIT; y++) out.push(String(y));
  } else if (bucket === "month") {
    let [y, m] = first.split("-").map(Number);
    const [ly, lm] = last.split("-").map(Number);
    while ((y < ly || (y === ly && m <= lm)) && out.length <= GAP_FILL_LIMIT) {
      out.push(`${y}-${pad(m)}`);
      if (++m > 12) (m = 1), y++;
    }
  } else {
    const d = new Date(`${first}T00:00:00Z`);
    const end = new Date(`${last}T00:00:00Z`);
    while (d <= end && out.length <= GAP_FILL_LIMIT) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  return out.length > GAP_FILL_LIMIT ? keys : out;
}

function orderKeys(prop: Property | undefined, present: Set<string>, bucket: DateBucket | null | undefined): string[] {
  const rest = [...present].filter((k) => k !== EMPTY_KEY);
  let keys: string[];
  if (!prop) keys = rest.sort();
  else if (prop.type === "checkbox") keys = ["false", "true"].filter((k) => present.has(k));
  else if (isDateType(prop)) {
    keys = rest.sort();
    keys = fillDates(keys, bucket ?? "month");
  } else {
    const known = optionsOf(prop).map((o) => o.id);
    keys = [...known.filter((k) => present.has(k)), ...rest.filter((k) => !known.includes(k)).sort()];
  }
  return present.has(EMPTY_KEY) ? [...keys, EMPTY_KEY] : keys;
}

export function valueLabel(spec: ChartSpec, props: Property[]): string {
  if (spec.aggregation === "count") return "Records";
  const y = props.find((p) => p.id === spec.yPropertyId);
  const agg = AGGREGATIONS.find((a) => a.value === spec.aggregation)?.short ?? "";
  return y ? `${agg} of ${y.name}` : agg;
}

/** A sentence naming what the chart shows, used as its accessible name and its default title. */
export function describeChart(spec: ChartSpec, props: Property[]): string {
  const what = valueLabel(spec, props);
  if (spec.chartType === "kpi") return what;
  const x = props.find((p) => p.id === spec.xPropertyId);
  const g = props.find((p) => p.id === spec.groupPropertyId);
  return `${what} by ${x?.name ?? "…"}${g ? `, split by ${g.name}` : ""}`;
}

/** Turns the query result into what a chart draws: ordered categories, series and numbers. */
export function buildModel(spec: ChartSpec, props: Property[], data: ChartData): ChartModel {
  const xProp = props.find((p) => p.id === spec.xPropertyId);
  const gProp = props.find((p) => p.id === spec.groupPropertyId);
  const additive = isAdditive(spec.aggregation);
  const measure = (p: { value: number | null; count: number }) => (spec.aggregation === "count" ? p.count : (p.value ?? 0));

  const xKeys = new Set(data.points.map((p) => p.x ?? EMPTY_KEY));
  const gKeys = new Set(data.points.map((p) => p.group ?? EMPTY_KEY));
  let cats = orderKeys(xProp, xKeys, spec.bucket);
  const seriesKeys = gProp ? orderKeys(gProp, gKeys, null) : ["all"];

  const catIndex = new Map<string, number>();
  const rawValues = seriesKeys.map(() => new Array<number>(cats.length).fill(0));
  const recordsRaw = new Map<string, number>();
  const at = (key: string) => cats.indexOf(key);
  cats.forEach((k, i) => catIndex.set(k, i));
  for (const p of data.points) {
    const ci = catIndex.get(p.x ?? EMPTY_KEY) ?? at(p.x ?? EMPTY_KEY);
    const si = gProp ? seriesKeys.indexOf(p.group ?? EMPTY_KEY) : 0;
    if (ci < 0 || si < 0) continue;
    rawValues[si][ci] = measure(p);
    recordsRaw.set(cats[ci], (recordsRaw.get(cats[ci]) ?? 0) + p.count);
  }

  const totalOf = (ci: number) => (additive ? rawValues.reduce((n, row) => n + row[ci], 0) : Math.max(...rawValues.map((row) => row[ci]), 0));
  let order = cats.map((_, i) => i);
  if (spec.sort !== "x" && xProp && !isDateType(xProp)) {
    const sign = spec.sort === "value_desc" ? -1 : 1;
    const tail = order.filter((i) => cats[i] === EMPTY_KEY);
    order = order.filter((i) => cats[i] !== EMPTY_KEY).sort((a, b) => sign * (totalOf(a) - totalOf(b)) || a - b);
    order.push(...tail);
  } else if (spec.sort !== "x" && isDateType(xProp)) {
    // Time has its own order, but a ranking of buckets is still a fair thing to ask for.
    const sign = spec.sort === "value_desc" ? -1 : 1;
    order = [...order].sort((a, b) => sign * (totalOf(a) - totalOf(b)) || a - b);
  }
  if ((spec.chartType === "pie" || spec.chartType === "donut") && order.length > MAX_SLICES) order = order.slice(0, MAX_SLICES);

  cats = order.map((i) => cats[i]);
  const values = rawValues.map((row) => order.map((i) => row[i]));
  const categories: Category[] = cats.map((key) => ({
    key,
    label: categoryLabel(xProp, key, spec.bucket),
    tone: xProp && (xProp.type === "select" || xProp.type === "status") ? optionsOf(xProp).find((o) => o.id === key)?.color : undefined,
  }));
  const series: Series[] = gProp
    ? seriesKeys.map((key, i) => ({
        key,
        label: categoryLabel(gProp, key),
        tone: optionsOf(gProp).find((o) => o.id === key)?.color ?? TONES[i % TONES.length],
      }))
    : [{ key: "all", label: valueLabel(spec, props), tone: "violet" }];
  return {
    categories,
    series,
    values,
    totals: cats.map((_, ci) => (additive ? values.reduce((n, row) => n + row[ci], 0) : Math.max(...values.map((row) => row[ci]), 0))),
    records: cats.map((k) => recordsRaw.get(k) ?? 0),
    stackable: additive,
    valueLabel: valueLabel(spec, props),
    empty: data.points.length === 0,
  };
}

/** A round axis maximum and step that give about `ticks` gridlines. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (!(max > 0)) return { max: 1, step: 1 / ticks };
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const base = raw / pow;
  const step = (base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10) * pow;
  return { max: Math.ceil(max / step) * step, step };
}

export const compactNumber = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
export const fullNumber = (n: number) => formatNumber(n) || String(n);

/** An SVG path for a pie slice (r0 = 0) or a donut segment, angles in radians clockwise from twelve o'clock. */
export function arcPath(cx: number, cy: number, r: number, r0: number, a0: number, a1: number): string {
  const full = a1 - a0 >= Math.PI * 2 - 1e-6;
  const end = full ? a0 + Math.PI * 2 - 1e-4 : a1;
  const pt = (rad: number, a: number) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)].map((n) => +n.toFixed(2));
  const [x0, y0] = pt(r, a0);
  const [x1, y1] = pt(r, end);
  const large = end - a0 > Math.PI ? 1 : 0;
  if (r0 <= 0) return `M${cx} ${cy}L${x0} ${y0}A${r} ${r} 0 ${large} 1 ${x1} ${y1}Z`;
  const [x2, y2] = pt(r0, end);
  const [x3, y3] = pt(r0, a0);
  return `M${x0} ${y0}A${r} ${r} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${large} 0 ${x3} ${y3}Z`;
}

/** Shortens a category label for an axis, keeping the full text for the tooltip. */
export function clip(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, Math.max(1, max - 1))}…`;
}

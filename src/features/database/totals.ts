import type { AggregateKind, NumberFormat, Property } from "../../types";
import { formatNumberWith } from "./numberFormat";
import { formatWhen, isEmptyValue, numberFormatOf, valueType } from "./model";

export const AGGREGATE_LABELS: Record<AggregateKind, string> = {
  count: "Count",
  empty: "Empty",
  filled: "Filled",
  percent_filled: "% filled",
  sum: "Sum",
  average: "Average",
  median: "Median",
  min: "Min",
  max: "Max",
  range: "Range",
  earliest: "Earliest",
  latest: "Latest",
  date_range: "Date range",
  percent_checked: "% checked",
};

const ANY: AggregateKind[] = ["count", "empty", "filled", "percent_filled"];
const NUMBER: AggregateKind[] = ["sum", "average", "median", "min", "max", "range"];
const DATE: AggregateKind[] = ["earliest", "latest", "date_range"];

/** The summaries a column can show. Mirrors the backend's rules (`aggregate_ok`). */
export function aggregatesFor(p: Property): AggregateKind[] {
  if (p.type === "button") return [];
  switch (valueType(p)) {
    case "number":
    case "unique_id":
      return [...ANY, ...NUMBER];
    case "date":
    case "created_time":
    case "updated_time":
      return [...ANY, ...DATE];
    case "checkbox":
      return [...ANY, "percent_checked"];
    default:
      return ANY;
  }
}

const whole = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const percent = (fraction: number) => `${(fraction * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;

/** A computed summary as text for the totals row, group headers and tooltips; "" when there is nothing to show. */
export function formatAggregate(kind: AggregateKind, value: number | string | null, p: Property): string {
  if (value === null || value === undefined) return "";
  switch (kind) {
    case "count":
    case "empty":
    case "filled":
      return typeof value === "number" ? whole(value) : "";
    case "percent_filled":
    case "percent_checked":
      return typeof value === "number" ? percent(value) : "";
    case "earliest":
    case "latest":
      return typeof value === "string" ? formatWhen(value) : "";
    case "date_range":
      return typeof value === "number" ? `${whole(value)} ${Math.round(value) === 1 ? "day" : "days"}` : "";
    default: {
      if (typeof value !== "number") return "";
      const fmt = numberFormatOf(p) ?? null;
      // An average is rarely whole: unless the format sets decimals, round it to two places.
      return formatNumberWith(kind === "average" && fmt?.decimals === undefined ? Math.round(value * 100) / 100 : value, fmt);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// selection summary
// ---------------------------------------------------------------------------------------------

export interface SelectionSummary {
  /** Cells that hold something (a ticked checkbox counts; an unticked one does not). */
  count: number;
  /** Cells that hold a number. Sum and average appear only when there is at least one. */
  numbers: number;
  sum: number;
  average: number | null;
  /** The shared number format when every number comes from one property, else undefined. */
  format?: NumberFormat;
}

/** Count, sum and average over a block of cells. Only number cells feed the sum and average. */
export function summarizeSelection(cells: { prop: Property; value: unknown }[]): SelectionSummary {
  let count = 0;
  let numbers = 0;
  let sum = 0;
  const numeric = new Set<string>();
  let format: NumberFormat | undefined;
  for (const { prop, value } of cells) {
    if (value === false || isEmptyValue(value)) continue;
    count++;
    const vt = valueType(prop);
    if ((vt === "number" || vt === "unique_id") && typeof value === "number" && Number.isFinite(value) && prop.type !== "unique_id") {
      numbers++;
      sum += value;
      if (!numeric.has(prop.id)) {
        numeric.add(prop.id);
        format = numberFormatOf(prop);
      }
    }
  }
  return { count, numbers, sum, average: numbers ? sum / numbers : null, format: numeric.size === 1 ? format : undefined };
}

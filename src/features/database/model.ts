import type { IconName } from "../../components/Icon";
import type { Property, PropertyType, RecordLink, RollupFunction, SelectOption } from "../../types";

export interface OperatorDef {
  value: string;
  label: string;
  needsValue: boolean;
}

export interface TypeMeta {
  label: string;
  icon: IconName;
  /** False for properties the app calculates. */
  editable: boolean;
  sortable: boolean;
  operators: OperatorDef[];
}

const op = (value: string, label: string, needsValue = true): OperatorDef => ({ value, label, needsValue });
const EMPTY = [op("is_empty", "is empty", false), op("is_not_empty", "is not empty", false)];

const TEXT_OPS = [op("contains", "contains"), op("not_contains", "does not contain"), op("=", "is"), op("!=", "is not"), ...EMPTY];
const NUMBER_OPS = [op("=", "equals"), op("!=", "does not equal"), op(">", "is greater than"), op(">=", "is at least"), op("<", "is less than"), op("<=", "is at most"), ...EMPTY];
const OPTION_OPS = [op("=", "is"), op("!=", "is not"), ...EMPTY];
const MULTI_OPS = [op("contains", "contains"), op("not_contains", "does not contain"), ...EMPTY];
const DATE_OPS = [op("=", "is"), op("before", "is before"), op("after", "is after"), op("between", "is between"), ...EMPTY];
const STAMP_OPS = DATE_OPS.filter((o) => o.needsValue);

export const TYPE_META: Record<PropertyType, TypeMeta> = {
  title: { label: "Title", icon: "text", editable: true, sortable: true, operators: TEXT_OPS },
  text: { label: "Text", icon: "text", editable: true, sortable: true, operators: TEXT_OPS },
  number: { label: "Number", icon: "hash", editable: true, sortable: true, operators: NUMBER_OPS },
  select: { label: "Select", icon: "tag", editable: true, sortable: true, operators: OPTION_OPS },
  multi_select: { label: "Multi-select", icon: "tag", editable: true, sortable: false, operators: MULTI_OPS },
  status: { label: "Status", icon: "tip", editable: true, sortable: true, operators: OPTION_OPS },
  date: { label: "Date", icon: "calendar", editable: true, sortable: true, operators: DATE_OPS },
  checkbox: { label: "Checkbox", icon: "todo", editable: true, sortable: true, operators: [op("=", "is")] },
  url: { label: "URL", icon: "link", editable: true, sortable: true, operators: TEXT_OPS },
  email: { label: "Email", icon: "mail", editable: true, sortable: true, operators: TEXT_OPS },
  phone: { label: "Phone", icon: "phone", editable: true, sortable: true, operators: TEXT_OPS },
  created_time: { label: "Created time", icon: "clock", editable: false, sortable: true, operators: STAMP_OPS },
  updated_time: { label: "Last edited time", icon: "clock", editable: false, sortable: true, operators: STAMP_OPS },
  unique_id: { label: "ID", icon: "hash", editable: false, sortable: true, operators: NUMBER_OPS.filter((o) => o.needsValue) },
  relation: { label: "Relation", icon: "link", editable: true, sortable: false, operators: EMPTY },
  rollup: { label: "Rollup", icon: "layers", editable: false, sortable: true, operators: NUMBER_OPS },
  formula: { label: "Formula", icon: "function", editable: false, sortable: true, operators: TEXT_OPS },
  button: { label: "Button", icon: "play", editable: false, sortable: false, operators: [] },
};

export const ROLLUP_FUNCTIONS: { value: RollupFunction; label: string; accepts: (t: PropertyType) => boolean }[] = [
  { value: "count", label: "Count", accepts: () => true },
  { value: "count_unique", label: "Count unique values", accepts: () => true },
  { value: "sum", label: "Sum", accepts: (t) => t === "number" || t === "unique_id" },
  { value: "average", label: "Average", accepts: (t) => t === "number" || t === "unique_id" },
  { value: "min", label: "Minimum", accepts: (t) => t === "number" || t === "unique_id" },
  { value: "max", label: "Maximum", accepts: (t) => t === "number" || t === "unique_id" },
  { value: "earliest", label: "Earliest date", accepts: (t) => t === "date" || t === "created_time" || t === "updated_time" },
  { value: "latest", label: "Latest date", accepts: (t) => t === "date" || t === "created_time" || t === "updated_time" },
  { value: "percent_checked", label: "Percent checked", accepts: (t) => t === "checkbox" },
  { value: "percent_done", label: "Percent done (status)", accepts: (t) => t === "status" },
];

/**
 * The type a property's values behave as in filters and sorts: a rollup is a number or a date,
 * a formula takes the type of its result, and a list result can only be tested for emptiness.
 */
export function valueType(p: Property): PropertyType {
  if (p.type === "rollup") return p.config.function === "earliest" || p.config.function === "latest" ? "date" : "number";
  if (p.type === "formula") {
    switch (p.config.resultType) {
      case "number":
        return "number";
      case "bool":
        return "checkbox";
      case "date":
        return "date";
      case "list":
      case "any":
        return "relation";
      default:
        return "text";
    }
  }
  return p.type;
}

export const isFilterable = (p: Property) => TYPE_META[valueType(p)].operators.length > 0;
export const isSortable = (p: Property) => (p.type === "formula" ? ["number", "text", "bool", "date"].includes(p.config.resultType ?? "") : TYPE_META[p.type].sortable);
/** Properties edited in a popover rather than inline. */
export const isPopoverType = (t: PropertyType) => t === "select" || t === "multi_select" || t === "status" || t === "date" || t === "relation";

/** A formula or rollup result as text: numbers, text, dates, true/false, lists and errors. */
export function formatFormulaValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "object") {
    const o = v as { error?: string; start?: string };
    if (o.error) return o.error;
    if (o.start) return formatWhen(o.start);
  }
  return "";
}

export const linksOf = (v: unknown): RecordLink[] => (Array.isArray(v) ? (v as RecordLink[]) : []);

/** Rollup results: counts and numbers as numbers, percentages with a sign, dates as dates. */
export function formatRollup(p: Property, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (p.config.function === "percent_checked" || p.config.function === "percent_done") return typeof v === "number" ? `${Math.round(v)}%` : "";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}/.test(v) ? formatWhen(v) : v;
  return "";
}

/** Types that can be added to a database (there is exactly one title). */
export const ADDABLE_TYPES = (Object.keys(TYPE_META) as PropertyType[]).filter((t) => t !== "title");

export const isOptionType = (t: PropertyType) => t === "select" || t === "multi_select" || t === "status";
export const isTextEntry = (t: PropertyType) => ["title", "text", "number", "url", "email", "phone"].includes(t);

export const operatorsFor = (t: PropertyType) => TYPE_META[t].operators;
export const defaultOperator = (t: PropertyType) => TYPE_META[t].operators[0].value;
export const operatorNeedsValue = (t: PropertyType, o: string) => TYPE_META[t].operators.find((x) => x.value === o)?.needsValue ?? true;

export const optionsOf = (p: Property): SelectOption[] => p.config.options ?? [];
export const optionById = (p: Property, id: unknown): SelectOption | undefined => optionsOf(p).find((o) => o.id === id);

export const DEFAULT_WIDTH = 180;
export const TITLE_WIDTH = 280;

/** A sensible starting value for a filter condition. */
export function defaultFilterValue(p: Property, operator: string): unknown {
  if (!operatorNeedsValue(valueType(p), operator)) return undefined;
  switch (valueType(p)) {
    case "number":
    case "unique_id":
      return null;
    case "select":
    case "status":
    case "multi_select":
      return optionsOf(p)[0]?.id ?? null;
    case "date":
    case "created_time":
    case "updated_time":
      return operator === "between" ? [{ relativeDays: -7 }, { relativeDays: 0 }] : { relativeDays: 0 };
    case "checkbox":
      return true;
    default:
      return "";
  }
}

const isDay = (v: unknown): boolean =>
  (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) ||
  (!!v && typeof v === "object" && typeof (v as { relativeDays?: unknown }).relativeDays === "number");

/** Whether a condition has everything it needs to be saved. Incomplete ones stay in the editor only. */
export function isCompleteCondition(p: Property | undefined, operator: string, value: unknown): boolean {
  if (!p) return false;
  if (!operatorNeedsValue(valueType(p), operator)) return true;
  switch (valueType(p)) {
    case "number":
    case "unique_id":
      return typeof value === "number" && Number.isFinite(value);
    case "select":
    case "status":
    case "multi_select":
      return typeof value === "string" && value.length > 0;
    case "date":
    case "created_time":
    case "updated_time":
      return operator === "between" ? Array.isArray(value) && value.length === 2 && value.every(isDay) : isDay(value);
    case "checkbox":
      return typeof value === "boolean";
    default:
      return typeof value === "string" && value.trim().length > 0;
  }
}

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 7, 2026" or "Oct 7, 2026 09:30" from an ISO date or date-time string, without time-zone shifts. */
export function formatWhen(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const day = `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
  return m[4] ? `${day} ${m[4]}:${m[5]}` : day;
}

/** For created/updated stamps (UTC ISO): shown in local time. */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDateValue(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const { start, end } = v as { start?: string; end?: string };
  if (!start) return "";
  return end ? `${formatWhen(start)} → ${formatWhen(end)}` : formatWhen(start);
}

export function formatNumber(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 10 }) : "";
}

export function uniqueIdLabel(p: Property, n: number): string {
  const prefix = p.config.prefix ?? "";
  return prefix ? `${prefix}-${n}` : String(n);
}

/** Plain text for a cell, used for accessibility labels and for the edit field's starting value. */
export function cellText(p: Property, row: { title: string; uniqueId: number; createdAt: string; updatedAt: string; values: Record<string, unknown> }): string {
  const v = row.values[p.id];
  switch (p.type) {
    case "title":
      return row.title;
    case "unique_id":
      return uniqueIdLabel(p, row.uniqueId);
    case "created_time":
      return formatStamp(row.createdAt);
    case "updated_time":
      return formatStamp(row.updatedAt);
    case "number":
      return formatNumber(v);
    case "date":
      return formatDateValue(v);
    case "checkbox":
      return v === true ? "Checked" : "Unchecked";
    case "select":
    case "status":
      return optionById(p, v)?.name ?? "";
    case "multi_select":
      return Array.isArray(v) ? v.map((id) => optionById(p, id)?.name ?? "Unknown option").join(", ") : "";
    case "relation":
      return linksOf(v)
        .map((l) => l.title || "Untitled")
        .join(", ");
    case "rollup":
      return formatRollup(p, v);
    case "formula":
      return formatFormulaValue(v);
    default:
      return typeof v === "string" ? v : "";
  }
}

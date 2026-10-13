import type { FilterNode, Property, SharedFilter, SharedFilterType } from "../../types";
import { optionsOf } from "../database/model";

export const DAY_PRESETS: { value: number; label: string }[] = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: -7, label: "Next 7 days" },
  { value: -30, label: "Next 30 days" },
];

const TEXT_TYPES = ["title", "text", "url", "email", "phone"];
const DATE_TYPES = ["date", "created_time", "updated_time"];

/** Which kind of dashboard filter a property can have, if any. */
export function filterTypeFor(p: Property): SharedFilterType | null {
  if (p.type === "select" || p.type === "status" || p.type === "multi_select") return "option";
  if (p.type === "checkbox") return "checkbox";
  if (TEXT_TYPES.includes(p.type)) return "text";
  if (DATE_TYPES.includes(p.type)) return "date_days";
  return null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * One dashboard filter as a condition on one database, found by property name. Databases without
 * a matching property (or with one of an incompatible type) are left alone: null.
 */
export function leafFor(f: SharedFilter, props: Property[]): FilterNode | null {
  const p = props.find((x) => same(x.name, f.propertyName));
  if (!p || filterTypeFor(p) !== f.type) return null;
  switch (f.type) {
    case "option": {
      const id = optionsOf(p).find((o) => same(o.name, String(f.value)))?.id ?? "__no_such_option__";
      return { propertyId: p.id, operator: p.type === "multi_select" ? "contains" : "=", value: id };
    }
    case "checkbox":
      return { propertyId: p.id, operator: "=", value: f.value === true };
    case "text":
      return String(f.value).trim() ? { propertyId: p.id, operator: "contains", value: String(f.value).trim() } : null;
    default: {
      const n = Number(f.value);
      if (!Number.isFinite(n) || n === 0) return null;
      return {
        propertyId: p.id,
        operator: "between",
        value: n > 0 ? [{ relativeDays: -n }, { relativeDays: 0 }] : [{ relativeDays: 0 }, { relativeDays: -n }],
      };
    }
  }
}

/** All of the dashboard's filters that apply to a database, combined. */
export function filterFor(filters: SharedFilter[], props: Property[]): FilterNode | null {
  const leaves = filters.map((f) => leafFor(f, props)).filter((x): x is FilterNode => x !== null);
  if (leaves.length === 0) return null;
  return leaves.length === 1 ? leaves[0] : { op: "and", children: leaves };
}

export function describe(f: SharedFilter): string {
  switch (f.type) {
    case "option":
      return `${f.propertyName} is ${String(f.value)}`;
    case "checkbox":
      return `${f.propertyName} is ${f.value === true ? "checked" : "unchecked"}`;
    case "text":
      return `${f.propertyName} contains “${String(f.value)}”`;
    default:
      return `${f.propertyName}: ${DAY_PRESETS.find((d) => d.value === f.value)?.label.toLowerCase() ?? `${String(f.value)} days`}`;
  }
}

export interface FilterChoice {
  name: string;
  type: SharedFilterType;
  /** Option names found under this property name in any of the databases. */
  options: string[];
}

/** The properties a dashboard filter can be made on: every name found in the dashboard's databases. */
export function choicesFrom(databases: Property[][]): FilterChoice[] {
  const byName = new Map<string, FilterChoice>();
  for (const props of databases) {
    for (const p of props) {
      const type = filterTypeFor(p);
      if (!type) continue;
      const key = p.name.trim().toLowerCase();
      const known = byName.get(key);
      if (known && known.type !== type) continue;
      const entry = known ?? { name: p.name, type, options: [] };
      for (const o of optionsOf(p)) if (!entry.options.some((x) => same(x, o.name))) entry.options.push(o.name);
      byName.set(key, entry);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function defaultValue(c: FilterChoice): unknown {
  switch (c.type) {
    case "option":
      return c.options[0] ?? "";
    case "checkbox":
      return true;
    case "text":
      return "";
    default:
      return 30;
  }
}

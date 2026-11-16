import type { FilterNode, Property } from "../../types";
import { rootOf } from "./filter";
import { optionsOf, valueType } from "./model";

interface Row {
  title: string;
  uniqueId: number;
  values: Record<string, unknown>;
}

const isoDay = (v: unknown): string | null => {
  const start = v && typeof v === "object" ? (v as { start?: unknown }).start : v;
  return typeof start === "string" && /^\d{4}-\d{2}-\d{2}/.test(start) ? start.slice(0, 10) : null;
};

/**
 * The condition behind "Filter by this value" (or, with `exclude`, "Exclude this value") for one cell,
 * or null when the property cannot be filtered that way (dates cannot be excluded; relations and
 * buttons have no value to match).
 */
export function quickCondition(p: Property, row: Row, exclude: boolean): FilterNode | null {
  const t = valueType(p);
  const v = p.type === "title" ? row.title : row.values[p.id];
  const leaf = (operator: string, value?: unknown): FilterNode => (value === undefined ? { propertyId: p.id, operator } : { propertyId: p.id, operator, value });
  const emptiness = () => leaf(exclude ? "is_not_empty" : "is_empty");
  switch (t) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone": {
      if (p.type === "formula" && typeof v !== "string") return null;
      const text = typeof v === "string" ? v : "";
      return text.trim() ? leaf(exclude ? "!=" : "=", text) : emptiness();
    }
    case "number":
    case "unique_id": {
      if (p.type === "unique_id") return leaf(exclude ? "!=" : "=", row.uniqueId);
      return typeof v === "number" ? leaf(exclude ? "!=" : "=", v) : emptiness();
    }
    case "select":
    case "status":
      return typeof v === "string" && v ? leaf(exclude ? "!=" : "=", v) : emptiness();
    case "multi_select": {
      const known = optionsOf(p);
      const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && known.some((o) => o.id === x)) : [];
      if (ids.length === 0) return emptiness();
      const leaves = ids.map((id) => leaf(exclude ? "not_contains" : "contains", id));
      return leaves.length === 1 ? leaves[0] : { op: "and", children: leaves };
    }
    case "checkbox":
      return leaf("=", exclude ? v !== true : v === true);
    case "date": {
      if (exclude) return null;
      const day = isoDay(v);
      return day ? leaf("=", day) : leaf("is_empty");
    }
    default:
      return null;
  }
}

/** Adds a condition to a view's filter so that both it and everything already there must hold. */
export function andCondition(filter: FilterNode | null, node: FilterNode): FilterNode {
  if (!filter) return node;
  const root = rootOf(filter);
  if (root.op === "and") return { ...root, children: [...root.children, node] };
  return { op: "and", children: [root, node] };
}

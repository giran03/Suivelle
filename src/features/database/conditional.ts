import type { FilterNode, FormatRule, Property, RecordRow, Tone } from "../../types";
import { isGroup } from "./filter";
import { isEmptyValue, valueType } from "./model";

/**
 * Conditional formatting runs in the frontend over the rows that are loaded, using the same
 * condition shape as a view's filter. The backend never sees a rule's result: nothing is stored on
 * records. This is a client-side mirror of the backend's filter semantics for what a loaded row
 * can answer on its own:
 *   - text: contains, not_contains, =, != (case-insensitive), is_empty, is_not_empty
 *   - number: =, !=, >, >=, <, <=, is_empty, is_not_empty
 *   - select / status: =, !=, is_empty, is_not_empty
 *   - multi-select: contains, not_contains, is_empty, is_not_empty
 *   - date (and created/last edited): =, before, after, between (whole days), is_empty, is_not_empty
 *   - checkbox: =
 *   - relation and list results: contains (by record id), not_contains, is_empty, is_not_empty
 * Relative days ({ relativeDays: n }) count from today in local time. An unknown operator never matches.
 */

type Props = ReadonlyMap<string, Property>;

const pad = (n: number) => String(n).padStart(2, "0");
const dayString = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A filter's day value (an ISO string or a relative offset) as YYYY-MM-DD. */
function dayOfFilter(v: unknown, today: Date): string | null {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (v && typeof v === "object" && typeof (v as { relativeDays?: unknown }).relativeDays === "number") {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (v as { relativeDays: number }).relativeDays);
    return dayString(d);
  }
  return null;
}

function dayOfCell(v: unknown): string | null {
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  if (v && typeof v === "object" && typeof (v as { start?: unknown }).start === "string") return dayOfCell((v as { start: string }).start);
  return null;
}

const idsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? String((x as { id?: unknown }).id) : String(x))) : []);

export function cellValue(p: Property, row: RecordRow): unknown {
  switch (p.type) {
    case "title":
      return row.title;
    case "created_time":
      return row.createdAt;
    case "updated_time":
      return row.updatedAt;
    case "unique_id":
      return row.uniqueId;
    default:
      return row.values[p.id];
  }
}

export function matchesLeaf(op: string, expected: unknown, p: Property, row: RecordRow, today: Date): boolean {
  const v = cellValue(p, row);
  const vt = valueType(p);
  const empty = vt === "date" || vt === "created_time" || vt === "updated_time" ? dayOfCell(v) === null : vt === "text" || vt === "title" || vt === "url" || vt === "email" || vt === "phone" ? v == null || v === "" : vt === "number" || vt === "unique_id" ? typeof v !== "number" : vt === "checkbox" ? false : isEmptyValue(v);
  if (op === "is_empty") return empty;
  if (op === "is_not_empty") return !empty;
  switch (vt) {
    case "number":
    case "unique_id": {
      const n = typeof expected === "number" ? expected : NaN;
      if (Number.isNaN(n)) return false;
      if (op === "!=") return typeof v !== "number" || v !== n;
      if (typeof v !== "number") return false;
      return op === "=" ? v === n : op === ">" ? v > n : op === ">=" ? v >= n : op === "<" ? v < n : op === "<=" ? v <= n : false;
    }
    case "select":
    case "status":
      return op === "=" ? v === expected : op === "!=" ? v !== expected : false;
    case "multi_select": {
      const has = idsOf(v).includes(String(expected));
      return op === "contains" ? has : op === "not_contains" ? !has : false;
    }
    case "relation": {
      const has = idsOf(v).includes(String(expected));
      return op === "contains" ? has : op === "not_contains" ? !has : false;
    }
    case "checkbox":
      return op === "=" ? (v === true) === (expected === true) : false;
    case "date":
    case "created_time":
    case "updated_time": {
      const day = dayOfCell(v);
      if (day === null) return false;
      if (op === "between") {
        if (!Array.isArray(expected) || expected.length !== 2) return false;
        const [a, b] = [dayOfFilter(expected[0], today), dayOfFilter(expected[1], today)];
        return a !== null && b !== null && day >= a && day <= b;
      }
      const target = dayOfFilter(expected, today);
      if (target === null) return false;
      return op === "=" ? day === target : op === "before" ? day < target : op === "after" ? day > target : false;
    }
    default: {
      const text = typeof v === "string" ? v : "";
      const want = typeof expected === "string" ? expected.toLowerCase() : "";
      const have = text.toLowerCase();
      if (op === "=") return have === want;
      if (op === "!=") return have !== want;
      if (op === "contains") return have.includes(want);
      if (op === "not_contains") return !have.includes(want);
      return false;
    }
  }
}

/** Whether a row satisfies a filter tree. A group with no children matches everything. */
export function matchesFilter(node: FilterNode, row: RecordRow, props: Props, today: Date = new Date()): boolean {
  if (isGroup(node)) {
    if (node.children.length === 0) return true;
    return node.op === "or" ? node.children.some((c) => matchesFilter(c, row, props, today)) : node.children.every((c) => matchesFilter(c, row, props, today));
  }
  const p = props.get(node.propertyId);
  return !!p && matchesLeaf(node.operator, node.value, p, row, today);
}

/** The column a cell rule colours: the one it names, else the first property its condition tests. */
export function ruleColumn(rule: FormatRule): string | null {
  if (rule.propertyId) return rule.propertyId;
  const first = (n: FilterNode): string | null => (isGroup(n) ? n.children.map(first).find((x) => x !== null) ?? null : n.propertyId);
  return first(rule.filter);
}

export interface RowTones {
  row: Tone | null;
  /** Column (property id) to tone. */
  cells: Map<string, Tone>;
}

/** What colour a row and its cells get. The first rule that matches wins for the row and for each column. */
export function evaluateRules(rules: readonly FormatRule[] | undefined, row: RecordRow, props: Props, today: Date = new Date()): RowTones | null {
  if (!rules?.length) return null;
  let rowTone: Tone | null = null;
  const cells = new Map<string, Tone>();
  for (const rule of rules) {
    if (rule.target === "row" ? rowTone !== null : false) continue;
    const column = rule.target === "cell" ? ruleColumn(rule) : null;
    if (rule.target === "cell" && (!column || cells.has(column))) continue;
    if (!matchesFilter(rule.filter, row, props, today)) continue;
    if (rule.target === "row") rowTone = rule.color;
    else if (column) cells.set(column, rule.color);
  }
  return rowTone || cells.size ? { row: rowTone, cells } : null;
}

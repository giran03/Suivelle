import type { GroupCount, Property, ViewConfig } from "../../types";
import { optionById, formatWhen } from "./model";

export const EMPTY_GROUP = "__empty";

export interface HeaderSegment {
  kind: "header";
  level: 0 | 1;
  key: string;
  /** For a subgroup header: the group it sits in. */
  parentKey?: string;
  count: number;
  collapsed: boolean;
  start: number;
}

export interface RowsSegment {
  kind: "rows";
  groupKey: string;
  subKey?: string;
  count: number;
  start: number;
}

export type Segment = HeaderSegment | RowsSegment;

export interface Layout {
  segments: Segment[];
  /** Rows plus headers: the number of virtual list entries. */
  size: number;
  /** Records only. */
  records: number;
}

export const collapseKey = (group: string, sub?: string) => (sub === undefined ? group : `${group}\u0000${sub}`);

/**
 * Flattens groups into one scrollable list: a header per group (and subgroup), followed by that
 * group's records. Collapsed groups contribute their header only.
 */
export function buildLayout(groups: GroupCount[], collapsed: ReadonlySet<string>): Layout {
  const segments: Segment[] = [];
  let at = 0;
  let records = 0;
  for (const g of groups) {
    const gCollapsed = collapsed.has(collapseKey(g.key));
    segments.push({ kind: "header", level: 0, key: g.key, count: g.count, collapsed: gCollapsed, start: at++ });
    if (gCollapsed) continue;
    const subs = g.subgroups.filter((s) => s.count > 0);
    if (subs.length === 0) {
      if (g.count > 0) {
        segments.push({ kind: "rows", groupKey: g.key, count: g.count, start: at });
        at += g.count;
        records += g.count;
      }
      continue;
    }
    for (const s of subs) {
      const sCollapsed = collapsed.has(collapseKey(g.key, s.key));
      segments.push({ kind: "header", level: 1, key: s.key, parentKey: g.key, count: s.count, collapsed: sCollapsed, start: at++ });
      if (sCollapsed) continue;
      segments.push({ kind: "rows", groupKey: g.key, subKey: s.key, count: s.count, start: at });
      at += s.count;
      records += s.count;
    }
  }
  return { segments, size: at, records };
}

/** The segment holding virtual index `index`, and the offset inside it. */
export function locate(layout: Layout, index: number): { segment: Segment; offset: number } | null {
  const { segments } = layout;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    const len = s.kind === "header" ? 1 : s.count;
    if (index < s.start) hi = mid - 1;
    else if (index >= s.start + len) lo = mid + 1;
    else return { segment: s, offset: index - s.start };
  }
  return null;
}

/** Human label for a group key. */
export function groupLabel(prop: Property | undefined, key: string, bucket?: string | null): string {
  if (key === EMPTY_GROUP) return prop ? `No ${prop.name}` : "No value";
  if (!prop) return key;
  switch (prop.type) {
    case "select":
    case "status":
      return optionById(prop, key)?.name ?? "Unknown option";
    case "checkbox":
      return key === "true" ? "Checked" : "Unchecked";
    default:
      return bucketLabel(key, bucket);
  }
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function bucketLabel(key: string, bucket?: string | null): string {
  if (bucket === "year") return key;
  if (bucket === "month") {
    const [y, m] = key.split("-");
    return MONTH_NAMES[Number(m) - 1] ? `${MONTH_NAMES[Number(m) - 1]} ${y}` : key;
  }
  if (bucket === "week") return key.replace("-W", " week ");
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? formatWhen(key) : key;
}

/** The value a record should get when dropped into a group, or `undefined` if the group cannot be set by dragging. */
export function valueForGroup(prop: Property | undefined, key: string): { value: unknown } | undefined {
  if (!prop) return undefined;
  if (prop.type === "select" || prop.type === "status") return { value: key === EMPTY_GROUP ? null : key };
  if (prop.type === "checkbox") return { value: key === "true" };
  return undefined; // date buckets and the like are not a single value
}

export const isGrouped = (cfg: ViewConfig | undefined): boolean => !!cfg?.group;

import type { FilterGroup, FilterLeaf, FilterNode, Property } from "../../types";
import { defaultFilterValue, defaultOperator, isCompleteCondition, valueType } from "./model";

export const isGroup = (n: FilterNode): n is FilterGroup => "children" in n;

/** The editor always works on a root group; a saved single condition is wrapped into one. */
export function rootOf(filter: FilterNode | null): FilterGroup {
  if (!filter) return { op: "and", children: [] };
  return isGroup(filter) ? filter : { op: "and", children: [filter] };
}

export function newCondition(p: Property): FilterLeaf {
  const operator = defaultOperator(valueType(p));
  return { propertyId: p.id, operator, value: defaultFilterValue(p, operator) };
}

/** Applies `fn` to the node at `path` (indexes into children), returning a new tree. */
export function updateAt(root: FilterGroup, path: number[], fn: (n: FilterNode) => FilterNode): FilterGroup {
  if (path.length === 0) return fn(root) as FilterGroup;
  const [i, ...rest] = path;
  return {
    ...root,
    children: root.children.map((c, idx) => (idx === i ? (rest.length === 0 ? fn(c) : updateAt(c as FilterGroup, rest, fn)) : c)),
  };
}

export function removeAt(root: FilterGroup, path: number[]): FilterGroup {
  const parent = path.slice(0, -1);
  const index = path[path.length - 1];
  return updateAt(root, parent, (g) => ({ ...(g as FilterGroup), children: (g as FilterGroup).children.filter((_, i) => i !== index) }));
}

export function addTo(root: FilterGroup, groupPath: number[], node: FilterNode): FilterGroup {
  return updateAt(root, groupPath, (g) => ({ ...(g as FilterGroup), children: [...(g as FilterGroup).children, node] }));
}

/**
 * What gets saved: incomplete conditions and empty groups are dropped, and a group with a single
 * child collapses to that child. Returns null when nothing is left to filter by.
 */
export function compact(node: FilterNode, props: ReadonlyMap<string, Property>): FilterNode | null {
  if (!isGroup(node)) {
    return isCompleteCondition(props.get(node.propertyId), node.operator, node.value) ? stripValue(node) : null;
  }
  const kids = node.children.map((c) => compact(c, props)).filter((c): c is FilterNode => c !== null);
  if (kids.length === 0) return null;
  return { op: node.op, children: kids };
}

function stripValue(leaf: FilterLeaf): FilterLeaf {
  return leaf.value === undefined ? { propertyId: leaf.propertyId, operator: leaf.operator } : leaf;
}

/** Number of saved conditions, for the toolbar badge. */
export function countConditions(filter: FilterNode | null): number {
  if (!filter) return 0;
  return isGroup(filter) ? filter.children.reduce((n, c) => n + countConditions(c), 0) : 1;
}

/** Depth of nesting below the root, used to keep the builder to one level of grouping. */
export function depthOf(node: FilterNode): number {
  return isGroup(node) ? 1 + Math.max(0, ...node.children.map(depthOf)) : 0;
}

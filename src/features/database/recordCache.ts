/** Keep recently used pages without evicting the viewport or an active edit. */
export const MAX_RECORD_PAGES = 20;

export function trimRecordPages<T>(pages: Map<string, T>, keep: ReadonlySet<string>): Map<string, T> {
  const next = new Map(pages);
  for (const key of next.keys()) {
    if (next.size <= Math.max(MAX_RECORD_PAGES, keep.size)) break;
    if (!keep.has(key)) next.delete(key);
  }
  return next;
}

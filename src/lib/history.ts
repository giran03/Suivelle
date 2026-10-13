/** Back/forward navigation stack of page ids. Pure so it can be tested without the UI. */
export interface History {
  stack: string[];
  index: number;
}

export const MAX_HISTORY = 100;
export const emptyHistory: History = { stack: [], index: -1 };

export const current = (h: History): string | null => h.stack[h.index] ?? null;
export const canBack = (h: History) => h.index > 0;
export const canForward = (h: History) => h.index < h.stack.length - 1;

/** Visiting a page drops any forward entries; revisiting the current page is a no-op. */
export function push(h: History, id: string): History {
  if (current(h) === id) return h;
  const stack = [...h.stack.slice(0, h.index + 1), id].slice(-MAX_HISTORY);
  return { stack, index: stack.length - 1 };
}

export const back = (h: History): History => (canBack(h) ? { ...h, index: h.index - 1 } : h);
export const forward = (h: History): History => (canForward(h) ? { ...h, index: h.index + 1 } : h);

/** Removes every occurrence of the given ids (pages that no longer exist), keeping the position stable. */
export function remove(h: History, ids: ReadonlySet<string>): History {
  const kept: string[] = [];
  let index = -1;
  h.stack.forEach((id, i) => {
    if (ids.has(id)) return;
    kept.push(id);
    if (i <= h.index) index = kept.length - 1;
  });
  return { stack: kept, index };
}

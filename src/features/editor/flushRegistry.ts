/** Mounted editors register their save function so other code can force pending edits to disk first. */
const flushers = new Set<() => Promise<void>>();

export function registerFlusher(fn: () => Promise<void>): () => void {
  flushers.add(fn);
  return () => void flushers.delete(fn);
}

export async function flushAllEditors(strict = false): Promise<void> {
  await Promise.all([...flushers].map((f) => strict ? f() : f().catch(() => undefined)));
}

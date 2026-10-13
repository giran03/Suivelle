type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

/** Calls `fn` whenever the synced page `pageId` has just been saved somewhere. Returns the unsubscribe function. */
export function onSyncedSaved(pageId: string, fn: Listener): () => void {
  const set = listeners.get(pageId) ?? new Set<Listener>();
  set.add(fn);
  listeners.set(pageId, set);
  return () => {
    set.delete(fn);
    if (!set.size && listeners.get(pageId) === set) listeners.delete(pageId);
  };
}

/** Tells every other view of this synced page that its saved content changed, so it can reload. */
export function announceSyncedSaved(pageId: string): void {
  for (const fn of [...(listeners.get(pageId) ?? [])]) fn();
}

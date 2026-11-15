/**
 * "Frecency": how often and how recently something was used, so the palette can put what you reach for first.
 * Each use adds one point; points halve every week. Stored on this device only.
 */
const KEY = "suivelle.frecency.v1";
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 400;

interface Entry { score: number; at: number }
type Table = Record<string, Entry>;

const decayed = (e: Entry, now: number) => e.score * 0.5 ** ((now - e.at) / HALF_LIFE_MS);

function read(): Table {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

export function recordUse(id: string, now = Date.now()): void {
  const table = read();
  const prev = table[id];
  table[id] = { score: (prev ? decayed(prev, now) : 0) + 1, at: now };
  const keys = Object.keys(table);
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys.sort((a, b) => decayed(table[a], now) - decayed(table[b], now)).slice(0, keys.length - MAX_ENTRIES)) delete table[k];
  }
  try { localStorage.setItem(KEY, JSON.stringify(table)); } catch { /* ranking is a nicety; losing it is fine */ }
}

/** The current frecency of an id; 0 when it was never used. */
export function frecency(id: string, now = Date.now(), table: Table = read()): number {
  const e = table[id];
  return e ? decayed(e, now) : 0;
}

/** A reader that loads the table once, for ranking many ids. */
export function frecencyReader(now = Date.now()): (id: string) => number {
  const table = read();
  return (id) => frecency(id, now, table);
}

import type { Property, RecordRow } from "../../types";

/** Properties whose text can be replaced. */
export const REPLACEABLE = ["title", "text", "url", "email", "phone"];
export const isReplaceable = (p: Property) => REPLACEABLE.includes(p.type);

/** The most records one find and replace looks at, and the most cells it changes. */
export const SCAN_LIMIT = 5000;
export const CELL_LIMIT = 5000;

export interface FindOptions {
  find: string;
  replace: string;
  matchCase: boolean;
  /** The whole cell must equal the search text, instead of containing it. */
  wholeCell: boolean;
}

const MAX_TITLE = 500;
const MAX_TEXT = 10_000;
const MAX_URL = 2_048;

/** The text after replacing, or null when the search text is not found. */
export function replaceInText(text: string, o: FindOptions): string | null {
  if (!o.find) return null;
  if (o.wholeCell) {
    const same = o.matchCase ? text === o.find : text.toLowerCase() === o.find.toLowerCase();
    return same ? o.replace : null;
  }
  const hay = o.matchCase ? text : text.toLowerCase();
  const needle = o.matchCase ? o.find : o.find.toLowerCase();
  // Lowercasing can change a string's length (some characters expand), which would shift the offsets.
  if (hay.length !== text.length) {
    if (o.matchCase) return null;
    return replaceByRegExp(text, o);
  }
  let at = hay.indexOf(needle);
  if (at < 0) return null;
  let out = "";
  let from = 0;
  while (at >= 0) {
    out += text.slice(from, at) + o.replace;
    from = at + needle.length;
    at = hay.indexOf(needle, from);
  }
  return out + text.slice(from);
}

function replaceByRegExp(text: string, o: FindOptions): string | null {
  const escaped = o.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "gi");
  return re.test(text) ? text.replace(re, () => o.replace) : null;
}

/** Whether the backend would accept this text for the property (it rejects a whole batch otherwise). */
export function acceptable(p: Property, text: string): boolean {
  switch (p.type) {
    case "title":
      return [...text].length <= MAX_TITLE;
    case "text":
      return [...text].length <= MAX_TEXT;
    case "url":
      return [...text.trim()].length <= MAX_URL;
    case "email": {
      const t = text.trim();
      return t === "" || (t.includes("@") && !/\s/.test(t) && [...t].length <= MAX_TEXT);
    }
    case "phone": {
      const t = text.trim();
      return t === "" || ([...t].length <= 40 && /^[0-9 +\-().x#*,]+$/.test(t));
    }
    default:
      return false;
  }
}

export interface Change {
  recordId: string;
  propertyId: string;
  before: string;
  after: string;
  title: string;
}

export interface Plan {
  changes: Change[];
  records: number;
  /** Matches left alone because the new text would not be valid for the property. */
  skipped: number;
  /** More cells matched than one run changes; the rest need another run. */
  capped: boolean;
}

const textOf = (p: Property, row: RecordRow): string => (p.type === "title" ? row.title : typeof row.values[p.id] === "string" ? (row.values[p.id] as string) : "");

/** What a find and replace over these records would change, without changing anything. */
export function planReplace(rows: readonly RecordRow[], props: readonly Property[], o: FindOptions): Plan {
  const changes: Change[] = [];
  const touched = new Set<string>();
  let skipped = 0;
  let capped = false;
  if (!o.find) return { changes, records: 0, skipped, capped };
  outer: for (const row of rows) {
    for (const p of props) {
      if (!isReplaceable(p)) continue;
      const before = textOf(p, row);
      if (!before) continue;
      const after = replaceInText(before, o);
      if (after === null || after === before) continue;
      if (!acceptable(p, after)) {
        skipped++;
        continue;
      }
      if (changes.length >= CELL_LIMIT) {
        capped = true;
        break outer;
      }
      changes.push({ recordId: row.id, propertyId: p.id, before, after, title: row.title });
      touched.add(row.id);
    }
  }
  return { changes, records: touched.size, skipped, capped };
}

/** The values to write back: an emptied non-title cell is cleared. */
export function writes(plan: Plan, props: ReadonlyMap<string, Property>, direction: "apply" | "undo"): { recordId: string; propertyId: string; value: unknown }[] {
  return plan.changes.map((c) => {
    const text = direction === "apply" ? c.after : c.before;
    const isTitle = props.get(c.propertyId)?.type === "title";
    return { recordId: c.recordId, propertyId: c.propertyId, value: !isTitle && text === "" ? null : text };
  });
}

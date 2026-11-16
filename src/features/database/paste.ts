import type { Property } from "../../types";
import { optionsOf, TYPE_META } from "./model";
import { parseNaturalDate } from "./naturalDate";

// ---------------------------------------------------------------------------------------------
// text on the clipboard
// ---------------------------------------------------------------------------------------------

const needsQuotes = (s: string) => /[\t\r\n"]/.test(s);

/** Tab-separated text, quoting cells that hold tabs, line breaks or quotes (as spreadsheets do). */
export function toTsv(cells: string[][]): string {
  return cells.map((row) => row.map((c) => (needsQuotes(c) ? `"${c.replace(/"/g, '""')}"` : c)).join("\t")).join("\n");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function toHtmlTable(cells: string[][]): string {
  const body = cells.map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c).replace(/\n/g, "<br>")}</td>`).join("")}</tr>`).join("");
  return `<table><tbody>${body}</tbody></table>`;
}

/** Splits clipboard text into rows and cells. Handles quoted cells, CRLF and a trailing line break. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let atStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && atStart) {
      quoted = true;
      atStart = false;
      continue;
    }
    if (ch === "\t") {
      row.push(cell);
      cell = "";
      atStart = true;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      atStart = true;
      continue;
    }
    cell += ch;
    atStart = false;
  }
  if (cell !== "" || row.length > 0 || quoted) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// one cell of text -> a value for a property
// ---------------------------------------------------------------------------------------------

export type CellParse =
  /** `loose` is set when part of the text could not be used (an option that does not exist). */
  | { value: unknown; loose?: boolean }
  | { skip: "calculated" | "unmatched" | "invalid" };

export interface ParseContext {
  /** Finds the id of a related record by its title; undefined when there is none. */
  relation?: (prop: Property, title: string) => string | undefined;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x", "checked", "✓", "✔"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "unchecked", ""]);

/** A number from text; null when blank, NaN when it is not a number. */
export function parseNumberText(text: string): number | null {
  const t = text.trim().replace(/[\s ]/g, "");
  if (t === "") return null;
  let n: string = t;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) n = t.replace(/,/g, "");
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) n = t.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d+,\d+$/.test(t)) n = t.replace(",", ".");
  return Number(n);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const p2 = (n: number | string) => String(n).padStart(2, "0");

/** One date or date-time: ISO, the app's own display ("Oct 7, 2026 09:30") or a natural phrase. */
function parseOneDate(text: string): string | null {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(t);
  if (iso) return iso[4] ? `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}` : `${iso[1]}-${iso[2]}-${iso[3]}`;
  const shown = /^([A-Za-z]{3}) (\d{1,2}), (\d{4})(?: (\d{2}):(\d{2}))?$/.exec(t);
  const month = shown ? MONTHS.indexOf(shown[1].toLowerCase()) : -1;
  if (shown && month >= 0) {
    const day = `${shown[3]}-${p2(month + 1)}-${p2(shown[2])}`;
    return shown[4] ? `${day}T${shown[4]}:${shown[5]}` : day;
  }
  const natural = parseNaturalDate(t);
  return natural ? (natural.time ? `${natural.date}T${natural.time}` : natural.date) : null;
}

export function parseDateText(text: string): { start: string; end?: string } | null {
  const parts = text.split(/\s*(?:→|->)\s*/);
  const start = parseOneDate(parts[0]);
  if (!start) return null;
  if (parts.length === 1) return { start };
  const end = parseOneDate(parts[1]);
  return end ? { start, end } : { start };
}

const findOption = (prop: Property, name: string) => {
  const n = name.trim().toLowerCase();
  return optionsOf(prop).find((o) => o.name.toLowerCase() === n);
};

/** Turns pasted text into the value a property stores, or says why it cannot. */
export function parseCellText(prop: Property, text: string, ctx: ParseContext = {}): CellParse {
  if (!TYPE_META[prop.type].editable) return { skip: "calculated" };
  const t = text.trim();
  switch (prop.type) {
    case "title":
      return { value: text.replace(/\s*\n\s*/g, " ").trim() };
    case "text":
      return { value: t === "" ? null : text };
    case "url":
    case "email":
    case "phone":
      return { value: t === "" ? null : t };
    case "number": {
      const n = parseNumberText(text);
      return n === null ? { value: null } : Number.isFinite(n) ? { value: n } : { skip: "invalid" };
    }
    case "checkbox": {
      const w = t.toLowerCase();
      return TRUE_WORDS.has(w) ? { value: true } : FALSE_WORDS.has(w) ? { value: false } : { skip: "invalid" };
    }
    case "date": {
      if (t === "") return { value: null };
      const d = parseDateText(t);
      return d ? { value: d } : { skip: "invalid" };
    }
    case "select":
    case "status": {
      if (t === "") return { value: null };
      const o = findOption(prop, t);
      return o ? { value: o.id } : { skip: "unmatched" };
    }
    case "multi_select": {
      if (t === "") return { value: null };
      const names = [...new Set(t.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
      const ids = [...new Set(names.map((n) => findOption(prop, n)?.id).filter((id): id is string => !!id))];
      if (ids.length === 0) return { skip: "unmatched" };
      return { value: ids, loose: ids.length < names.length };
    }
    case "relation": {
      if (t === "") return { value: [] };
      const titles = t.split(",").map((s) => s.trim()).filter(Boolean);
      const ids = titles.map((title) => ctx.relation?.(prop, title)).filter((id): id is string => !!id);
      if (ids.length === 0) return { skip: "unmatched" };
      return { value: [...new Set(ids)], loose: ids.length < titles.length };
    }
    default:
      return { skip: "calculated" };
  }
}

// ---------------------------------------------------------------------------------------------
// laying pasted text over the table
// ---------------------------------------------------------------------------------------------

export interface PlannedCell {
  /** Row offset from the paste origin (counting data rows, not group headers). */
  r: number;
  /** Column index in the table. */
  c: number;
  value: unknown;
}

export interface PastePlan {
  cells: PlannedCell[];
  /** Cells left alone: calculated columns, unknown options, unreadable values. */
  skipped: number;
  /** Cells that were written but dropped part of their text. */
  partial: number;
  /** How many data rows the paste covers. */
  rows: number;
}

/**
 * Parses clipboard cells against the columns that start at `col`. One pasted cell fills the whole
 * `fill` block (like a spreadsheet); otherwise the text lands where it fell and columns past the
 * last one are dropped.
 */
export function planPaste(data: string[][], col: number, props: Property[], ctx: ParseContext = {}, fill?: { rows: number; cols: number }): PastePlan {
  const single = data.length === 1 && data[0].length === 1;
  const rows = single && fill ? fill.rows : data.length;
  const width = single && fill ? fill.cols : Math.max(0, ...data.map((r) => r.length));
  const plan: PastePlan = { cells: [], skipped: 0, partial: 0, rows };
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < width; k++) {
      const c = col + k;
      const prop = props[c];
      if (!prop) continue;
      const text = single ? data[0][0] : (data[r][k] ?? "");
      const parsed = parseCellText(prop, text, ctx);
      if ("skip" in parsed) {
        // Blank cells that cannot be parsed are not worth reporting; calculated ones are counted.
        if (text.trim() !== "" || parsed.skip === "calculated") plan.skipped++;
        continue;
      }
      if (parsed.loose) plan.partial++;
      plan.cells.push({ r, c, value: parsed.value });
    }
  }
  return plan;
}

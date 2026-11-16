import type { Property, ValidationRules } from "../../types";
import { isEmptyValue } from "./model";

export const rulesOf = (p: Property): ValidationRules | undefined => p.config?.validation;

/** Whether a property asks for unique values, which needs the whole table to check. */
export const needsUnique = (p: Property) => rulesOf(p)?.unique === true;

export const hasChecks = (p: Property) => {
  const r = rulesOf(p);
  return !!r && Object.keys(r).length > 0;
};

export function looksLikeEmail(s: string): boolean {
  const t = s.trim();
  const at = t.indexOf("@");
  if (at < 1 || /\s/.test(t)) return false;
  const domain = t.slice(at + 1);
  return !domain.includes("@") && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

export function looksLikeUrl(s: string): boolean {
  return /^https?:\/\/[^\s/]\S*$/i.test(s.trim());
}

interface Cell {
  title: string;
  values: Record<string, unknown>;
}

/**
 * Why a cell breaks its property's data checks, or null when it is fine. `duplicate` says another
 * record holds the same value (the table asks the backend, since it needs every record). Checks only
 * mark cells: nothing here ever blocks an edit, an import or a paste.
 */
export function checkCell(p: Property, row: Cell, duplicate = false): string | null {
  const rules = rulesOf(p);
  if (!rules) return null;
  const v = p.type === "title" ? row.title : row.values[p.id];
  const empty = p.type === "checkbox" ? v !== true : p.type === "title" ? row.title.trim() === "" : isEmptyValue(v);
  if (empty) return rules.required ? "This value is required" : null;
  if (typeof v === "number") {
    if (rules.min !== undefined && v < rules.min) return `Must be at least ${rules.min}`;
    if (rules.max !== undefined && v > rules.max) return `Must be at most ${rules.max}`;
  }
  if (typeof v === "string") {
    const n = [...v].length;
    if (rules.min !== undefined && n < rules.min) return `Must be at least ${rules.min} characters`;
    if (rules.max !== undefined && n > rules.max) return `Must be at most ${rules.max} characters`;
    if (rules.format === "email" && !looksLikeEmail(v)) return "Not a valid email address";
    if (rules.format === "url" && !looksLikeUrl(v)) return "Not a valid web address";
  }
  if (rules.unique && duplicate) return "Another record has the same value";
  return null;
}

/** A readable list of a property's checks, for the editor summary. */
export function describeRules(r: ValidationRules | undefined): string {
  if (!r) return "";
  const parts: string[] = [];
  if (r.required) parts.push("required");
  if (r.unique) parts.push("unique");
  if (r.format) parts.push(r.format === "email" ? "email address" : "web address");
  if (r.min !== undefined) parts.push(`min ${r.min}`);
  if (r.max !== undefined) parts.push(`max ${r.max}`);
  return parts.join(", ");
}

/** Cleans what the editor collected: drops blanks so an untouched rule is not stored. */
export function cleanRules(r: ValidationRules): ValidationRules | undefined {
  const out: ValidationRules = {};
  if (r.required) out.required = true;
  if (r.unique) out.unique = true;
  if (typeof r.min === "number" && Number.isFinite(r.min)) out.min = r.min;
  if (typeof r.max === "number" && Number.isFinite(r.max)) out.max = r.max;
  if (r.format) out.format = r.format;
  return Object.keys(out).length ? out : undefined;
}

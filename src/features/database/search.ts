import { createContext, useContext } from "react";
import type { FilterLeaf } from "../../types";

/** The text someone is searching for inside a view; cells highlight its matches. */
export const SearchTermContext = createContext("");
export const useSearchTerm = () => useContext(SearchTermContext);

/**
 * The backend's "any text property contains" condition (title, text, url, email, phone, and the names
 * of select, status and multi-select options). It is only ever added as an extra filter on top of the
 * view's own filter and sort, never saved in a view.
 */
export function searchFilter(term: string): FilterLeaf | null {
  const value = term.trim();
  return value ? { propertyId: "*", operator: "search", value } : null;
}

export interface Piece {
  text: string;
  hit: boolean;
}

/** Splits text around the case-insensitive matches of `term`, so the matches can be marked. */
export function splitMatches(text: string, term: string): Piece[] {
  const needle = term.trim().toLowerCase();
  if (!needle || !text) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  // Lowercasing can change a string's length (some characters expand); then offsets would drift.
  if (lower.length !== text.length) return [{ text, hit: false }];
  const out: Piece[] = [];
  let at = 0;
  for (;;) {
    const i = lower.indexOf(needle, at);
    if (i < 0) break;
    if (i > at) out.push({ text: text.slice(at, i), hit: false });
    out.push({ text: text.slice(i, i + needle.length), hit: true });
    at = i + needle.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out.length ? out : [{ text, hit: false }];
}

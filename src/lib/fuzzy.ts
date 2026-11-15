/**
 * Fuzzy matching for the command palette. A word matches a text when it appears inside it (best), or when
 * its letters appear in order within a short stretch (so "swdk" finds "Switch to dark theme"). Higher is better.
 */
export function fuzzyScore(word: string, text: string): number | null {
  const w = word.toLowerCase();
  const t = text.toLowerCase();
  if (!w) return 0;
  const at = t.indexOf(w);
  if (at >= 0) {
    const boundary = at === 0 || /[^a-z0-9]/.test(t[at - 1]);
    return 100 + (boundary ? 40 : 0) + (at === 0 ? 20 : 0) - Math.min(at, 30) * 0.3;
  }
  if (w.length < 3) return null;
  // Letters in order, preferring word starts; the whole match must fit in a short window.
  let from = 0;
  let first = -1;
  let last = -1;
  let starts = 0;
  for (const ch of w) {
    const next = t.indexOf(ch, from);
    if (next < 0) return null;
    if (first < 0) first = next;
    if (next === 0 || /[^a-z0-9]/.test(t[next - 1])) starts++;
    last = next;
    from = next + 1;
  }
  const span = last - first + 1;
  if (span > w.length * 2 + 2) return null;
  return 40 + starts * 6 - (span - w.length) * 2;
}

/** Every whitespace-separated word must match somewhere; the title counts for more than the keywords. */
export function fuzzyMatch(query: string, title: string, keywords = ""): number | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let total = 0;
  for (const word of words) {
    const inTitle = fuzzyScore(word, title);
    const inKeys = fuzzyScore(word, keywords);
    const best = Math.max(inTitle !== null ? inTitle * 1.5 : -Infinity, inKeys ?? -Infinity);
    if (best === -Infinity) return null;
    total += best;
  }
  return total;
}

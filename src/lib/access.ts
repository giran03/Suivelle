/** Set when the desktop app opened a damaged or newer workspace read-only (see lib/safeMode). */
export const SAFE_MODE = !!globalThis.__SUIVELLE_SAFE_MODE__;

/** The desktop app stays editable; the showcase build opts into read-only access, and safe mode forces it. */
export const READ_ONLY = import.meta.env.VITE_SHOWCASE_READ_ONLY === "true" || SAFE_MODE;

export const READ_ONLY_COMMANDS = new Set([
  "find", "settings", "shortcuts", "sidebar", "focus", "history", "trash",
  "back", "forward", "copy-link", "theme-light", "theme-dark", "theme-system",
  "theme-preset-paper", "theme-preset-mist", "theme-preset-sand", "theme-preset-sage", "theme-preset-lavender",
  "theme-preset-midnight", "theme-preset-graphite", "theme-preset-forest", "theme-preset-plum", "theme-preset-ember",
  "outline", "reopen-tab", "split-single", "split-columns", "split-rows", "split-quad", "split-master-detail", "split-tiled", "graph", "tags", "reminders", "agents-inbox", "agents-activity", "vault-health",
  // Safe mode exists so the data can still be saved elsewhere or replaced from a backup.
  ...(SAFE_MODE ? ["backups", "export", "export-pdf", "export-workspace", "updates"] : []),
]);

export function readingAction(label: string): boolean {
  return /^(Open\b|Copy\b|Select all\b|Deselect\b|Expand\b|Collapse\b|Go to\b|Close\b|Sort\b|Clear sort\b|Hide\b|Show\b|Refresh\b|Reload\b)/i.test(label);
}

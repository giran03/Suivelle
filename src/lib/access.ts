/** The desktop app stays editable; the showcase build explicitly opts into read-only access. */
export const READ_ONLY = import.meta.env.VITE_SHOWCASE_READ_ONLY === "true";

export const READ_ONLY_COMMANDS = new Set([
  "find", "settings", "shortcuts", "sidebar", "focus", "history", "trash",
  "back", "forward", "copy-link", "theme-light", "theme-dark", "theme-system",
]);

export function readingAction(label: string): boolean {
  return /^(Open\b|Copy\b|Select all\b|Deselect\b|Expand\b|Collapse\b|Go to\b|Close\b|Sort\b|Clear sort\b|Hide\b|Show\b|Refresh\b|Reload\b)/i.test(label);
}

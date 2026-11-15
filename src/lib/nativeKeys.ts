/**
 * Suivelle is an app, not a web page: the webview's own browser shortcuts (print, save page, view source,
 * reload, caret browsing, downloads and so on) must never fire. The Windows shell also turns them off at
 * the source (src-tauri/src/lib.rs); this is the same list for the dev server and for any other webview.
 *
 * It runs after the app's own shortcut handling, in the bubble phase, and only cancels the browser's default,
 * so a key Suivelle uses itself still works.
 */
const CTRL_LETTERS = new Set(["p", "s", "u", "o", "j", "g", "r", "l", "e", "k"]);
const CTRL_SHIFT_LETTERS = new Set(["p", "s", "r", "j", "o", "g"]);
const FUNCTION_KEYS = new Set(["F3", "F5", "F7"]);

export function isNativeBrowserKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (FUNCTION_KEYS.has(key)) return true;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  return (event.shiftKey ? CTRL_SHIFT_LETTERS : CTRL_LETTERS).has(key);
}

/** Cancels the browser default for those keys everywhere except inside a text field's own editing keys. */
export function installNativeKeyBlock(): () => void {
  const onKey = (event: KeyboardEvent) => { if (isNativeBrowserKey(event)) event.preventDefault(); };
  window.addEventListener("keydown", onKey);
  // Printing is also reachable from script and from the browser's own menu: make both do nothing.
  const noPrint = (event: Event) => event.preventDefault();
  window.addEventListener("beforeprint", noPrint);
  return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("beforeprint", noPrint); };
}

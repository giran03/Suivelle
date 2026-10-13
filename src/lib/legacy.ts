/** Read compatibility only. New keys and links always use the Suivelle namespace. */
export const LEGACY_NAME = "takoception";
export const LEGACY_PAGE_LINK = `${LEGACY_NAME}://page/`;

export function migrateStorage() {
  try {
    const prefix = `${LEGACY_NAME}.`;
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(prefix)) continue;
      const next = `suivelle.${key.slice(prefix.length)}`;
      if (localStorage.getItem(next) === null) {
        const value = localStorage.getItem(key);
        if (value !== null) localStorage.setItem(next, value);
      }
      localStorage.removeItem(key);
    }
  } catch { /* Storage is optional; retry on the next load if unavailable/full. */ }
}
migrateStorage();

export function pageLinkTarget(href: string) {
  for (const prefix of ["suivelle://page/", LEGACY_PAGE_LINK]) {
    if (href.startsWith(prefix)) return href.slice(prefix.length);
  }
  return null;
}

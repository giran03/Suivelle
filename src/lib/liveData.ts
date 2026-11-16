// Tells every open view of a database that records or the schema changed somewhere, so charts, pivots, totals,
// boards and other panes showing the same data stay current without a manual refresh. Changes are coalesced.

import { useSyncExternalStore } from "react";

let version = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Call after anything that may have changed database records or schema. */
export function notifyDataChanged(): void {
  if (timer !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    version++;
    listeners.forEach((l) => l());
  }, 150);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** A number that increases whenever database data changed. Add it to the inputs of anything derived from records. */
export function useLiveData(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** The commands that change records or database structure. */
/** The commands that change records or database structure. Exact names: read-only ones such as record_duplicates
 *  (a check) or database_get must never match, or reading would trigger refreshing, which reads again. */
export const MUTATES_DATABASE = new RegExp(
  "^(?:" + [
    "record_create", "record_duplicate", "record_set_value", "record_set_cells", "record_bulk_set",
    "property_create", "property_update", "property_delete", "property_duplicate",
    "database_create", "view_update", "view_create", "view_duplicate", "view_delete",
    "form_submit", "button_press", "automation_run_now", "import_apply", "workspace_import",
    "changeset_revert", "proposal_approve", "page_delete", "page_restore", "page_delete_permanent",
    "page_apply_template", "trash_empty", "history_restore", "backup_restore",
  ].join("|") + ")$",
);

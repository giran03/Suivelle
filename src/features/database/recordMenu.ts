import type { MenuItem } from "../../components/ContextMenu";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { RecordRow } from "../../types";
import { copyPageLink } from "../pages/pageMenu";

export function recordItems(row: RecordRow, reload: () => void): MenuItem[] {
  const store = useWorkspace.getState();
  return [
    { label: "Open", onSelect: () => void store.openPage(row.pageId) },
    { label: "Copy link", shortcut: "copy-link", onSelect: () => void copyPageLink(row.pageId) },
    { label: "Duplicate", shortcut: "duplicate", onSelect: async () => { try { await ipc.recordDuplicate(row.id); reload(); store.notify("Record duplicated."); } catch (error) { store.setError(toAppError(error).message); } } },
    { label: "Move to trash", danger: true, separated: true, onSelect: async () => {
      try { await ipc.pageDelete(row.pageId); reload(); store.notify(`Moved “${row.title || "Untitled"}” to trash`, async () => { await ipc.pageRestore(row.pageId); reload(); }); }
      catch (error) { store.setError(toAppError(error).message); }
    } },
  ];
}

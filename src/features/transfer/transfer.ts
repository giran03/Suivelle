export const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** What an import contains, in a sentence: "3 pages, 1 database with 6 records and 2 attachments". */
export function summarize(c: { pages: number; databases: number; records: number; attachments: number }): string {
  const parts: string[] = [];
  if (c.pages) parts.push(plural(c.pages, "page", "pages"));
  if (c.databases) parts.push(`${plural(c.databases, "database", "databases")} with ${plural(c.records, "record", "records")}`);
  if (c.attachments) parts.push(plural(c.attachments, "attachment", "attachments"));
  if (parts.length === 0) return "nothing";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The types an imported CSV column can become. */
export const COLUMN_KINDS: { value: string; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "select", label: "Select" },
  { value: "multi_select", label: "Multi-select (comma separated)" },
  { value: "date", label: "Date" },
  { value: "checkbox", label: "Checkbox" },
  { value: "url", label: "URL" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "skip", label: "Leave out" },
];
import { ipc } from "../../lib/ipc";
import { flushAllEditors } from "../editor/flushRegistry";

/** Every entry point saves pending edits before choosing an archive destination. */
export async function exportWorkspaceArchive(workspaceId: string) {
  await flushAllEditors(true);
  return ipc.exportWorkspace(workspaceId);
}

export function importedWorkspaceName(name: string, existing: string[]): string {
  const names = new Set(existing.map((n) => n.toLocaleLowerCase()));
  const original = name.trim() || "Imported workspace";
  const base = [...original].slice(0, 175).join("");
  let suggestion = [...original].slice(0, 200).join("");
  let copy = 1;
  while (names.has(suggestion.toLocaleLowerCase())) {
    suggestion = `${base} (imported${copy === 1 ? "" : ` ${copy}`})`;
    copy++;
  }
  return suggestion;
}


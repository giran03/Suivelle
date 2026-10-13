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

/** The types a column can become: the usual ones, plus what it already is when that is special
 * (a relation keeps its links, a status keeps its groups). */
export function columnKinds(original: string): { value: string; label: string }[] {
  const extra = original === "relation" ? [{ value: "relation", label: "Relation" }]
    : original === "status" ? [{ value: "status", label: "Status" }]
    : [];
  return [...extra, ...COLUMN_KINDS];
}

/** Where an import goes when the user has not chosen: a whole workspace gets its own. */
export function defaultTarget(origin: ImportOrigin | null | undefined): ImportTarget["kind"] {
  return origin?.workspace ? "workspace" : "container";
}

/** "Markdown & CSV, subpages in folders". */
export function describeOrigin(origin: ImportOrigin): string {
  const format = { markdown: "Markdown & CSV", html: "HTML", pdf: "PDF", mixed: "Mixed formats" }[origin.format];
  if (origin.format === "pdf") return format;
  return `${format}, ${origin.layout === "flat" ? "subpages nested by their links" : "subpages in folders"}`;
}

export const EXPORT_FORMATS: { value: ExportOptions["format"]; label: string }[] = [
  { value: "markdown", label: "Markdown & CSV" },
  { value: "html", label: "HTML" },
  { value: "pdf", label: "PDF" },
];

export const DEFAULT_EXPORT: ExportOptions = { format: "markdown", includeSubpages: true, folders: true, files: true, rows: "all" };

/** The options as they apply: a PDF is one page, a database is never a PDF, and folders only
 * matter when there are subpages. */
export function effectiveOptions(o: ExportOptions, kind: ExportShape["kind"] | undefined): ExportOptions {
  const format = kind === "database" && o.format === "pdf" ? "markdown" : o.format;
  const includeSubpages = format !== "pdf" && o.includeSubpages;
  return { ...o, format, includeSubpages, folders: includeSubpages && o.folders };
}

/** What pressing Export will save, in a sentence. */
export function savesText(shape: ExportShape, o: ExportOptions): string {
  if (o.format === "pdf") return "Saves the page as one PDF file.";
  if (shape.needsFolder) return `Saves a zip of ${plural(shape.files, "file", "files")}${o.files ? " and the files they show" : ""}.`;
  if (shape.kind === "database") return o.format === "html" ? "Saves the table as one HTML file." : "Saves the table as one CSV file.";
  return o.format === "html" ? "Saves the page as one HTML file." : "Saves the page as one Markdown file.";
}

export type { ColumnPlan };
import { ipc } from "../../lib/ipc";
import { flushAllEditors } from "../editor/flushRegistry";
import type { ColumnPlan, ExportOptions, ExportShape, ImportOrigin, ImportTarget } from "../../types";

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


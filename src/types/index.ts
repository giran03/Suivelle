export interface AppError {
  code: "validation" | "not_found" | "database" | "io" | "internal" | "invalid_argument";
  message: string;
}

export interface Workspace {
  id: string;
  name: string;
  icon: string | null;
  settingsJson: string;
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceColor = "violet" | "gray" | "red" | "orange" | "green" | "blue" | `#${string}`;
export interface WorkspaceStats { pages: number; records: number; databases: number; dashboards: number; trashed: number; }

export type PageKind = "page" | "database" | "record" | "dashboard";

export interface Page {
  id: string;
  workspaceId: string;
  parentPageId: string | null;
  title: string;
  icon: string | null;
  cover: string | null;
  position: number;
  favorite: boolean;
  archived: boolean;
  deletedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Live direct children, so the tree can show a chevron without loading them. */
  childCount: number;
  /** A normal page, a database (its body is a table) or a record (one row of a database). */
  kind: PageKind;
}

export type BlockType =
  | "paragraph"
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "bullet_list"
  | "numbered_list"
  | "todo"
  | "tabs"
  | "tab_panel"
  | "toggle"
  | "quote"
  | "callout"
  | "divider"
  | "code"
  | "equation"
  | "simple_table"
  | "columns"
  | "column"
  | "database_view"
  | "calendar"
  | "calendar_event"
  | "table_of_contents"
  | "synced_block"
  | "image"
  | "audio"
  | "video"
  | "file"
  | "pdf"
  | "embed";

export type AttachmentKind = "image" | "audio" | "video" | "file" | "pdf";

export interface Attachment {
  id: string;
  workspaceId: string;
  hash: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface Block {
  id: string;
  pageId: string;
  parentBlockId: string | null;
  type: BlockType;
  position: number;
  dataJson: string;
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ThemeSetting = "light" | "dark" | "system";

export interface Settings {
  theme: ThemeSetting;
  /** The daily automatic backup; on unless turned off. */
  autoBackup: boolean;
  backupKeep: number;
}

export interface SearchHit {
  kind: "page" | "block";
  pageId: string;
  blockId: string | null;
  pageTitle: string;
  parentTitle: string | null;
  /** Matched terms are wrapped in U+E000 ... U+E001. */
  snippet: string;
  updatedAt: string;
}

export interface Backlink {
  sourcePageId: string;
  sourcePageTitle: string;
  parentTitle: string | null;
  sourceBlockId: string;
  snippet: string;
  contextKind: "paragraph" | "table_row";
  rowIndex: number | null;
  header: string[];
  cells: string[];
}

export interface CanvasItem {
  id: string;
  kind: "record" | "page" | "note" | "image";
  recordId: string | null;
  /** The page a `page` card shows (workspace boards only). */
  pageId?: string | null;
  text: string;
  attachmentHash: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  color: string | null;
}

export interface CanvasEdge {
  id: string;
  fromItem: string;
  toItem: string;
  label: string;
}

export interface CanvasBoard {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasData {
  items: CanvasItem[];
  edges: CanvasEdge[];
}

export type CanvasOp =
  | { op: "upsert_item"; item: CanvasItem }
  | { op: "delete_item"; id: string }
  | { op: "upsert_edge"; edge: CanvasEdge }
  | { op: "delete_edge"; id: string };

export interface PreviewLine {
  kind: string;
  text: string;
}

export interface PagePreview {
  id: string;
  title: string;
  icon: string | null;
  deleted: boolean;
  lines: PreviewLine[];
  imageHash: string | null;
}

export interface PageTitle {
  id: string;
  title: string;
  icon: string | null;
  deleted: boolean;
}

// ---- databases ----

export type PropertyType =
  | "title"
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "created_time"
  | "updated_time"
  | "unique_id"
  | "relation"
  | "rollup"
  | "formula"
  | "button";

export type RollupFunction = "count" | "count_unique" | "sum" | "average" | "min" | "max" | "earliest" | "latest" | "percent_checked" | "percent_done";

/** One linked record in a relation cell. */
export interface RecordLink {
  id: string;
  pageId: string;
  title: string;
}

export interface FormulaPreview {
  resultType: string | null;
  error: { message: string; position: number } | null;
  samples: { title: string; value: unknown }[];
  /** Names of the properties the formula may refer to. */
  properties: string[];
}

export interface RecordRange {
  propertyId: string;
  from?: string | null;
  to?: string | null;
}

export interface RecordPreview {
  recordId: string;
  imageHash: string | null;
  imageName: string | null;
  text: string | null;
}

export interface RevisionMeta {
  id: string;
  pageId: string;
  seq: number;
  kind: "auto" | "manual" | "restore";
  title: string;
  blockCount: number;
  createdAt: string;
}

export interface PreviewBlock {
  id: string;
  type: string;
  text: string;
  depth: number;
  change: "same" | "changed" | "added" | "removed";
}

export interface RevisionDetail {
  meta: RevisionMeta;
  currentTitle: string;
  blocks: PreviewBlock[];
  removed: PreviewBlock[];
}

export interface BackupManifest {
  format: number;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  kind: "auto" | "manual" | "export" | "safety" | "pre-update";
  workspaceName: string;
  pages: number;
  attachments: number;
  attachmentBytes: number;
}

export interface BackupInfo {
  /** The file name in the app's backup folder; empty for a file chosen elsewhere. */
  name: string;
  manifest: BackupManifest;
  size: number;
}

export interface RestorePreview {
  backup: BackupInfo;
  currentPages: number;
  currentAttachments: number;
  tooNew: boolean;
}

export interface TemplateInfo {
  id: string;
  name: string;
  blurb: string;
  databases: string[];
}

export interface TemplateResult {
  pageId: string;
  databasePageIds: string[];
}

export interface DatabaseRef {
  id: string;
  pageId: string;
  title: string;
}

export type Tone = "gray" | "violet" | "red" | "orange" | "green" | "blue";

export interface SelectOption {
  id: string;
  name: string;
  color: Tone;
  /** Status options only. */
  group?: "todo" | "doing" | "done";
}

export interface Property {
  id: string;
  databaseId: string;
  name: string;
  type: PropertyType;
  config: {
    options?: SelectOption[];
    prefix?: string;
    /** Relation: the related database, and the property on its side (null when one-way). */
    targetDatabaseId?: string;
    reverseId?: string | null;
    /** Rollup. */
    relationPropertyId?: string;
    targetPropertyId?: string;
    function?: RollupFunction;
    /** Formula. `resultType` is inferred by the backend. */
    expression?: string;
    resultType?: "number" | "text" | "bool" | "date" | "list" | "any";
    /** Button. */
    label?: string;
  };
  position: number;
}

export interface ViewColumn {
  propertyId: string;
  width?: number | null;
  hidden?: boolean;
}

export interface ViewSort {
  propertyId: string;
  direction: "asc" | "desc";
}

export interface FilterLeaf {
  propertyId: string;
  operator: string;
  value?: unknown;
}

export interface FilterGroup {
  op: "and" | "or";
  children: FilterNode[];
}

export type FilterNode = FilterGroup | FilterLeaf;

export type ViewType = "table" | "board" | "list" | "gallery" | "calendar" | "timeline" | "chart" | "form" | "feed" | "canvas";

export type ChartType = "bar" | "line" | "area" | "pie" | "donut" | "kpi";
export type Aggregation = "count" | "sum" | "average" | "min" | "max";

export interface ChartSpec {
  chartType: ChartType;
  xPropertyId?: string | null;
  bucket?: DateBucket | null;
  yPropertyId?: string | null;
  aggregation: Aggregation;
  groupPropertyId?: string | null;
  sort: "x" | "value_desc" | "value_asc";
}

export interface ChartPoint {
  x: string | null;
  group: string | null;
  value: number | null;
  count: number;
}

export interface ChartData {
  points: ChartPoint[];
  truncated: boolean;
  records: number;
}

export interface FormField {
  propertyId: string;
  label?: string | null;
  help?: string | null;
  required: boolean;
}

export interface FormSpec {
  fields: FormField[];
  intro?: string | null;
  submitLabel?: string | null;
  successMessage?: string | null;
}

export interface RecordTemplate {
  id: string;
  databaseId: string;
  name: string;
  title: string;
  values: Record<string, unknown>;
  blockCount: number;
  isDefault: boolean;
}

export type Trigger =
  | { type: "record_created" }
  | { type: "record_updated" }
  | { type: "property_changed"; propertyId: string; to?: unknown }
  | { type: "date_reached"; propertyId: string; offsetDays: number; time: string }
  | { type: "schedule"; every: "minutes" | "hours" | "daily" | "weekly"; interval: number; time: string; days: number[] }
  | { type: "app_started" }
  | { type: "button"; propertyId: string };

export type Action =
  | { type: "update_properties"; values: Record<string, unknown> }
  | { type: "set_status"; propertyId: string; optionId: string }
  | { type: "create_record"; title?: string | null; values: Record<string, unknown>; templateId?: string | null }
  | { type: "duplicate_record" }
  | { type: "archive_record" }
  | { type: "trash_record" }
  | { type: "notify"; title: string; body?: string | null };

export interface Automation {
  id: string;
  databaseId: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  conditions: FilterNode | null;
  actions: Action[];
  lastRunAt: string | null;
  lastStatus: "ok" | "failed" | "skipped" | null;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  automationName: string;
  executionId: string;
  depth: number;
  status: "ok" | "failed" | "skipped";
  message: string;
  recordTitle: string | null;
  startedAt: string;
}

export interface RunSummary {
  automationId: string;
  automationName: string;
  status: "ok" | "failed" | "skipped";
  message: string;
}

export interface ColumnPlan {
  name: string;
  /** "title" for the first column, otherwise a property type or "skip". */
  kind: string;
  samples: string[];
  distinct: number;
  /** What the column was in the source when that changes something ("Relation to Tasks"). */
  note?: string;
}

export interface ImportEntry {
  index: number;
  name: string;
  kind: "page" | "database" | "folder";
  depth: number;
  detail: string;
  columns: ColumnPlan[] | null;
  truncated: boolean;
}

export interface ArchiveCounts {
  pages: number;
  databases: number;
  records: number;
  dashboards: number;
  attachments: number;
  automations?: number;
}

export interface WorkspaceExported extends ArchiveCounts { fileName: string; }
export interface WorkspaceImported { workspace: Workspace; counts: ArchiveCounts & { warnings: string[] }; }

export interface ImportPreview {
  id: string;
  entries: ImportEntry[];
  pages: number;
  databases: number;
  records: number;
  attachments: number;
  bytes: number;
  warnings: string[];
  archive: { appVersion: string; createdAt: string; workspaceName: string; workspaceIcon?: string | null; settings?: Record<string, unknown>; counts: ArchiveCounts } | null;
  /** Set when the files were recognized as an export from another app. */
  origin: ImportOrigin | null;
}

export interface ImportOrigin {
  kind: "notion";
  format: "markdown" | "html" | "pdf" | "mixed";
  /** Subpages were in folders, or (without folders) nested by their links. */
  layout: "folders" | "flat";
  /** The export holds a whole workspace rather than one page and its subpages. */
  workspace: boolean;
  /** A name for a workspace made from it. */
  name: string;
}

/** Where imported pages go. */
export type ImportTarget = { kind: "container" } | { kind: "page"; pageId: string } | { kind: "workspace"; name: string };

export interface ImportResult {
  pageId: string;
  pages: number;
  databases: number;
  records: number;
  attachments: number;
  warnings: string[];
  /** The workspace the import created, when it made one. */
  workspace: Workspace | null;
}

export interface ExportWritten {
  files: number;
  attachments: number;
  skipped: string[];
  fileName?: string;
}

export type ExportFormat = "markdown" | "html" | "pdf";

/** The choices of the export form, as in Notion's export dialog. */
export interface ExportOptions {
  format: ExportFormat;
  includeSubpages: boolean;
  folders: boolean;
  /** Files and images are included. */
  files: boolean;
  rows: "all" | "view";
}

export interface ExportShape {
  kind: "page" | "record" | "database";
  title: string;
  /** More than one file, so it is saved as a zip. */
  needsFolder: boolean;
  hasChildren: boolean;
  hasDatabases: boolean;
  files: number;
}

export type WidgetType = "text" | "chart" | "linked_view";

export interface Widget {
  id: string;
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string | null;
  text?: string | null;
  databaseId?: string | null;
  viewId?: string | null;
  chart?: ChartSpec | null;
  filter?: FilterNode | null;
}

export type SharedFilterType = "option" | "text" | "checkbox" | "date_days";

export interface SharedFilter {
  id: string;
  propertyName: string;
  type: SharedFilterType;
  value: unknown;
}

export interface DashboardLayout {
  widgets: Widget[];
  filters: SharedFilter[];
}

export interface DashboardDetail {
  page: Page;
  layout: DashboardLayout;
}

export type DateBucket = "day" | "week" | "month" | "year";

export interface GroupSpec {
  propertyId: string;
  bucket?: DateBucket | null;
}

export interface ViewConfig {
  columns: ViewColumn[];
  sorts: ViewSort[];
  filter: FilterNode | null;
  group?: GroupSpec | null;
  subgroup?: GroupSpec | null;
  hideEmptyGroups?: boolean;
  /** Calendar and timeline: the date property that places a record. */
  datePropertyId?: string | null;
  cardSize?: "small" | "medium" | "large" | null;
  zoom?: "week" | "month" | "quarter" | null;
  chart?: ChartSpec | null;
  form?: FormSpec | null;
  feedOrder?: "created" | "updated" | null;
}

export interface DbView {
  id: string;
  databaseId: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
}

export interface GroupCount {
  /** Option id, "true"/"false", a date bucket such as "2026-10", or "__empty" for no value. */
  key: string;
  count: number;
  subgroups: GroupCount[];
}

export interface DatabaseInfo {
  id: string;
  pageId: string;
  workspaceId: string;
  nextUniqueId: number;
}

export interface DatabaseDetail {
  database: DatabaseInfo;
  page: Page;
  properties: Property[];
  views: DbView[];
}

export interface RecordRow {
  id: string;
  pageId: string;
  databaseId: string;
  title: string;
  uniqueId: number;
  createdAt: string;
  updatedAt: string;
  values: Record<string, unknown>;
}

export interface RecordPage {
  rows: RecordRow[];
  /** Null when the caller asked to skip counting. */
  total: number | null;
  nextCursor: string | null;
}

export interface RecordDetail {
  record: RecordRow;
  database: DatabaseDetail;
}

/** A page that shows a stored file in its content, cover or icon. */
export interface AttachmentUse {
  pageId: string;
  title: string;
  trashed: boolean;
  cover: boolean;
  icon?: boolean;
  workspace?: boolean;
}

/** A stored file with where it is used (the file manager). */
export interface AttachmentInfo {
  id: string;
  hash: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uses: AttachmentUse[];
  /** Only meaningful for unused files: an old saved version of a page still shows it. */
  inHistory: boolean;
}

export interface DeletedFiles {
  deleted: number;
  skipped: number;
  freedBytes: number;
}

/** Files nothing uses: unrecorded blobs, their thumbnails and abandoned temporary files. */
export interface Sweep { files: number; bytes: number }

/** Sizes and counts for the whole installation, from Settings › Data. */
export interface Health {
  databaseBytes: number;
  walBytes: number;
  reclaimableBytes: number;
  workspaces: number;
  pages: number;
  trashedPages: number;
  blocks: number;
  records: number;
  attachments: number;
  attachmentBytes: number;
  thumbnailBytes: number;
  searchDocuments: number;
  backups: number;
  backupBytes: number;
  lastBackup: string | null;
  leftovers: Sweep;
}

/** A reminder about a page, fired once at a local time ("2026-10-13T09:00:00"). */
export interface Reminder { id: string; pageId: string; pageTitle: string; remindAt: string; note: string; firedAt: string | null }

export interface TagCount { tag: string; pages: number }

/** Pages and the links between them: [from page id, to page id]. */
export interface LinkGraph { nodes: PageTitle[]; edges: [string, string][] }

import type { GlobalConfig, GlobalState } from "../features/shortcuts/native";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppError,
  Attachment,
  Health,
  Sweep,
  Reminder,
  TagCount,
  LinkGraph,
  AttachmentKind,
  Action,
  Automation,
  AutomationRun,
  Backlink,
  ExportWritten,
  ImportPreview,
  ImportResult,
  RunSummary,
  Trigger,
  ChartData,
  ChartSpec,
  DashboardDetail,
  DashboardLayout,
  FilterNode,
  RecordTemplate,
  Block,
  BlockType,
  DatabaseDetail,
  BackupInfo,
  DatabaseRef,
  RestorePreview,
  RevisionDetail,
  RevisionMeta,
  TemplateInfo,
  TemplateResult,
  FormulaPreview,
  DbView,
  GroupCount,
  Page,
  PageTitle,
  Property,
  PropertyType,
  RecordDetail,
  RecordLink,
  RecordPage,
  RecordPreview,
  RecordRange,
  RecordRow,
  SearchHit,
  ViewConfig,
  ViewType,
  Workspace,
} from "../types";

/** Normalises anything the backend rejects with into a typed AppError. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    return e as AppError;
  }
  return { code: "invalid_argument", message: typeof e === "string" ? e : String(e) };
}

const pendingIpc = new Set<Promise<unknown>>();
export async function waitForPendingIpc(): Promise<void> {
  while (pendingIpc.size) await Promise.all([...pendingIpc]);
}
/** Sends `bytes` as the raw request body (not JSON); text parameters travel as encoded headers. */
function rawCall<T>(cmd: string, bytes: ArrayBuffer, headers: Record<string, string>): Promise<T> {
  const encoded = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, encodeURIComponent(v)]));
  return track(invoke<T>(cmd, bytes, { headers: encoded }));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return track(invoke<T>(cmd, args));
}

async function track<T>(pending: Promise<T>): Promise<T> {
  pendingIpc.add(pending);
  try {
    return await pending;
  } catch (e) {
    throw toAppError(e);
  } finally {
    pendingIpc.delete(pending);
  }
}

export const ipc = {
  exportPagePreview: (pageId: string, format: "markdown" | "html") => call<{source:string;html:string;notices:string[];assets:Record<string,{hash:string;crop?:import("../features/editor/imageModel").Crop}>}>("export_page_preview", { pageId, format }),
  imageInfo: (id: string) => call<{width:number;height:number;animated:boolean}>("image_info", { id }),
  imageSaveCrop: (id: string, crop: import("../features/editor/imageModel").Crop) => call<boolean>("image_save_crop", { id, crop }),
  imageCopy: (id: string, crop?: import("../features/editor/imageModel").Crop, stillFrame = false) => call<void>("image_copy", { id, crop: crop ?? null, stillFrame }),
  imageOpenLink: (url: string) => call<void>("image_open_link", { url }),
  // queries
  workspaceList: () => call<import("../types").Workspace[]>("workspace_list"),
  workspaceStats: (id: string) => call<import("../types").WorkspaceStats>("workspace_stats", { id }),
  workspaceDelete: (id: string, confirmationName: string) => call<string>("workspace_delete", { id, confirmationName }),
  backupSetAuto: (enabled?: boolean, keep?: number) => call<Workspace[]>("backup_set_auto", { enabled, keep }),
  workspaceGet: (id?: string) => call<Workspace | null>("workspace_get", { id }),
  pageGet: (id: string) => call<Page>("page_get", { id }),
  pageListChildren: (workspaceId: string, parentPageId: string | null) =>
    call<Page[]>("page_list_children", { workspaceId, parentPageId }),
  pageAncestors: (id: string) => call<Page[]>("page_ancestors", { id }),
  pageListFavorites: (workspaceId: string) => call<Page[]>("page_list_favorites", { workspaceId }),
  pageListTrash: (workspaceId: string) => call<Page[]>("page_list_trash", { workspaceId }),
  blockList: (pageId: string) => call<Block[]>("block_list", { pageId }),
  searchWorkspace: (input: {
    workspaceId: string;
    query: string;
    titlesOnly?: boolean;
    modifiedWithinDays?: number | null;
    limit?: number;
    offset?: number;
  }) => call<SearchHit[]>("search_workspace", { input }),
  pageListRecent: (workspaceId: string, limit = 8) => call<Page[]>("page_list_recent", { workspaceId, limit }),
  pageBacklinks: (pageId: string) => call<Backlink[]>("page_backlinks", { pageId }),
  pageTitles: (ids: string[]) => call<PageTitle[]>("page_titles", { ids }),

  databaseGet: (pageId: string) => call<DatabaseDetail>("database_get", { pageId }),
  recordGet: (pageId: string) => call<RecordDetail>("record_get", { pageId }),
  queryRecords: (input: {
    databaseId: string;
    viewId?: string | null;
    groupKey?: string | null;
    subgroupKey?: string | null;
    cursor?: string | null;
    limit?: number;
    skipTotal?: boolean;
    range?: RecordRange | null;
    extraFilter?: FilterNode | null;
  }) => call<RecordPage>("query_records", { input }),
  groupCounts: (databaseId: string, viewId: string, extraFilter?: FilterNode | null) =>
    call<GroupCount[]>("group_counts", { input: { databaseId, viewId, extraFilter } }),
  chartData: (input: { databaseId: string; viewId?: string | null; chart?: ChartSpec | null; filter?: FilterNode | null }) =>
    call<ChartData>("chart_data", { input }),
  automationList: (databaseId: string) => call<Automation[]>("automation_list", { databaseId }),
  automationRuns: (databaseId: string) => call<AutomationRun[]>("automation_runs", { databaseId }),
  recordTemplateList: (databaseId: string) => call<RecordTemplate[]>("record_template_list", { databaseId }),
  dashboardGet: (pageId: string) => call<DashboardDetail>("dashboard_get", { pageId }),

  // commands
  databaseCreate: (workspaceId: string, parentPageId: string | null, title?: string) =>
    call<DatabaseDetail>("database_create", { input: { workspaceId, parentPageId, title } }),
  propertyCreate: (input: { databaseId: string; name: string; type: PropertyType; config?: unknown }) =>
    call<Property>("property_create", { input }),
  propertyUpdate: (input: { id: string; name?: string; config?: unknown; position?: number }) =>
    call<Property>("property_update", { input }),
  formulaPreview: (databaseId: string, expression: string, propertyId?: string) =>
    call<FormulaPreview>("formula_preview", { input: { databaseId, expression, propertyId } }),
  recordPreviews: (ids: string[]) => call<RecordPreview[]>("record_previews", { ids }),
  historyList: (pageId: string) => call<RevisionMeta[]>("history_list", { pageId }),
  historyGet: (id: string) => call<RevisionDetail>("history_get", { id }),
  historySaveVersion: (pageId: string) => call<RevisionMeta>("history_save_version", { pageId }),
  historyCheckpoint: (pageId: string) => call<void>("history_checkpoint", { pageId }),
  /** Resolves to the id of the version that was saved just before, so the restore can be undone. */
  historyRestore: (id: string) => call<string | null>("history_restore", { id }),
  backupList: () => call<BackupInfo[]>("backup_list"),
  backupCreate: () => call<BackupInfo>("backup_create"),
  backupExport: () => call<BackupInfo | null>("backup_export"),
  backupDelete: (name: string) => call<void>("backup_delete", { name }),
  backupPreview: (name: string) => call<RestorePreview>("backup_preview", { name }),
  backupPick: () => call<RestorePreview | null>("backup_pick"),
  backupRestore: (name: string | null) => call<{ safetyBackup: string }>("backup_restore", { source: { name } }),
  templateList: () => call<TemplateInfo[]>("template_list"),
  templateCreate: (workspaceId: string, template: string, sampleData: boolean, parentPageId: string | null = null) =>
    call<TemplateResult>("template_create", { input: { workspaceId, parentPageId, template, sampleData } }),
  databaseList: (workspaceId: string) => call<DatabaseRef[]>("database_list", { workspaceId }),
  recordLookup: (databaseId: string, query: string, limit?: number) => call<RecordLink[]>("record_lookup", { input: { databaseId, query, limit } }),
  propertyDelete: (id: string) => call<void>("property_delete", { id }),
  recordCreate: (input: { databaseId: string; title?: string; values?: Record<string, unknown>; templateId?: string | null }) =>
    call<RecordRow>("record_create", { input }),
  formSubmit: (viewId: string, title: string | null, values: Record<string, unknown>) => call<RecordRow>("form_submit", { input: { viewId, title, values } }),
  recordTemplateCreate: (databaseId: string, name: string, fromRecordId?: string | null) =>
    call<RecordTemplate>("record_template_create", { input: { databaseId, name, fromRecordId } }),
  recordTemplateUpdate: (id: string, patch: { name?: string; title?: string; isDefault?: boolean }) =>
    call<RecordTemplate>("record_template_update", { input: { id, ...patch } }),
  recordTemplateDelete: (id: string) => call<void>("record_template_delete", { id }),
  automationSave: (input: { id?: string | null; databaseId: string; name: string; enabled: boolean; trigger: Trigger; conditions: FilterNode | null; actions: Action[] }) =>
    call<Automation>("automation_save", { input }),
  automationSetEnabled: (id: string, enabled: boolean) => call<Automation>("automation_set_enabled", { id, enabled }),
  automationDelete: (id: string) => call<void>("automation_delete", { id }),
  automationRunNow: (id: string, recordId?: string | null) => call<RunSummary>("automation_run_now", { id, recordId }),
  buttonPress: (recordId: string, propertyId: string) => call<RunSummary[]>("button_press", { recordId, propertyId }),
  /** Opens the native picker, reads the choice and resolves to what importing it would create. */
  importPick: (mode: "files" | "folder" | "workspace") => call<ImportPreview | null>("import_pick", { mode }),
  workspaceImport: (sessionId: string, name: string, appearance: boolean) => call<import("../types").WorkspaceImported>("workspace_import", { input: { sessionId, name, appearance } }),
  importApply: (workspaceId: string, sessionId: string, columns: Record<number, string[]>, target: import("../types").ImportTarget = { kind: "container" }) =>
    call<ImportResult>("import_apply", { input: { workspaceId, sessionId, columns, target } }),
  importCancel: (sessionId: string) => call<void>("import_cancel", { sessionId }),
  /** Saves through the native dialog: one file, a zip when there is more than one, or a PDF. */
  exportPage: (pageId: string, options: import("../types").ExportOptions) => call<ExportWritten | null>("export_page", { pageId, options }),
  exportShape: (pageId: string, options: import("../types").ExportOptions) => call<import("../types").ExportShape>("export_shape", { pageId, options }),
  exportDatabase: (pageId: string) => call<number | null>("export_database", { pageId }),
  exportTheme: (json: string) => call<boolean>("export_theme", { json }),
  exportWorkspace: (workspaceId: string) => call<import("../types").WorkspaceExported | null>("export_workspace", { workspaceId }),
  dashboardCreate: (workspaceId: string, parentPageId: string | null, title?: string) =>
    call<DashboardDetail>("dashboard_create", { input: { workspaceId, parentPageId, title } }),
  dashboardSave: (pageId: string, layout: DashboardLayout) => call<DashboardLayout>("dashboard_save", { input: { pageId, layout } }),
  recordSetValue: (recordId: string, propertyId: string, value: unknown) =>
    call<RecordRow>("record_set_value", { input: { recordId, propertyId, value } }),
  recordDuplicate: (id: string) => call<RecordRow>("record_duplicate", { id }),
  viewUpdate: (viewId: string, config: ViewConfig, name?: string) => call<DbView>("view_update", { input: { viewId, config, name } }),
  viewCreate: (databaseId: string, type: ViewType, name?: string) => call<DbView>("view_create", { input: { databaseId, type, name } }),
  viewDuplicate: (id: string) => call<DbView>("view_duplicate", { id }),
  viewDelete: (id: string) => call<void>("view_delete", { id }),
  workspaceCreate: (name: string, icon: string | null = null, settingsJson?: string) => call<Workspace>("workspace_create", { input: { name, icon, settingsJson } }),
  workspaceCreateWithImage: (name: string, settingsJson: string, fileName: string, bytes: ArrayBuffer) =>
    rawCall<Workspace>("workspace_create_with_image", bytes, { "x-workspace-profile": JSON.stringify({ name, settingsJson }), "x-file-name": fileName }),
  workspaceUpdate: (id: string, name?: string, profile?: { icon?: string | null; settingsJson?: string }) => call<Workspace>("workspace_update", { input: { id, name, icon: profile?.icon ?? undefined, clearIcon: profile?.icon === null, settingsJson: profile?.settingsJson } }),
  workspaceUpdateSettings: (id: string, settingsJson: string) =>
    call<Workspace>("workspace_update_settings", { input: { id, settingsJson } }),
  pageCreate: (workspaceId: string, parentPageId: string | null, title = "") =>
    call<Page>("page_create", { input: { workspaceId, parentPageId, title } }),
  pageUpdate: (input: { id: string; title?: string; favorite?: boolean; icon?: string; cover?: string }) => call<Page>("page_update", { input }),
  /** Copies a page (and optionally the pages inside it). `beside` puts the copy next to the original. */
  pageDuplicate: (input: { id: string; parentPageId?: string | null; beside?: boolean; title?: string; includeChildren?: boolean; targetWorkspaceId?: string }) =>
    call<{ page: Page; pages: number; skipped: number }>("page_duplicate", { input }),
  pageMove: (id: string, parentPageId: string | null, beforePageId: string | null) =>
    call<Page>("page_move", { input: { id, parentPageId, beforePageId } }),
  pageDelete: (id: string) => call<void>("page_delete", { id }),
  pageRestore: (id: string) => call<Page>("page_restore", { id }),
  pageDeletePermanent: (id: string) => call<void>("page_delete_permanent", { id }),
  trashEmpty: (workspaceId: string) => call<void>("trash_empty", { workspaceId }),
  blockCreate: (input: { pageId: string; type: BlockType; dataJson?: string; afterBlockId?: string }) =>
    call<Block>("block_create", { input }),
  blockUpdate: (input: { id: string; type?: BlockType; dataJson?: string }) => call<Block>("block_update", { input }),
  blockDelete: (id: string) => call<void>("block_delete", { id }),
  blockApplyBatch: (input: {
    pageId: string;
    upserts: { id: string; parentBlockId: string | null; type: BlockType; position: number; dataJson: string; schemaVersion: number }[];
    deleteIds: string[];
  }) => call<void>("block_apply_batch", { input }),
  /** Opens the native file picker; resolves to null when the user cancels. */
  attachmentImport: (workspaceId: string, kind: AttachmentKind) =>
    call<Attachment | null>("attachment_import", { workspaceId, kind }),
  pageTouch: (id: string) => call<void>("page_touch", { id }),
  searchRebuild: (workspaceId: string) => call<number>("search_rebuild", { workspaceId }),
  maintenanceHealth: () => call<Health>("maintenance_health"),
  maintenanceSweep: () => call<Sweep>("maintenance_sweep"),
  maintenanceCompact: () => call<[number, number]>("maintenance_compact"),
  maintenanceCheck: () => call<string>("maintenance_check"),
  /** Versions, sizes and the recent log (never document contents), for a bug report. */
  diagnosticsReport: () => call<string>("diagnostics_report"),
  backupMirrorGet: () => call<{ folder: string | null }>("backup_mirror_get"),
  backupMirrorChoose: () => call<{ folder: string | null } | null>("backup_mirror_choose"),
  backupMirrorClear: () => call<{ folder: string | null }>("backup_mirror_clear"),
  reminderCreate: (pageId: string, remindAt: string, note: string) => call<Reminder>("reminder_create", { pageId, remindAt, note }),
  reminderDelete: (id: string) => call<void>("reminder_delete", { id }),
  reminderList: (workspaceId: string) => call<Reminder[]>("reminder_list", { workspaceId }),
  tagList: (workspaceId: string) => call<TagCount[]>("tag_list", { workspaceId }),
  tagPages: (workspaceId: string, tag: string) => call<PageTitle[]>("tag_pages", { workspaceId, tag }),
  linkGraph: (workspaceId: string) => call<LinkGraph>("link_graph", { workspaceId }),
  attachmentSaveAs: (id: string) => call<boolean>("attachment_save_as", { id }),
  /** Stores a file that was pasted or dropped. The bytes are the raw request body, not JSON. */
  attachmentImportBytes: (workspaceId: string, name: string, bytes: ArrayBuffer) =>
    rawCall<Attachment>("attachment_import_bytes", bytes, { "x-workspace-id": workspaceId, "x-file-name": name }),
  /** Turns the system-wide quick-capture shortcut (Ctrl+Alt+N) on or off. */
  shortcutsMigrate: (captureEnabled: boolean) => call<GlobalState>("shortcuts_migrate", { captureEnabled }),
  shortcutsGet: () => call<GlobalState>("shortcuts_get"),
  shortcutsSet: (config: GlobalConfig) => call<GlobalState>("shortcuts_set", { config }),
  shortcutsRecording: (active: boolean) => call<void>("shortcuts_recording", { active }),
  quickCaptureShortcut: (enabled: boolean) => call<boolean>("quick_capture_shortcut", { enabled }),
  /** Applies the tray, close, minimize and start-with-computer choices. Fails with a readable reason when the system refuses. */
  shellSetBehavior: (behavior: import("../stores/preferences").ShellChoices) => call<import("../stores/preferences").ShellChoices>("shell_set_behavior", { behavior }),
  windowSetCorners: (corners: string) => call<boolean>("window_set_corners", { corners }),
  shellGetBehavior: () => call<import("../stores/preferences").ShellChoices>("shell_get_behavior"),
  /** Sets one property on many records in one all-or-nothing step. */
  recordBulkSet: (propertyId: string, recordIds: string[], value: unknown) =>
    call<import("../types").RecordRow[]>("record_bulk_set", { input: { propertyId, recordIds, value } }),
  attachmentList: (workspaceId: string) => call<import("../types").AttachmentInfo[]>("attachment_list", { workspaceId }),
  attachmentDeleteUnused: (workspaceId: string, ids: string[], includeHistory: boolean) =>
    call<import("../types").DeletedFiles>("attachment_delete_unused", { workspaceId, ids, includeHistory }),
  /** Parses pasted Markdown text into block rows (the same shape the editor stores). */
  markdownToBlocks: (text: string) =>
    call<{ id: string; parentBlockId: string | null; type: BlockType; position: number; dataJson: string; schemaVersion: number }[]>("markdown_to_blocks", { text }),
};

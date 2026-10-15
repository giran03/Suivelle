import { invoke } from "@tauri-apps/api/core";
import type { CalendarEvent, CalendarOccurrence, CalendarSchedule } from "../features/calendar/model";
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
  CanvasBoard,
  CanvasData,
  CanvasOp,
  PagePreview,
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
  const result = await track(invoke<T>(cmd, args));
  if (/^(?:page_(?:create|update|move|delete|restore|duplicate|transfer)|block_apply_batch|record_(?:create|duplicate|set_value|bulk_set_value)|database_(?:create|add_property|update_property|delete_property)|calendar_(?:create|save|import|delete)|node_map_edit|proposal_approve|changeset_revert|janitor_fix|todo_promote|agent_create|client_connect|subagents_import)/.test(cmd)) window.dispatchEvent(new Event("suivelle:graph-changed"));
  return result;
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
  calendarSnapshot: (workspaceId:string,from:string,to:string,calendarIds?:string[]) => call<{collections:Page[];events:CalendarEvent[];occurrences:CalendarOccurrence[];truncated:boolean;invalid:number}>("calendar_snapshot",{workspaceId,from,to,calendarIds}),
  calendarCreate: (workspaceId:string,title:string) => call<Page>("calendar_create",{workspaceId,title}),
  calendarImport: (workspaceId:string,events:{title:string;data:CalendarSchedule}[]) => call<CalendarEvent[]>("calendar_import",{workspaceId,events:events.map(event=>({...event,workspaceId}))}),
  calendarSave: async (input:{workspaceId:string;pageId?:string;revision?:number;title:string;data:CalendarSchedule;splitDate?:string;templateId?:string}) => {
    const {flushAllEditors}=await import("../features/editor/flushRegistry");
    await flushAllEditors(true);
    const {templateId,...payload}=input;
    const saved=await call<CalendarEvent>("calendar_save",{input:payload,templateId});
    window.dispatchEvent(new CustomEvent("calendar-event-saved",{detail:saved.pageId}));
    return saved;
  },
  mediaUrlInfo: (url: string) => call<{ kind: "image" | "audio" | "video" | "pdf"; name: string; mime: string; size: number | null } | null>("media_url_info", { url }),
  attachmentImportUrl: (workspaceId: string, url: string) => call<Attachment>("attachment_import_url", { workspaceId, url }),
  exportPagePreview: (pageId: string, format: "markdown" | "html") => call<{source:string;html:string;notices:string[];assets:Record<string,{hash:string;crop?:import("../features/editor/imageModel").Crop}>}>("export_page_preview", { pageId, format }),
  imageInfo: (id: string) => call<{width:number;height:number;animated:boolean}>("image_info", { id }),
  imageSaveCrop: (id: string, crop: import("../features/editor/imageModel").Crop) => call<boolean>("image_save_crop", { id, crop }),
  imageCopy: (id: string, crop?: import("../features/editor/imageModel").Crop, stillFrame = false) => call<void>("image_copy", { id, crop: crop ?? null, stillFrame }),
  imageOpenLink: (url: string) => call<void>("image_open_link", { url }),
  localFileOpen: (path: string) => call<void>("local_file_open", { path }),
  pageApplyTemplate: (templateId: string, pageId: string) => call<void>("page_apply_template", { templateId, pageId }),
  // queries
  workspaceList: () => call<import("../types").Workspace[]>("workspace_list"),
  workspaceStats: (id: string) => call<import("../types").WorkspaceStats>("workspace_stats", { id }),
  workspaceDelete: (id: string, confirmationName: string, saveBackup = true) => call<string | null>("workspace_delete", { id, confirmationName, saveBackup }),
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
  pagePreview: (pageId: string) => call<PagePreview | null>("page_preview", { pageId }),
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
  canvasLoad: (viewId: string) => call<CanvasData>("canvas_load", { viewId }),
  canvasApply: (viewId: string, ops: CanvasOp[]) => call<void>("canvas_apply", { viewId, ops }),
  canvasBoardList: (workspaceId: string) => call<CanvasBoard[]>("canvas_board_list", { workspaceId }),
  canvasBoardCreate: (workspaceId: string, name: string) => call<CanvasBoard>("canvas_board_create", { workspaceId, name }),
  canvasBoardRename: (id: string, name: string) => call<CanvasBoard>("canvas_board_rename", { id, name }),
  canvasBoardDuplicate: (id: string) => call<CanvasBoard>("canvas_board_duplicate", { id }),
  canvasBoardDelete: (id: string) => call<void>("canvas_board_delete", { id }),
  canvasBoardLoad: (id: string) => call<CanvasData>("canvas_board_load", { id }),
  canvasBoardApply: (id: string, ops: CanvasOp[]) => call<void>("canvas_board_apply", { id, ops }),
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
  nodeMapSnapshot: (input: import("../features/node-map/model").MapQuery) => call<import("../features/node-map/model").MapData>("node_map_snapshot", { input }),
  nodeMapEdit: (input: import("../features/node-map/model").MapEdit) => call<import("../features/node-map/model").MapEdit>("node_map_edit", { input }),
  pageUnlinkedMentions: (pageId: string) => call<Backlink[]>("page_unlinked_mentions", { pageId }),
  traySetRecent: (pages: { id: string; title: string }[]) => call<void>("tray_set_recent", { pages }),
  attachmentSaveAs: (id: string) => call<boolean>("attachment_save_as", { id }),
  /** Stores a file that was pasted or dropped. The bytes are the raw request body, not JSON. */
  attachmentImportBytes: (workspaceId: string, name: string, bytes: ArrayBuffer) =>
    rawCall<Attachment>("attachment_import_bytes", bytes, { "x-workspace-id": workspaceId, "x-file-name": name }),
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
  // Local AI agents (Settings > Agents, the Review inbox and Activity).
  agentsOverview: () => call<import("../features/agents/types").AgentsOverview>("agents_overview"),
  agentsSaveSettings: (settings: import("../features/agents/types").AgentSettings) => call<import("../features/agents/types").AgentSettings>("agents_save_settings", { settings }),
  agentCreate: (input: import("../features/agents/types").AgentInput) => call<import("../features/agents/types").Agent>("agent_create", { input }),
  agentUpdate: (id: string, input: import("../features/agents/types").AgentInput) => call<import("../features/agents/types").Agent>("agent_update", { id, input }),
  agentDelete: (id: string) => call<void>("agent_delete", { id }),
  agentTokenRotate: (id: string) => call<string>("agent_token_rotate", { id }),
  agentTokenRevoke: (id: string) => call<void>("agent_token_revoke", { id }),
  agentAudit: (agentId: string | null) => call<import("../features/agents/types").AuditEntry[]>("agent_audit", { agentId }),
  proposalList: (status: "pending" | "applied" | "rejected" | "failed" | "all") => call<import("../features/agents/types").Proposal[]>("proposal_list", { status }),
  proposalDetail: (id: string) => call<import("../features/agents/types").Proposal>("proposal_detail", { id }),
  proposalApprove: (id: string, only: number[] | null, note: string | null) => call<string[]>("proposal_approve", { id, only, note }),
  proposalReject: (id: string, note: string | null) => call<void>("proposal_reject", { id, note }),
  changesetList: (agentId: string | null, pageId: string | null) => call<import("../features/agents/types").Changeset[]>("changeset_list", { agentId, pageId }),
  changesetRevert: (id: string) => call<string[]>("changeset_revert", { id }),
  janitorReport: (workspaceId: string) => call<import("../features/agents/types").Finding[]>("janitor_report", { workspaceId }),
  janitorFix: (workspaceId: string, fixes: import("../features/agents/types").Op[]) => call<string[]>("janitor_fix", { workspaceId, fixes }),
  todoPromote: (blockId: string, agent: string | null) => call<string>("todo_promote", { blockId, agent }),
  mirrorGet: (workspaceId: string) => call<import("../features/agents/types").MirrorConfig>("mirror_get", { workspaceId }),
  mirrorChoose: (workspaceId: string) => call<import("../features/agents/types").MirrorConfig | null>("mirror_choose", { workspaceId }),
  mirrorSetEnabled: (workspaceId: string, enabled: boolean) => call<import("../features/agents/types").MirrorConfig>("mirror_set_enabled", { workspaceId, enabled }),
  agentExportSubagent: (id: string, force: boolean) => call<import("../features/agents/types").Exported | null>("agent_export_subagent", { id, force }),
  agentsExportAgentsMd: (pageIds: string[], force: boolean) => call<import("../features/agents/types").Exported | null>("agents_export_agents_md", { pageIds, force }),
  clientsScan: () => call<import("../features/agents/types").ClientScan>("clients_scan"),
  clientConnect: (clientId: string, input: import("../features/agents/types").ConnectInput) => call<import("../features/agents/types").ConnectResult>("client_connect", { clientId, input }),
  clientRepair: (clientId: string) => call<import("../features/agents/types").ConnectResult>("client_repair", { clientId }),
  clientDisconnect: (clientId: string) => call<import("../features/agents/types").DisconnectResult>("client_disconnect", { clientId }),
  subagentsScan: (project: boolean) => call<import("../features/agents/types").SubagentScan | null>("subagents_scan", { project }),
  subagentsImport: (paths: string[], workspaceIds: string[], mode: import("../features/agents/types").AgentMode | null) => call<import("../features/agents/types").ImportedSubagent[]>("subagents_import", { paths, workspaceIds, mode }),
  /** Parses pasted Markdown text into block rows (the same shape the editor stores). */
  markdownToBlocks: (text: string) =>
    call<{ id: string; parentBlockId: string | null; type: BlockType; position: number; dataJson: string; schemaVersion: number }[]>("markdown_to_blocks", { text }),
};

//! Queries: IPC entry points that only read state.

use crate::commands::{lock, worker::blocking};
use crate::database::Db;
use crate::domain::*;
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use tauri::Manager;

/// Returns the requested workspace, or the first one when `id` is omitted. `None` on a fresh install.
#[tauri::command]
pub async fn workspace_get(
    app: tauri::AppHandle,
    id: Option<String>,
) -> AppResult<Option<Workspace>> {
    blocking("workspace_get", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        match id {
            Some(id) => {
                validate_id(&id, "workspace")?;
                repo::workspace::get(&conn, &id)
            }
            None => repo::workspace::get_first(&conn),
        }
    })
    .await
}

#[tauri::command]
pub async fn page_get(app: tauri::AppHandle, id: String) -> AppResult<Page> {
    blocking("page_get", move || {
        let db = app.state::<Db>();
        validate_id(&id, "page")?;
        let conn = lock(&db)?;
        repo::page::get(&conn, &id)?
            .filter(|p| p.deleted_at.is_none())
            .ok_or_else(|| AppError::NotFound("page".into()))
    })
    .await
}

#[tauri::command]
pub async fn page_list_children(
    app: tauri::AppHandle,
    workspace_id: String,
    parent_page_id: Option<String>,
) -> AppResult<Vec<Page>> {
    blocking("page_list_children", move || {
        let db = app.state::<Db>();
        validate_id(&workspace_id, "workspace")?;
        if let Some(p) = &parent_page_id {
            validate_id(p, "parent page")?;
        }
        let conn = lock(&db)?;
        repo::page::list_children(&conn, &workspace_id, parent_page_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn block_list(app: tauri::AppHandle, page_id: String) -> AppResult<Vec<Block>> {
    blocking("block_list", move || {
        let db = app.state::<Db>();
        validate_id(&page_id, "page")?;
        let conn = lock(&db)?;
        repo::block::list(&conn, &page_id)
    })
    .await
}

/// Ancestors of a page, ordered from the top level down to its parent (for breadcrumbs).
#[tauri::command]
pub async fn page_ancestors(app: tauri::AppHandle, id: String) -> AppResult<Vec<Page>> {
    blocking("page_ancestors", move || {
        let db = app.state::<Db>();
        validate_id(&id, "page")?;
        let conn = lock(&db)?;
        let mut chain = Vec::new();
        let mut current =
            repo::page::get(&conn, &id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
        // Depth guard protects against corrupt cyclic data.
        while let Some(pid) = current.parent_page_id.clone() {
            if chain.len() > 1000 {
                return Err(AppError::Internal(
                    "page hierarchy is too deep or cyclic".into(),
                ));
            }
            current = repo::page::get(&conn, &pid)?
                .ok_or_else(|| AppError::NotFound("parent page".into()))?;
            chain.push(current.clone());
        }
        chain.reverse();
        Ok(chain)
    })
    .await
}

#[tauri::command]
pub async fn page_list_favorites(
    app: tauri::AppHandle,
    workspace_id: String,
) -> AppResult<Vec<Page>> {
    blocking("page_list_favorites", move || {
        let db = app.state::<Db>();
        validate_id(&workspace_id, "workspace")?;
        let conn = lock(&db)?;
        repo::page::list_favorites(&conn, &workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn page_list_trash(app: tauri::AppHandle, workspace_id: String) -> AppResult<Vec<Page>> {
    blocking("page_list_trash", move || {
        let db = app.state::<Db>();
        validate_id(&workspace_id, "workspace")?;
        let conn = lock(&db)?;
        repo::page::list_trash(&conn, &workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn search_workspace(
    app: tauri::AppHandle,
    input: crate::search::SearchInput,
) -> AppResult<Vec<crate::search::SearchHit>> {
    blocking("search_workspace", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::search::search(&conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn page_list_recent(
    app: tauri::AppHandle,
    workspace_id: String,
    limit: Option<i64>,
) -> AppResult<Vec<Page>> {
    blocking("page_list_recent", move || {
        let db = app.state::<Db>();
        validate_id(&workspace_id, "workspace")?;
        let conn = lock(&db)?;
        repo::page::list_recent(&conn, &workspace_id, limit.unwrap_or(8).clamp(1, 30))
    })
    .await
}

#[tauri::command]
pub async fn page_backlinks(
    app: tauri::AppHandle,
    page_id: String,
) -> AppResult<Vec<crate::search::Backlink>> {
    blocking("page_backlinks", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::search::backlinks(&conn, &page_id)
    })
    .await
}

#[tauri::command]
pub async fn page_titles(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> AppResult<Vec<crate::search::PageTitle>> {
    blocking("page_titles", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::search::page_titles(&conn, &ids)
    })
    .await
}

#[tauri::command]
pub async fn database_get(
    app: tauri::AppHandle,
    page_id: String,
) -> AppResult<crate::databases::DatabaseDetail> {
    blocking("database_get", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::databases::service::database_detail_by_page(&conn, &page_id)
    })
    .await
}

#[tauri::command]
pub async fn record_get(
    app: tauri::AppHandle,
    page_id: String,
) -> AppResult<crate::databases::RecordDetail> {
    blocking("record_get", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::databases::service::record_detail(&conn, &page_id)
    })
    .await
}

#[tauri::command]
pub async fn query_records(
    app: tauri::AppHandle,
    input: crate::databases::RecordQuery,
) -> AppResult<crate::databases::RecordPage> {
    blocking("query_records", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::databases::service::query_records(&conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn group_counts(
    app: tauri::AppHandle,
    input: crate::databases::GroupCountsQuery,
) -> AppResult<Vec<crate::databases::GroupCount>> {
    blocking("group_counts", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::databases::service::group_counts(&conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn record_lookup(
    app: tauri::AppHandle,
    input: crate::databases::RecordLookup,
) -> AppResult<Vec<crate::databases::RecordRef>> {
    blocking("record_lookup", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::databases::relations::lookup(&conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn database_list(
    app: tauri::AppHandle,
    workspace_id: String,
) -> AppResult<Vec<crate::databases::DatabaseRef>> {
    blocking("database_list", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::databases::relations::list_databases(&conn, &workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn formula_preview(
    app: tauri::AppHandle,
    input: crate::databases::FormulaPreviewInput,
) -> AppResult<crate::databases::FormulaPreview> {
    blocking("formula_preview", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::databases::service::formula_preview(&conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn record_previews(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> AppResult<Vec<crate::databases::RecordPreview>> {
    blocking("record_previews", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::databases::previews::previews(&conn, &ids)
    })
    .await
}

#[tauri::command]
pub async fn chart_data(
    app: tauri::AppHandle,
    input: crate::databases::ChartQuery,
) -> AppResult<crate::databases::ChartData> {
    blocking("chart_data", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::databases::charts::data(&conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn record_template_list(
    app: tauri::AppHandle,
    database_id: String,
) -> AppResult<Vec<crate::databases::record_templates::RecordTemplate>> {
    blocking("record_template_list", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::databases::record_templates::list(&conn, &database_id)
    })
    .await
}

#[tauri::command]
pub async fn dashboard_get(
    app: tauri::AppHandle,
    page_id: String,
) -> AppResult<crate::dashboards::DashboardDetail> {
    blocking("dashboard_get", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::dashboards::get(&conn, &page_id)
    })
    .await
}

#[tauri::command]
pub async fn automation_list(
    app: tauri::AppHandle,
    database_id: String,
) -> AppResult<Vec<crate::automation::Automation>> {
    blocking("automation_list", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::automation::list(&conn, &database_id)
    })
    .await
}

#[tauri::command]
pub async fn automation_runs(
    app: tauri::AppHandle,
    database_id: String,
) -> AppResult<Vec<crate::automation::Run>> {
    blocking("automation_runs", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::automation::runs(&conn, &database_id)
    })
    .await
}

#[tauri::command]
pub fn template_list() -> Vec<crate::databases::templates::TemplateInfo> {
    crate::databases::templates::TEMPLATES.to_vec()
}

#[tauri::command]
pub async fn history_list(
    app: tauri::AppHandle,
    page_id: String,
) -> AppResult<Vec<crate::history::RevisionMeta>> {
    blocking("history_list", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::history::list(&conn, &page_id)
    })
    .await
}

#[tauri::command]
pub async fn history_get(
    app: tauri::AppHandle,
    id: String,
) -> AppResult<crate::history::RevisionDetail> {
    blocking("history_get", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::history::get(&conn, &id)
    })
    .await
}

#[tauri::command]
pub async fn backup_list(app: tauri::AppHandle) -> AppResult<Vec<crate::backup::BackupInfo>> {
    blocking("backup_list", move || {
        let paths = app.state::<crate::backup::Paths>();
        Ok(crate::backup::list(&paths))
    })
    .await
}

#[tauri::command]
pub async fn backup_preview(
    app: tauri::AppHandle,
    name: String,
) -> AppResult<crate::backup::RestorePreview> {
    blocking("backup_preview", move || {
        let db = app.state::<Db>();
        let paths = app.state::<crate::backup::Paths>();
        let path = crate::backup::app_backup_path(&paths, &name)?;
        let conn = lock(&db)?;
        crate::backup::preview(&conn, &path, &name)
    })
    .await
}

#[tauri::command]
pub async fn workspace_list(app: tauri::AppHandle) -> AppResult<Vec<Workspace>> {
    blocking("workspace_list", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        repo::workspace::list(&conn)
    })
    .await
}

#[tauri::command]
pub async fn workspace_stats(
    app: tauri::AppHandle,
    id: String,
) -> AppResult<crate::domain::WorkspaceStats> {
    blocking("workspace_stats", move || {
        let db = app.state::<Db>();
        validate_id(&id, "workspace")?;
        let conn = lock(&db)?;
        if repo::workspace::get(&conn, &id)?.is_none() {
            return Err(AppError::NotFound("workspace".into()));
        }
        repo::workspace::stats(&conn, &id)
    })
    .await
}

#[tauri::command]
pub async fn tag_list(
    app: tauri::AppHandle,
    workspace_id: String,
) -> AppResult<Vec<crate::search::TagCount>> {
    blocking("tag_list", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::search::tags(&conn, &workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn tag_pages(
    app: tauri::AppHandle,
    workspace_id: String,
    tag: String,
) -> AppResult<Vec<crate::search::PageTitle>> {
    blocking("tag_pages", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::search::tagged_pages(&conn, &workspace_id, &tag)
    })
    .await
}

#[tauri::command]
pub async fn link_graph(
    app: tauri::AppHandle,
    workspace_id: String,
) -> AppResult<crate::search::LinkGraph> {
    blocking("link_graph", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::search::link_graph(&conn, &workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn reminder_list(
    app: tauri::AppHandle,
    workspace_id: String,
) -> AppResult<Vec<crate::reminders::Reminder>> {
    blocking("reminder_list", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        let now = chrono::Local::now().naive_local();
        crate::reminders::list(&conn, &workspace_id, now)
    })
    .await
}

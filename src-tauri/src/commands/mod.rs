//! Commands: IPC entry points that mutate state. Thin wrappers over services.

pub mod calendar;
pub mod content;
pub mod local_file;
pub mod image;
pub mod maintenance;
pub mod remote;
pub mod worker;
use worker::blocking;

use crate::database::Db;
use crate::databases::{self, service as dbs};
use crate::domain::*;
use crate::errors::{AppError, AppResult};
use crate::files::{self, AttachmentStore};
use crate::services;
use rusqlite::Connection;
use std::sync::MutexGuard;
use tauri::{Manager, State};

#[tauri::command]
pub async fn node_map_edit(app: tauri::AppHandle, input: crate::node_map::edit::MapEdit) -> AppResult<crate::node_map::edit::MapEdit> {
    blocking("node_map_edit", move || {
        let db=app.state::<Db>();
        let mut conn=lock(&db)?;
        let inverse=crate::node_map::edit::apply(&mut conn,input)?;
        // Preserve the same database automations as edits from a table or calendar.
        if let crate::node_map::edit::MapEdit::Cells{property_id,changes,..}=&inverse {
            let mut events=Vec::new();
            for change in changes {
                if let Ok(rows)=dbs::load_rows(&conn,std::slice::from_ref(&change.record_id)) {
                    if let Some(row)=rows.first() {let before=(!change.value.is_null()).then_some(&change.value);events.extend(crate::automation::engine::change_events(before,row,property_id));}
                }
            }
            react(&app,&mut conn,events);
        }
        Ok(inverse)
    }).await
}

pub(crate) fn lock<'a>(db: &'a State<'_, Db>) -> AppResult<MutexGuard<'a, Connection>> {
    let started = std::time::Instant::now();
    let guard =
        db.0.lock()
            .map_err(|_| AppError::Internal("database lock poisoned".into()))?;
    if crate::updates::preparing() {
        return Err(AppError::Validation(
            "Suivelle is preparing an update. Try again after it restarts.".into(),
        ));
    }
    tracing::debug!(
        wait_us = started.elapsed().as_micros() as u64,
        "database lock acquired"
    );
    Ok(guard)
}

fn logged<T>(name: &str, started: std::time::Instant, res: AppResult<T>) -> AppResult<T> {
    match &res {
        Ok(_) => tracing::debug!(
            command = name,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "ok"
        ),
        Err(e) => tracing::warn!(command = name, error_code = e.code(), "command failed"),
    }
    res
}

macro_rules! command {
    ($name:ident, $svc:path, $input:ty, $out:ty) => {
        #[tauri::command]
        pub async fn $name(app: tauri::AppHandle, input: $input) -> AppResult<$out> {
            blocking(stringify!($name), move || {
                let db = app.state::<Db>();
                let t = std::time::Instant::now();
                let res = lock(&db).and_then(|mut c| $svc(&mut c, input));
                logged(stringify!($name), t, res)
            })
            .await
        }
    };
}

command!(
    workspace_create,
    services::workspace::create,
    WorkspaceCreate,
    Workspace
);
command!(
    workspace_update,
    services::workspace::update,
    WorkspaceUpdate,
    Workspace
);
command!(
    workspace_update_settings,
    services::workspace::update_settings,
    WorkspaceUpdateSettings,
    Workspace
);
command!(page_create, services::page::create, PageCreate, Page);
command!(page_move, services::page::move_page, PageMove, Page);
command!(block_create, services::block::create, BlockCreate, Block);
command!(
    block_apply_batch,
    services::block::apply_batch,
    BlockBatch,
    ()
);
command!(block_update, services::block::update, BlockUpdate, Block);

#[tauri::command]
pub async fn page_delete(app: tauri::AppHandle, id: String) -> AppResult<()> {
    blocking("page_delete", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| services::page::delete(&mut c, &id));
        logged("page_delete", t, res)
    })
    .await
}

#[tauri::command]
pub async fn block_delete(app: tauri::AppHandle, id: String) -> AppResult<()> {
    blocking("block_delete", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| services::block::delete(&mut c, &id));
        logged("block_delete", t, res)
    })
    .await
}

#[tauri::command]
pub async fn workspace_delete(
    app: tauri::AppHandle,
    id: String,
    confirmation_name: String,
) -> AppResult<String> {
    blocking("workspace_delete", move || {
        let db = app.state::<Db>();
        let paths = app.state::<crate::backup::Paths>();
        services::workspace::delete_safely(&db.0, &paths, &id, &confirmation_name)
    })
    .await
}

/// The second folder that receives a copy of each automatic backup, if one is set.
#[tauri::command]
pub fn backup_mirror_get(app: tauri::AppHandle) -> crate::backup::Mirror {
    crate::backup::mirror(&app.state::<crate::backup::Paths>())
}

/// Lets the user pick the second backup folder; `None` when the picker is cancelled.
#[tauri::command]
pub async fn backup_mirror_choose(
    app: tauri::AppHandle,
) -> AppResult<Option<crate::backup::Mirror>> {
    worker::dialog("backup_mirror_choose", move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(folder) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let paths = app.state::<crate::backup::Paths>();
        crate::backup::set_mirror(&paths, Some(&path_of(folder)?)).map(Some)
    })
    .await
}

#[tauri::command]
pub fn backup_mirror_clear(app: tauri::AppHandle) -> AppResult<crate::backup::Mirror> {
    crate::backup::set_mirror(&app.state::<crate::backup::Paths>(), None)
}

#[tauri::command]
pub async fn backup_set_auto(
    app: tauri::AppHandle,
    enabled: Option<bool>,
    keep: Option<usize>,
) -> AppResult<Vec<Workspace>> {
    blocking("backup_set_auto", move || {
        let db = app.state::<Db>();
        let mut conn = lock(&db)?;
        services::workspace::set_backup_policy(&mut conn, enabled, keep)
    })
    .await
}

#[tauri::command]
pub async fn page_restore(app: tauri::AppHandle, id: String) -> AppResult<Page> {
    blocking("page_restore", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| services::page::restore(&mut c, &id));
        logged("page_restore", t, res)
    })
    .await
}

#[tauri::command]
pub async fn page_delete_permanent(app: tauri::AppHandle, id: String) -> AppResult<()> {
    blocking("page_delete_permanent", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| services::page::delete_permanent(&mut c, &id));
        logged("page_delete_permanent", t, res)
    })
    .await
}

#[tauri::command]
pub async fn trash_empty(app: tauri::AppHandle, workspace_id: String) -> AppResult<()> {
    blocking("trash_empty", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| services::page::empty_trash(&mut c, &workspace_id));
        logged("trash_empty", t, res)
    })
    .await
}

/// Opens the native file picker (filtered by kind), stores the chosen file, and returns its metadata.
/// The frontend never supplies or receives a filesystem path. `None` means the user cancelled.
#[tauri::command]
pub async fn attachment_import(
    app: tauri::AppHandle,
    workspace_id: String,
    kind: String,
) -> AppResult<Option<Attachment>> {
    worker::dialog("attachment_import", move || {
        let db = app.state::<Db>();
        let store = app.state::<AttachmentStore>();
        use tauri_plugin_dialog::DialogExt;
        validate_id(&workspace_id, "workspace")?;
        let exts = files::kind_extensions(&kind)?;
        let mut dialog = app.dialog().file();
        if !exts.is_empty() {
            dialog = dialog.add_filter(kind.clone(), exts);
        }
        let Some(picked) = dialog.blocking_pick_file() else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| {
            files::import_file(&mut c, &store.root, &workspace_id, &path, &kind).map(Some)
        });
        logged("attachment_import", t, res)
    })
    .await
}

/// Asks where to save and writes a copy of a stored attachment. Returns false if cancelled.
#[tauri::command]
pub async fn attachment_save_as(app: tauri::AppHandle, id: String) -> AppResult<bool> {
    worker::dialog("attachment_save_as", move || {
        let db = app.state::<Db>();
        let store = app.state::<AttachmentStore>();
        use tauri_plugin_dialog::DialogExt;
        validate_id(&id, "attachment")?;
        let att = {
            let conn = lock(&db)?;
            files::get(&conn, &id)?.ok_or_else(|| AppError::NotFound("attachment".into()))?
        };
        let Some(dest) = app
            .dialog()
            .file()
            .set_file_name(&att.original_name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let dest = dest
            .into_path()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        std::fs::copy(files::blob_path(&store.root, &att.hash), dest)?;
        Ok(true)
    })
    .await
}

/// Records that a page was opened (feeds the recent pages list).
#[tauri::command]
pub async fn page_touch(app: tauri::AppHandle, id: String) -> AppResult<()> {
    blocking("page_touch", move || {
        let db = app.state::<Db>();
        validate_id(&id, "page")?;
        let conn = lock(&db)?;
        crate::repositories::page::touch_opened(&conn, &id, &now())?;
        Ok(())
    })
    .await
}

/// Maintenance: rebuilds the search index and references from the stored content.
#[tauri::command]
pub async fn search_rebuild(app: tauri::AppHandle, workspace_id: String) -> AppResult<i64> {
    blocking("search_rebuild", move || {
        let db = app.state::<Db>();
        validate_id(&workspace_id, "workspace")?;
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| {
            let tx = c.transaction()?;
            let n = crate::search::index::rebuild_workspace(&tx, &workspace_id)?;
            tx.commit()?;
            Ok(n)
        });
        logged("search_rebuild", t, res)
    })
    .await
}

command!(
    database_create,
    dbs::create_database,
    databases::DatabaseCreate,
    databases::DatabaseDetail
);
command!(
    property_create,
    dbs::add_property,
    databases::PropertyCreate,
    databases::Property
);
command!(
    property_update,
    dbs::update_property,
    databases::PropertyUpdate,
    databases::Property
);
command!(
    template_create,
    databases::templates::create_from_template,
    databases::templates::TemplateCreate,
    databases::templates::TemplateResult
);
command!(
    view_update,
    dbs::update_view,
    databases::ViewUpdate,
    databases::DbView
);

#[tauri::command]
pub async fn property_delete(app: tauri::AppHandle, id: String) -> AppResult<()> {
    blocking("property_delete", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| dbs::delete_property(&mut c, &id));
        logged("property_delete", t, res)
    })
    .await
}

command!(
    view_create,
    dbs::create_view,
    databases::ViewCreate,
    databases::DbView
);

command!(
    record_template_create,
    databases::record_templates::create,
    databases::record_templates::RecordTemplateCreate,
    databases::record_templates::RecordTemplate
);
command!(
    record_template_update,
    databases::record_templates::update,
    databases::record_templates::RecordTemplateUpdate,
    databases::record_templates::RecordTemplate
);
command!(
    dashboard_create,
    crate::dashboards::create,
    crate::dashboards::DashboardCreate,
    crate::dashboards::DashboardDetail
);
command!(
    dashboard_save,
    crate::dashboards::save,
    crate::dashboards::DashboardSave,
    crate::dashboards::Layout
);

#[tauri::command]
pub async fn record_template_delete(app: tauri::AppHandle, id: String) -> AppResult<()> {
    blocking("record_template_delete", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| databases::record_templates::delete(&mut c, &id));
        logged("record_template_delete", t, res)
    })
    .await
}

#[tauri::command]
pub async fn view_delete(app: tauri::AppHandle, id: String) -> AppResult<()> {
    blocking("view_delete", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| dbs::delete_view(&mut c, &id));
        logged("view_delete", t, res)
    })
    .await
}

#[tauri::command]
pub async fn canvas_load(
    app: tauri::AppHandle,
    view_id: String,
) -> AppResult<databases::canvas::CanvasData> {
    blocking("canvas_load", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        databases::canvas::load(&conn, &view_id)
    })
    .await
}

#[tauri::command]
pub async fn canvas_apply(
    app: tauri::AppHandle,
    view_id: String,
    ops: Vec<databases::canvas::CanvasOp>,
) -> AppResult<()> {
    blocking("canvas_apply", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| databases::canvas::apply(&mut c, &view_id, &ops));
        logged("canvas_apply", t, res)
    })
    .await
}

#[tauri::command]
pub async fn canvas_board_list(app: tauri::AppHandle, workspace_id: String) -> AppResult<Vec<databases::canvas::CanvasBoard>> {
    blocking("canvas_board_list", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        databases::canvas::list_boards(&conn, &workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn canvas_board_create(app: tauri::AppHandle, workspace_id: String, name: String) -> AppResult<databases::canvas::CanvasBoard> {
    blocking("canvas_board_create", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|c| databases::canvas::create_board(&c, &workspace_id, &name));
        logged("canvas_board_create", t, res)
    })
    .await
}

#[tauri::command]
pub async fn canvas_board_rename(app: tauri::AppHandle, id: String, name: String) -> AppResult<databases::canvas::CanvasBoard> {
    blocking("canvas_board_rename", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|c| databases::canvas::rename_board(&c, &id, &name));
        logged("canvas_board_rename", t, res)
    })
    .await
}

#[tauri::command]
pub async fn canvas_board_duplicate(app: tauri::AppHandle, id: String) -> AppResult<databases::canvas::CanvasBoard> {
    blocking("canvas_board_duplicate", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| {
            let tx = c.transaction()?;
            let copy = databases::canvas::duplicate_board(&tx, &id)?;
            tx.commit()?;
            Ok(copy)
        });
        logged("canvas_board_duplicate", t, res)
    })
    .await
}

#[tauri::command]
pub async fn canvas_board_delete(app: tauri::AppHandle, id: String) -> AppResult<()> {
    blocking("canvas_board_delete", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|c| databases::canvas::delete_board(&c, &id));
        logged("canvas_board_delete", t, res)
    })
    .await
}

#[tauri::command]
pub async fn canvas_board_load(app: tauri::AppHandle, id: String) -> AppResult<databases::canvas::CanvasData> {
    blocking("canvas_board_load", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        databases::canvas::load_board(&conn, &id)
    })
    .await
}

#[tauri::command]
pub async fn canvas_board_apply(app: tauri::AppHandle, id: String, ops: Vec<databases::canvas::CanvasOp>) -> AppResult<()> {
    blocking("canvas_board_apply", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| databases::canvas::apply_board(&mut c, &id, &ops));
        logged("canvas_board_apply", t, res)
    })
    .await
}

#[tauri::command]
pub async fn view_duplicate(app: tauri::AppHandle, id: String) -> AppResult<databases::DbView> {
    blocking("view_duplicate", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| dbs::duplicate_view(&mut c, &id));
        logged("view_duplicate", t, res)
    })
    .await
}

#[tauri::command]
pub async fn history_save_version(
    app: tauri::AppHandle,
    page_id: String,
) -> AppResult<crate::history::RevisionMeta> {
    blocking("history_save_version", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|c| crate::history::save_version(&c, &page_id));
        logged("history_save_version", t, res)
    })
    .await
}

#[tauri::command]
pub async fn history_checkpoint(app: tauri::AppHandle, page_id: String) -> AppResult<()> {
    blocking("history_checkpoint", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|c| crate::history::checkpoint(&c, &page_id));
        logged("history_checkpoint", t, res)
    })
    .await
}

#[tauri::command]
pub async fn history_restore(app: tauri::AppHandle, id: String) -> AppResult<Option<String>> {
    blocking("history_restore", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| crate::history::restore(&mut c, &id));
        logged("history_restore", t, res)
    })
    .await
}

// ---- backups ----

/// The backup file the user picked for a restore, remembered here so the frontend never has to
/// send (or even see) a path.
#[derive(Default)]
pub struct PendingRestore(pub std::sync::Mutex<Option<std::path::PathBuf>>);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSource {
    /// A backup in the app's own folder; absent means the file picked with "Restore from file".
    pub name: Option<String>,
}

#[tauri::command]
pub async fn backup_create(app: tauri::AppHandle) -> AppResult<crate::backup::BackupInfo> {
    blocking("backup_create", move || {
        let db = app.state::<Db>();
        let paths = app.state::<crate::backup::Paths>();
        let t = std::time::Instant::now();
        let res = crate::backup::create_in_app(&db.0, &paths, "manual");
        logged("backup_create", t, res)
    })
    .await
}

#[tauri::command]
pub async fn backup_export(app: tauri::AppHandle) -> AppResult<Option<crate::backup::BackupInfo>> {
    worker::dialog("backup_export", move || {
        let db = app.state::<Db>();
        let paths = app.state::<crate::backup::Paths>();
        use tauri_plugin_dialog::DialogExt;
        let name = format!(
            "suivelle-{}.{}",
            chrono::Local::now().format("%Y-%m-%d"),
            crate::backup::EXTENSION
        );
        let Some(dest) = app
            .dialog()
            .file()
            .add_filter("Suivelle backup", &[crate::backup::EXTENSION])
            .set_file_name(&name)
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let mut dest = dest
            .into_path()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        dest.set_extension(crate::backup::EXTENSION);
        let t = std::time::Instant::now();
        let res = (|| {
            let pending = {
                let guard = lock(&db)?;
                crate::backup::begin(&guard, &paths, "export")?
            };
            crate::backup::finish(&paths, pending, &dest).map(Some)
        })();
        logged("backup_export", t, res)
    })
    .await
}

#[tauri::command]
pub async fn backup_delete(app: tauri::AppHandle, name: String) -> AppResult<()> {
    blocking("backup_delete", move || {
        let paths = app.state::<crate::backup::Paths>();
        crate::backup::delete(&paths, &name)
    })
    .await
}

#[tauri::command]
pub async fn backup_pick(
    app: tauri::AppHandle,
) -> AppResult<Option<crate::backup::RestorePreview>> {
    worker::dialog("backup_pick", move || {
        let db = app.state::<Db>();
        let pending = app.state::<PendingRestore>();
        use tauri_plugin_dialog::DialogExt;
        let Some(picked) = app
            .dialog()
            .file()
            .add_filter("Suivelle backup", crate::backup::SUPPORTED_EXTENSIONS)
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        let preview = {
            let guard = lock(&db)?;
            crate::backup::preview(&guard, &path, "")?
        };
        *pending
            .0
            .lock()
            .map_err(|_| AppError::Internal("lock poisoned".into()))? = Some(path);
        Ok(Some(preview))
    })
    .await
}

#[tauri::command]
pub async fn backup_restore(
    app: tauri::AppHandle,
    source: RestoreSource,
) -> AppResult<crate::backup::RestoreOutcome> {
    blocking("backup_restore", move || {
        let db = app.state::<Db>();
        let paths = app.state::<crate::backup::Paths>();
        let pending = app.state::<PendingRestore>();
        let archive = match &source.name {
            Some(name) => crate::backup::app_backup_path(&paths, name)?,
            None => pending
                .0
                .lock()
                .map_err(|_| AppError::Internal("lock poisoned".into()))?
                .clone()
                .ok_or_else(|| AppError::Validation("choose a backup file first".into()))?,
        };
        let t = std::time::Instant::now();
        let res = crate::backup::restore(&db.0, &paths, &archive);
        if res.is_ok() {
            if let Ok(mut p) = pending.0.lock() {
                *p = None;
            }
        }
        logged("backup_restore", t, res)
    })
    .await
}

// ---- automation ----

/// Shows an automation's notification on the desktop. A refusal is logged, never an error.
pub fn notifier(
    app: &tauri::AppHandle,
) -> impl FnMut(crate::automation::engine::Notification) + '_ {
    move |n| {
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = app
            .notification()
            .builder()
            .title(&n.title)
            .body(&n.body)
            .show()
        {
            tracing::warn!(error = %e, "notification not shown");
        }
    }
}

/// Runs the automations a committed change triggers. A failing automation is logged and never
/// fails the change that triggered it.
fn react(
    app: &tauri::AppHandle,
    conn: &mut Connection,
    events: Vec<crate::automation::engine::Event>,
) {
    if events.is_empty() {
        return;
    }
    let mut sink = notifier(app);
    if let Err(e) = crate::automation::engine::dispatch_all(conn, events, &mut sink) {
        tracing::warn!(error = %e, "automation dispatch failed");
    }
}

/// The record as it is now, after automations may have changed it.
fn fresh(conn: &Connection, row: databases::RecordRow) -> databases::RecordRow {
    dbs::load_rows(conn, std::slice::from_ref(&row.id))
        .ok()
        .and_then(|r| r.into_iter().next())
        .unwrap_or(row)
}

#[tauri::command]
pub async fn record_create(
    app: tauri::AppHandle,
    input: databases::RecordCreate,
) -> AppResult<databases::RecordRow> {
    blocking("record_create", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| {
            let row = dbs::create_record(&mut c, input)?;
            react(
                &app,
                &mut c,
                vec![crate::automation::engine::Event::RecordCreated {
                    record_id: row.id.clone(),
                }],
            );
            Ok(fresh(&c, row))
        });
        logged("record_create", t, res)
    })
    .await
}

#[tauri::command]
pub async fn form_submit(
    app: tauri::AppHandle,
    input: databases::FormSubmit,
) -> AppResult<databases::RecordRow> {
    blocking("form_submit", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| {
            let row = databases::forms::submit(&mut c, input)?;
            react(
                &app,
                &mut c,
                vec![crate::automation::engine::Event::RecordCreated {
                    record_id: row.id.clone(),
                }],
            );
            Ok(fresh(&c, row))
        });
        logged("form_submit", t, res)
    })
    .await
}

#[tauri::command]
pub async fn record_duplicate(
    app: tauri::AppHandle,
    id: String,
) -> AppResult<databases::RecordRow> {
    blocking("record_duplicate", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| {
            let row = dbs::duplicate_record(&mut c, &id)?;
            react(
                &app,
                &mut c,
                vec![crate::automation::engine::Event::RecordCreated {
                    record_id: row.id.clone(),
                }],
            );
            Ok(fresh(&c, row))
        });
        logged("record_duplicate", t, res)
    })
    .await
}

#[tauri::command]
pub async fn record_set_value(
    app: tauri::AppHandle,
    input: databases::SetValue,
) -> AppResult<databases::RecordRow> {
    blocking("record_set_value", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| {
            let old = dbs::load_rows(&c, std::slice::from_ref(&input.record_id))
                .ok()
                .and_then(|r| r.into_iter().next())
                .and_then(|r| r.values.get(&input.property_id).cloned());
            let property_id = input.property_id.clone();
            let row = dbs::set_value(&mut c, input)?;
            let events = crate::automation::engine::change_events(old.as_ref(), &row, &property_id);
            react(&app, &mut c, events);
            Ok(fresh(&c, row))
        });
        logged("record_set_value", t, res)
    })
    .await
}

#[tauri::command]
pub async fn page_update(app: tauri::AppHandle, input: PageUpdate) -> AppResult<Page> {
    blocking("page_update", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| {
            let before = crate::repositories::page::get(&c, &input.id)?.map(|p| p.title);
            let page = services::page::update(&mut c, input)?;
            if page.kind == "record" && before.is_some_and(|b| b != page.title) {
                if let Ok(record_id) = c.query_row(
                    "SELECT id FROM db_record WHERE page_id = ?1",
                    [&page.id],
                    |r| r.get::<_, String>(0),
                ) {
                    react(
                        &app,
                        &mut c,
                        vec![crate::automation::engine::Event::RecordUpdated { record_id }],
                    );
                }
            }
            Ok(page)
        });
        logged("page_update", t, res)
    })
    .await
}

command!(
    automation_save,
    crate::automation::save,
    crate::automation::AutomationSave,
    crate::automation::Automation
);

#[tauri::command]
pub async fn automation_set_enabled(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> AppResult<crate::automation::Automation> {
    blocking("automation_set_enabled", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| crate::automation::set_enabled(&mut c, &id, enabled));
        logged("automation_set_enabled", t, res)
    })
    .await
}

#[tauri::command]
pub async fn automation_delete(app: tauri::AppHandle, id: String) -> AppResult<()> {
    blocking("automation_delete", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| crate::automation::delete(&mut c, &id));
        logged("automation_delete", t, res)
    })
    .await
}

#[tauri::command]
pub async fn automation_run_now(
    app: tauri::AppHandle,
    id: String,
    record_id: Option<String>,
) -> AppResult<crate::automation::engine::RunSummary> {
    blocking("automation_run_now", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| {
            let mut sink = notifier(&app);
            crate::automation::engine::run_now(&mut c, &id, record_id.as_deref(), &mut sink)
        });
        logged("automation_run_now", t, res)
    })
    .await
}

#[tauri::command]
pub async fn button_press(
    app: tauri::AppHandle,
    record_id: String,
    property_id: String,
) -> AppResult<Vec<crate::automation::engine::RunSummary>> {
    blocking("button_press", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| {
            let mut sink = notifier(&app);
            crate::automation::engine::press_button(&mut c, &record_id, &property_id, &mut sink)
        });
        logged("button_press", t, res)
    })
    .await
}

// ---- import and export ----

/// Parsed imports waiting for the user to confirm them; the frontend only ever holds their ids.
#[derive(Default)]
pub struct ImportSessions(pub std::sync::Mutex<Vec<crate::transfer::import::Staged>>);

const MAX_SESSIONS: usize = 3;

fn path_of(p: tauri_plugin_dialog::FilePath) -> AppResult<std::path::PathBuf> {
    p.into_path().map_err(|e| AppError::Internal(e.to_string()))
}

/// Opens the native picker (files or a folder), reads and parses the choice and returns what
/// importing it would create. Nothing is written to the workspace yet.
#[tauri::command]
pub async fn import_pick(
    app: tauri::AppHandle,
    mode: String,
) -> AppResult<Option<crate::transfer::import::Preview>> {
    worker::dialog("import_pick", move || {
        let sessions = app.state::<ImportSessions>();
        use tauri_plugin_dialog::DialogExt;
        let t = std::time::Instant::now();
        let staged = match mode.as_str() {
            "workspace" => match app
                .dialog()
                .file()
                .add_filter("Suivelle workspace archive", &["zip"])
                .blocking_pick_file()
            {
                Some(f) => crate::transfer::import::stage_workspace_archive(&path_of(f)?),
                None => return Ok(None),
            },
            "folder" => match app.dialog().file().blocking_pick_folder() {
                Some(f) => crate::transfer::import::stage_folder(path_of(f)?),
                None => return Ok(None),
            },
            "files" => {
                let picked = app
                    .dialog()
                    .file()
                    .add_filter(
                        "Documents, tables, PDFs and zips",
                        &[
                            "md", "markdown", "txt", "html", "htm", "csv", "tsv", "pdf", "zip",
                        ],
                    )
                    .blocking_pick_files();
                match picked {
                    Some(list) => crate::transfer::import::stage_files(
                        list.into_iter()
                            .map(path_of)
                            .collect::<AppResult<Vec<_>>>()?,
                    ),
                    None => return Ok(None),
                }
            }
            _ => {
                return Err(AppError::Validation(
                    "choose files, a folder or a workspace archive".into(),
                ))
            }
        };
        let res = staged.map(|s| {
            let preview = crate::transfer::import::preview(&s);
            let mut list = sessions.0.lock().unwrap_or_else(|p| p.into_inner());
            list.push(s);
            while list.len() > MAX_SESSIONS {
                list.remove(0);
            }
            Some(preview)
        });
        logged("import_pick", t, res)
    })
    .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportApply {
    pub workspace_id: String,
    pub session_id: String,
    /// Column types chosen in the preview, by entry index.
    #[serde(default)]
    pub columns: std::collections::HashMap<usize, Vec<String>>,
    /// Where the imported pages go (a new "Imported" page by default).
    #[serde(default)]
    pub target: crate::transfer::import::Target,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImport {
    pub session_id: String,
    pub name: String,
    pub appearance: bool,
}

#[tauri::command]
pub async fn workspace_import(
    app: tauri::AppHandle,
    input: WorkspaceImport,
) -> AppResult<crate::transfer::archive::WorkspaceImported> {
    blocking("workspace_import", move || {
        use tauri::Manager;
        let sessions = app.state::<ImportSessions>();
        let staged = {
            let mut list = sessions.0.lock().unwrap_or_else(|p| p.into_inner());
            let index = list
                .iter()
                .position(|s| s.id == input.session_id)
                .ok_or_else(|| AppError::NotFound("import".into()))?;
            list.remove(index)
        };
        let db = app.state::<Db>();
        let store = app.state::<AttachmentStore>();
        let result = lock(&db).and_then(|mut c| {
            crate::transfer::import::apply_workspace(
                &mut c,
                &store.root,
                &staged,
                &input.name,
                input.appearance,
            )
        });
        if result.is_err() {
            sessions
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(staged);
        }
        result
    })
    .await
}

#[tauri::command]
pub async fn import_apply(
    app: tauri::AppHandle,
    input: ImportApply,
) -> AppResult<crate::transfer::import::ImportResult> {
    blocking("import_apply", move || {
        let db = app.state::<Db>();
        let store = app.state::<AttachmentStore>();
        let sessions = app.state::<ImportSessions>();
        let t = std::time::Instant::now();
        let staged = {
            let mut list = sessions.0.lock().unwrap_or_else(|p| p.into_inner());
            let Some(pos) = list.iter().position(|s| s.id == input.session_id) else {
                return Err(AppError::NotFound("import".into()));
            };
            list.remove(pos)
        };
        let res = lock(&db).and_then(|mut c| {
            crate::transfer::import::apply_checked(
                &mut c,
                &store.root,
                &input.workspace_id,
                &staged,
                &input.columns,
                &input.target,
            )
        });
        if res.is_err() {
            // Keep it, so the user can fix the cause and try again.
            sessions
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(staged);
        }
        logged("import_apply", t, res)
    })
    .await
}

#[tauri::command]
pub fn import_cancel(sessions: State<'_, ImportSessions>, session_id: String) {
    sessions
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|s| s.id != session_id);
}

/// What exporting a page with these options would produce (one file or a zip, and which of the
/// dialog's choices apply).
#[tauri::command]
pub async fn export_shape(
    app: tauri::AppHandle,
    page_id: String,
    options: crate::transfer::export::ExportOptions,
) -> AppResult<crate::transfer::export::Shape> {
    worker::blocking("export_shape", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::transfer::export::shape(&conn, &page_id, &options)
    })
    .await
}

/// The page as it would be exported, for the preview.
#[tauri::command]
pub async fn export_page_preview(
    app: tauri::AppHandle,
    page_id: String,
    format: String,
) -> AppResult<crate::transfer::export::Preview> {
    worker::blocking("export_page_preview", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::transfer::export::preview(&conn, &page_id, &format)
    })
    .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageExported {
    #[serde(flatten)]
    pub written: crate::transfer::export::Written,
    pub file_name: String,
}

/// Exports a page as Notion does: Markdown & CSV or HTML (one file, or a zip when there is more
/// than one), or PDF (a single page).
#[tauri::command]
pub async fn export_page(
    app: tauri::AppHandle,
    page_id: String,
    options: crate::transfer::export::ExportOptions,
) -> AppResult<Option<PageExported>> {
    worker::dialog("export_page", move || {
        use crate::transfer::export::{self as ex, Sink};
        use tauri_plugin_dialog::DialogExt;
        let db = app.state::<Db>();
        let store = app.state::<AttachmentStore>();
        let shape = {
            let conn = lock(&db)?;
            ex::shape(&conn, &page_id, &options)?
        };
        let name = ex::safe_name(&shape.title);
        let t = std::time::Instant::now();
        let file_name = |p: &std::path::Path| {
            p.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        if options.format == "pdf" {
            if shape.kind == "database" {
                return Err(AppError::Validation(
                    "a database cannot be saved as a PDF; choose HTML or Markdown & CSV".into(),
                ));
            }
            let Some(file) = app
                .dialog()
                .file()
                .set_file_name(format!("{name}.pdf"))
                .add_filter("PDF", &["pdf"])
                .blocking_save_file()
            else {
                return Ok(None);
            };
            let file = path_of(file)?;
            let temp = crate::transfer::unzip::TempDir::new()?;
            let written = {
                let mut sink = Sink::Dir(temp.path().to_path_buf());
                let conn = lock(&db)?;
                let w = ex::export(
                    &conn,
                    &store.root,
                    &page_id,
                    &options,
                    &mut sink,
                    Some("page.html"),
                )?;
                sink.finish()?;
                w
            };
            let res = crate::transfer::pdf::print(&app, &temp.path().join("page.html"), &file).map(
                |()| {
                    Some(PageExported {
                        written,
                        file_name: file_name(&file),
                    })
                },
            );
            return logged("export_page", t, res);
        }
        let ext = if options.format == "html" {
            "html"
        } else {
            "md"
        };
        let res = if shape.needs_folder {
            let Some(file) = app
                .dialog()
                .file()
                .set_file_name(format!("{name}.zip"))
                .add_filter("Zip", &["zip"])
                .blocking_save_file()
            else {
                return Ok(None);
            };
            let file = path_of(file)?;
            // Written beside the destination first, so a failure never leaves half a zip behind.
            let partial = file.with_extension("zip.partial");
            let res = (|| {
                let mut sink = Sink::zip(&partial)?;
                let conn = lock(&db)?;
                let w = ex::export(&conn, &store.root, &page_id, &options, &mut sink, None)?;
                sink.finish()?;
                std::fs::rename(&partial, &file)?;
                Ok(w)
            })();
            if res.is_err() {
                let _ = std::fs::remove_file(&partial);
            }
            res.map(|written| PageExported {
                written,
                file_name: file_name(&file),
            })
        } else {
            let Some(file) = app
                .dialog()
                .file()
                .set_file_name(format!("{name}.{ext}"))
                .blocking_save_file()
            else {
                return Ok(None);
            };
            let file = path_of(file)?;
            let dir = file
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_default();
            let mut sink = Sink::Dir(dir);
            lock(&db)
                .and_then(|c| {
                    ex::export(
                        &c,
                        &store.root,
                        &page_id,
                        &options,
                        &mut sink,
                        Some(&file_name(&file)),
                    )
                })
                .and_then(|w| sink.finish().map(|()| w))
                .map(|written| PageExported {
                    written,
                    file_name: file_name(&file),
                })
        };
        logged("export_page", t, res.map(Some))
    })
    .await
}

/// Saves a theme through the native dialog; the webview cannot choose a filesystem path.
#[tauri::command]
pub async fn export_theme(app: tauri::AppHandle, json: String) -> AppResult<bool> {
    worker::dialog("export_theme", move || {
        use tauri_plugin_dialog::DialogExt;
        if json.len() > 128 * 1024 {
            return Err(AppError::Validation("theme file exceeds 128 KB".into()));
        }
        let theme: serde_json::Value = serde_json::from_str(&json)
            .map_err(|_| AppError::Validation("invalid theme JSON".into()))?;
        if theme["format"] != "suivelle-theme"
            || theme["version"] != 1
            || !theme["config"].is_object()
        {
            return Err(AppError::Validation("invalid theme file".into()));
        }
        let Some(file) = app
            .dialog()
            .file()
            .set_file_name("suivelle-theme.json")
            .add_filter("Suivelle theme", &["json"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        std::fs::write(path_of(file)?, json.as_bytes())?;
        Ok(true)
    })
    .await
}

/// Exports a database as CSV.
#[tauri::command]
pub async fn export_database(app: tauri::AppHandle, page_id: String) -> AppResult<Option<usize>> {
    worker::dialog("export_database", move || {
        let db = app.state::<Db>();
        use tauri_plugin_dialog::DialogExt;
        let t = std::time::Instant::now();
        let (title, bytes) =
            lock(&db).and_then(|c| crate::transfer::export::database_csv(&c, &page_id))?;
        let Some(file) = app
            .dialog()
            .file()
            .set_file_name(format!(
                "{}.csv",
                crate::transfer::export::safe_name(&title)
            ))
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let res = std::fs::write(path_of(file)?, &bytes)
            .map_err(AppError::from)
            .map(|()| Some(bytes.len()));
        logged("export_database", t, res)
    })
    .await
}

/// Exports the whole workspace as a portable zip.
#[tauri::command]
pub async fn export_workspace(
    app: tauri::AppHandle,
    workspace_id: String,
) -> AppResult<Option<WorkspaceExported>> {
    blocking("export_workspace", move || {
        let db = app.state::<Db>();
        let store = app.state::<AttachmentStore>();
        use tauri_plugin_dialog::DialogExt;
        validate_id(&workspace_id, "workspace")?;
        let name = lock(&db)
            .and_then(|c| {
                crate::repositories::workspace::get(&c, &workspace_id)?
                    .ok_or_else(|| AppError::NotFound("workspace".into()))
            })?
            .name;
        let Some(file) = app
            .dialog()
            .file()
            .set_file_name(format!(
                "{}-{}.zip",
                crate::transfer::export::safe_name(&name),
                chrono::Local::now().format("%Y-%m-%d")
            ))
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let file = path_of(file)?;
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|c| {
            crate::transfer::archive::export_workspace(&c, &store.root, &workspace_id, &file)
        });
        logged(
            "export_workspace",
            t,
            res.map(|counts| {
                Some(WorkspaceExported {
                    counts,
                    file_name: file
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "workspace.zip".into()),
                })
            }),
        )
    })
    .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExported {
    #[serde(flatten)]
    pub counts: crate::transfer::archive::Counts,
    pub file_name: String,
}

/// Applies only to the calling window. Unsupported platforms keep their system appearance.
#[tauri::command]
pub fn window_set_corners(window: tauri::WebviewWindow, corners: String) -> AppResult<bool> {
    let preference = corner_preference(&corners)?;
    #[cfg(windows)]
    {
        #[link(name = "dwmapi")]
        extern "system" {
            fn DwmSetWindowAttribute(
                hwnd: *mut std::ffi::c_void,
                attribute: u32,
                value: *const std::ffi::c_void,
                size: u32,
            ) -> i32;
        }
        let hwnd = window
            .hwnd()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        // DWM owns the radius and automatically removes rounding while maximized/snapped.
        let result = unsafe {
            DwmSetWindowAttribute(
                hwnd.0,
                33, // DWMWA_WINDOW_CORNER_PREFERENCE
                &preference as *const u32 as *const std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
        };
        Ok(result >= 0)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, preference);
        Ok(false)
    }
}

fn corner_preference(corners: &str) -> AppResult<u32> {
    let preference = match corners {
        "sharp" => 1,
        "soft" => 3,
        "round" => 2,
        _ => return Err(AppError::Validation("Unknown window corner style".into())),
    };
    Ok(preference)
}

#[cfg(test)]
mod corner_tests {
    #[test]
    fn window_corner_styles_use_distinct_native_preferences() {
        use super::corner_preference;
        for (choice, expected) in [("sharp", 1), ("soft", 3), ("round", 2)] {
            assert_eq!(corner_preference(choice).unwrap(), expected);
        }
        assert!(corner_preference("invalid").is_err());
    }
}

#[tauri::command]
pub async fn reminder_create(
    app: tauri::AppHandle,
    page_id: String,
    remind_at: String,
    note: String,
) -> AppResult<crate::reminders::Reminder> {
    blocking("reminder_create", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::reminders::create(&conn, &page_id, &remind_at, &note)
    })
    .await
}

#[tauri::command]
pub async fn reminder_delete(app: tauri::AppHandle, id: String) -> AppResult<()> {
    blocking("reminder_delete", move || {
        let db = app.state::<Db>();
        let conn = lock(&db)?;
        crate::reminders::delete(&conn, &id)
    })
    .await
}

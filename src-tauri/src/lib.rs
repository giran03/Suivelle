pub mod automation;
pub mod backup;
pub mod commands;
pub mod dashboards;
pub mod database;
pub mod databases;
pub mod domain;
pub mod errors;
pub mod files;
pub mod history;
mod legacy;
pub mod queries;
pub mod repositories;
pub mod search;
pub mod services;
pub mod shell;
pub mod shortcuts;
pub mod transfer;
pub mod updates;

#[cfg(test)]
mod performance;

use std::sync::Mutex;
use tauri::Manager;

fn init_logging(dir: &std::path::Path) {
    let _ = std::fs::create_dir_all(dir);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("suivelle.log"));
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false);
    // Logs never include document contents: commands log only name, duration and error code.
    match file {
        Ok(f) => builder.with_writer(Mutex::new(f)).init(),
        Err(_) => builder.init(),
    }
}

/// Whether the workspace allows automatic backups (on unless the setting says otherwise).
fn auto_backup_enabled(conn: &rusqlite::Connection) -> bool {
    repositories::workspace::list(conn)
        .map(|workspaces| {
            workspaces.iter().any(|w| {
                serde_json::from_str::<serde_json::Value>(&w.settings_json)
                    .ok()
                    .and_then(|v| v.get("autoBackup").and_then(serde_json::Value::as_bool))
                    .unwrap_or(true)
            })
        })
        .unwrap_or(false)
}

/// The daily automatic backup, taken in the background shortly after start-up so it never
/// delays the window.
fn spawn_auto_backup(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(20));
        let db = app.state::<database::Db>();
        let paths = app.state::<backup::Paths>();
        let enabled =
            db.0.lock()
                .map(|c| auto_backup_enabled(&c))
                .unwrap_or(false);
        if !enabled {
            return;
        }
        if updates::preparing() {
            return;
        }
        match backup::auto_backup(&db.0, &paths) {
            Ok(Some(info)) => tracing::info!(name = %info.name, "automatic backup created"),
            Ok(None) => {}
            Err(e) => tracing::warn!(error = %e, "automatic backup failed"),
        }
    });
}

/// Runs the automations that start with the app, catches up on schedules missed while it was
/// closed, then checks schedules and date triggers every half minute while it is open.
fn spawn_automation(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut sink = commands::notifier(&app);
        std::thread::sleep(std::time::Duration::from_secs(6));
        let mut first = true;
        loop {
            {
                let db = app.state::<database::Db>();
                let guard = db.0.lock();
                if let Ok(mut conn) = guard {
                    if updates::preparing() {
                        drop(conn);
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        continue;
                    }
                    let now = chrono::Local::now().naive_local();
                    let res = if first {
                        automation::schedule::on_start(&mut conn, now, &mut sink)
                    } else {
                        automation::schedule::tick(&mut conn, now, &mut sink)
                    };
                    match res {
                        Ok(n) if n > 0 => tracing::info!(runs = n, "automations started"),
                        Ok(_) => {}
                        Err(e) => tracing::warn!(error = %e, "automation scheduler failed"),
                    }
                }
            }
            first = false;
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    legacy::preserve_directories(context.config_mut());
    tauri::Builder::default()
        // Claim the instance before other plugins, database access or background jobs start.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::show_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![shell::AUTOSTART_ARG]),
        ))
        .manage(shell::ShellState::default())
        .manage(shortcuts::ShortcutState::default())
        .on_window_event(shell::on_window_event)
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        shortcuts::dispatch(app, shortcut);
                    }
                })
                .build(),
        )
        // Answered on a worker thread: building a thumbnail or reading a large file must not
        // block the window.
        .register_asynchronous_uri_scheme_protocol("attachment", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(files::protocol::respond(&app, &request)));
        })
        .setup(|app| {
            // Disable WebView2's browser menu, including embedded documents and media.
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| unsafe {
                    let result = webview
                        .controller()
                        .CoreWebView2()
                        .and_then(|view| view.Settings())
                        .and_then(|settings| settings.SetAreDefaultContextMenusEnabled(false));
                    if let Err(error) = result {
                        tracing::error!(%error, "could not disable the native context menu");
                    }
                })?;
            }
            let data_dir = app.path().app_data_dir()?.join("data");
            init_logging(&data_dir.join("logs"));
            let paths = backup::Paths::new(&data_dir);
            // Finish or undo a restore that was interrupted, before the database is opened.
            backup::recover(&paths);
            let conn = database::open(&paths.db())?;
            search::index::ensure_index(&conn)?;
            tracing::info!("workspace database ready");
            app.manage(database::Db(Mutex::new(conn)));
            app.manage(paths);
            app.manage(commands::PendingRestore::default());
            app.manage(commands::ImportSessions::default());
            updates::init(app.handle())?;
            shell::init(app.handle())?;
            spawn_auto_backup(app.handle().clone());
            spawn_automation(app.handle().clone());
            app.manage(files::AttachmentStore {
                root: data_dir.join("attachments"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            shortcuts::shortcuts_get,
            shortcuts::shortcuts_migrate,
            shortcuts::shortcuts_set,
            shortcuts::shortcuts_recording,
            updates::update_status,
            updates::update_preferences,
            updates::update_check,
            updates::update_download,
            updates::update_install,
            updates::update_changelog_presented,
            updates::update_open_releases,
            updates::update_window_visible,
            commands::window_set_corners,
            commands::image::image_info,
            commands::image::image_save_crop,
            commands::image::image_copy,
            commands::image::image_open_link,
            commands::export_page_preview,
            commands::export_shape,
            commands::workspace_create,
            commands::content::workspace_create_with_image,
            commands::workspace_update,
            commands::workspace_delete,
            commands::workspace_update_settings,
            commands::page_create,
            commands::page_update,
            commands::page_move,
            commands::page_restore,
            commands::page_delete_permanent,
            commands::trash_empty,
            commands::page_delete,
            commands::block_create,
            commands::block_update,
            commands::block_apply_batch,
            commands::attachment_import,
            commands::attachment_save_as,
            commands::content::attachment_import_bytes,
            commands::content::page_duplicate,
            commands::content::record_bulk_set,
            commands::content::quick_capture_shortcut,
            shell::shell_set_behavior,
            shell::shell_get_behavior,
            commands::content::attachment_list,
            commands::content::attachment_delete_unused,
            commands::content::markdown_to_blocks,
            commands::page_touch,
            commands::search_rebuild,
            commands::database_create,
            commands::property_create,
            commands::property_update,
            commands::property_delete,
            commands::record_create,
            commands::record_set_value,
            commands::template_create,
            commands::history_save_version,
            commands::form_submit,
            commands::import_pick,
            commands::import_apply,
            commands::workspace_import,
            commands::import_cancel,
            commands::export_page,
            commands::export_database,
            commands::export_theme,
            commands::export_workspace,
            commands::automation_save,
            commands::automation_set_enabled,
            commands::automation_delete,
            commands::automation_run_now,
            commands::button_press,
            commands::record_template_create,
            commands::record_template_update,
            commands::record_template_delete,
            commands::dashboard_create,
            commands::dashboard_save,
            commands::history_checkpoint,
            commands::history_restore,
            commands::backup_create,
            commands::backup_export,
            commands::backup_delete,
            commands::backup_pick,
            commands::backup_restore,
            commands::record_duplicate,
            commands::view_update,
            commands::view_create,
            commands::view_delete,
            commands::view_duplicate,
            commands::block_delete,
            queries::workspace_get,
            queries::workspace_list,
            queries::workspace_stats,
            commands::backup_set_auto,
            queries::page_get,
            queries::page_list_children,
            queries::page_ancestors,
            queries::page_list_favorites,
            queries::page_list_trash,
            queries::block_list,
            queries::search_workspace,
            queries::page_list_recent,
            queries::page_backlinks,
            queries::page_titles,
            queries::database_get,
            queries::record_get,
            queries::query_records,
            queries::group_counts,
            queries::record_lookup,
            queries::database_list,
            queries::formula_preview,
            queries::record_previews,
            queries::template_list,
            queries::history_list,
            queries::automation_list,
            queries::automation_runs,
            queries::chart_data,
            queries::record_template_list,
            queries::dashboard_get,
            queries::history_get,
            queries::backup_list,
            queries::backup_preview,
        ])
        .run(context)
        .expect("error while running Suivelle");
}

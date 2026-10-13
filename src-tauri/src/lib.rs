pub mod automation;
pub mod backup;
pub mod calendar;
#[cfg(test)]
mod calendar_tests;
pub mod commands;
pub mod dashboards;
pub mod database;
pub mod databases;
pub mod domain;
pub mod errors;
pub mod files;
pub mod history;
mod legacy;
pub mod maintenance;
pub mod queries;
pub mod reminders;
pub mod repositories;
pub mod search;
pub mod services;
pub mod shell;
pub mod shortcuts;
pub mod transfer;
pub mod updates;

#[cfg(test)]
mod fuzz;
#[cfg(test)]
mod performance;

use std::sync::Mutex;
use tauri::Manager;

/// The file marking a running session, removed on clean exit.
struct SessionMarker(std::path::PathBuf);

/// suivelle:// links that started the app, kept until the page is ready to open them.
#[derive(Default)]
struct PendingLinks(Mutex<Vec<String>>);

/// Links opened while the app runs go straight to the page; one that launched it waits for the
/// page to ask (see `deep_link_take`).
fn install_deep_links(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_deep_link::DeepLinkExt;
    // Installed builds get the scheme from the installer; development builds register themselves.
    #[cfg(debug_assertions)]
    let _ = app.deep_link().register_all();
    let pending = PendingLinks::default();
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        *pending.0.lock().unwrap_or_else(|e| e.into_inner()) =
            urls.into_iter().map(|u| u.to_string()).collect();
    }
    app.manage(pending);
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        shell::show_window(&handle);
        for url in event.urls() {
            let _ = tauri::Emitter::emit(&handle, "open-link", url.as_str());
        }
    });
    Ok(())
}

/// The links that launched the app, handed over once.
#[tauri::command]
fn deep_link_take(state: tauri::State<'_, PendingLinks>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Why the workspace opened read-only, if it did.
pub struct SafeMode(pub Option<String>);

/// The safe-mode reason, asked for before the page loads so every view starts read-only.
#[tauri::command]
fn app_safe_mode(state: tauri::State<'_, SafeMode>) -> Option<String> {
    state.0.clone()
}

/// The log is started afresh past this size; the previous one is kept as suivelle.log.1.
const LOG_LIMIT: u64 = 4 * 1024 * 1024;

fn init_logging(dir: &std::path::Path) {
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join("suivelle.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_LIMIT) {
        let _ = std::fs::rename(&path, dir.join("suivelle.log.1"));
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path);
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
    // A crash leaves its location in the log, so the next session's diagnostic report can show it.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        let message: String = message.chars().take(300).collect();
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()));
        tracing::error!(location = location.as_deref().unwrap_or("unknown"), %message, "panic");
        default_hook(info);
    }));
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
        let mut ticks = 0u32;
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
                    match reminders::fire_due(&conn, now).and_then(|mut due| {
                        due.extend(calendar::fire_due(&conn)?);
                        Ok(due)
                    }) {
                        Ok(due) => {
                            for r in due {
                                let title = if r.page_title.trim().is_empty() {
                                    "Untitled"
                                } else {
                                    r.page_title.trim()
                                };
                                let body = if r.note.is_empty() {
                                    "Reminder".to_string()
                                } else {
                                    r.note.clone()
                                };
                                sink(automation::engine::Notification {
                                    title: title.to_string(),
                                    body,
                                });
                                // The open window shows it too, with a way to jump to the page.
                                let _ = tauri::Emitter::emit(&app, "reminder-due", &r);
                            }
                        }
                        Err(e) => tracing::warn!(error = %e, "reminders failed"),
                    }
                    // Hourly, fold the write-ahead log back in so a long session does not keep
                    // the -wal file at its peak size until exit.
                    ticks = (ticks + 1) % 120;
                    if ticks == 0 {
                        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
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
        // Registered right after single-instance, which forwards links to the running window.
        .plugin(tauri_plugin_deep_link::init())
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
            files::protocol::spawn(move || {
                responder.respond(files::protocol::respond(&app, &request))
            });
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
            // Present while the app runs; left behind only by a crash or forced shutdown.
            let session = data_dir.join("session.open");
            // Never refuse to open: a failed check or migration opens the data read-only instead.
            let (conn, safe_mode) = match database::open_at_startup(&paths.db(), session.exists()) {
                Ok(conn) => (conn, None),
                Err(error) => {
                    tracing::error!(%error, "opening the workspace read-only");
                    let conn = database::open_read_only(&paths.db())
                        .or_else(|_| database::open_in_memory())?;
                    (conn, Some(error.to_string()))
                }
            };
            let _ = std::fs::write(&session, b"");
            app.manage(SessionMarker(session));
            if safe_mode.is_none() {
                search::index::ensure_index(&conn)?;
            }
            tracing::info!("workspace database ready");
            app.manage(database::Db(Mutex::new(conn)));
            app.manage(paths);
            app.manage(commands::PendingRestore::default());
            app.manage(commands::ImportSessions::default());
            updates::init(app.handle())?;
            shell::init(app.handle())?;
            if safe_mode.is_none() {
                spawn_auto_backup(app.handle().clone());
                spawn_automation(app.handle().clone());
            }
            app.manage(SafeMode(safe_mode));
            install_deep_links(app)?;
            app.manage(files::AttachmentStore {
                root: data_dir.join("attachments"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_safe_mode,
            deep_link_take,
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
            commands::remote::media_url_info,
            commands::remote::attachment_import_url,
            commands::attachment_save_as,
            commands::content::attachment_import_bytes,
            commands::content::page_duplicate,
            commands::content::record_bulk_set,
            commands::content::quick_capture_shortcut,
            shell::shell_set_behavior,
            shell::shell_get_behavior,
            shell::tray_set_recent,
            commands::content::attachment_list,
            commands::content::attachment_delete_unused,
            commands::content::markdown_to_blocks,
            commands::page_touch,
            commands::search_rebuild,
            commands::maintenance::maintenance_health,
            commands::maintenance::maintenance_sweep,
            commands::maintenance::maintenance_compact,
            commands::maintenance::maintenance_check,
            commands::maintenance::diagnostics_report,
            commands::backup_mirror_get,
            commands::backup_mirror_choose,
            commands::backup_mirror_clear,
            commands::reminder_create,
            commands::calendar::calendar_snapshot,
            commands::calendar::calendar_create,
            commands::calendar::calendar_save,
            commands::calendar::calendar_import,
            commands::reminder_delete,
            queries::reminder_list,
            queries::tag_list,
            queries::tag_pages,
            queries::link_graph,
            queries::page_unlinked_mentions,
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
        .build(context)
        .expect("error while building Suivelle")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let writable = app.try_state::<SafeMode>().is_some_and(|m| m.0.is_none());
                if let Some(db) = app.try_state::<database::Db>().filter(|_| writable) {
                    if let Ok(conn) = db.0.lock() {
                        database::close_cleanly(&conn);
                    }
                }
                if let Some(marker) = app.try_state::<SessionMarker>() {
                    let _ = std::fs::remove_file(&marker.0);
                }
            }
        });
}

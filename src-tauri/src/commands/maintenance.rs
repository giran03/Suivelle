//! Installation health: sizes, leftovers, compacting and the integrity check, from Settings.

use super::{lock, logged, worker::blocking};
use crate::backup::Paths;
use crate::database::Db;
use crate::errors::AppResult;
use crate::maintenance::{self, Health, Sweep};
use tauri::Manager;

#[tauri::command]
pub async fn maintenance_health(app: tauri::AppHandle) -> AppResult<Health> {
    blocking("maintenance_health", move || {
        let t = std::time::Instant::now();
        let res =
            lock(&app.state::<Db>()).and_then(|c| maintenance::health(&c, &app.state::<Paths>()));
        logged("maintenance_health", t, res)
    })
    .await
}

/// Removes the files nothing uses; the health report has already shown what that will free.
#[tauri::command]
pub async fn maintenance_sweep(app: tauri::AppHandle) -> AppResult<Sweep> {
    blocking("maintenance_sweep", move || {
        let t = std::time::Instant::now();
        let res = lock(&app.state::<Db>())
            .and_then(|c| maintenance::sweep(&c, &app.state::<Paths>(), true));
        logged("maintenance_sweep", t, res)
    })
    .await
}

/// Returns the database size before and after compacting.
#[tauri::command]
pub async fn maintenance_compact(app: tauri::AppHandle) -> AppResult<(u64, u64)> {
    blocking("maintenance_compact", move || {
        let t = std::time::Instant::now();
        let res =
            lock(&app.state::<Db>()).and_then(|c| maintenance::compact(&c, &app.state::<Paths>()));
        logged("maintenance_compact", t, res)
    })
    .await
}

/// Runs SQLite's integrity check now; "ok" when the database is sound.
#[tauri::command]
pub async fn maintenance_check(app: tauri::AppHandle) -> AppResult<String> {
    blocking("maintenance_check", move || {
        let t = std::time::Instant::now();
        let res = lock(&app.state::<Db>()).and_then(|c| crate::database::integrity(&c));
        logged("maintenance_check", t, res)
    })
    .await
}

/// A plain-text report to attach to a bug report: versions, sizes and the recent log. Logs hold
/// command names, timings and error codes, never document contents.
#[tauri::command]
pub async fn diagnostics_report(app: tauri::AppHandle) -> AppResult<String> {
    blocking("diagnostics_report", move || {
        use std::fmt::Write;
        let paths = app.state::<Paths>();
        let mut out = String::new();
        let _ = writeln!(out, "Suivelle {}", app.package_info().version);
        let _ = writeln!(
            out,
            "OS: {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        );
        let webview = tauri::webview_version().unwrap_or_else(|e| e.to_string());
        let _ = writeln!(out, "WebView2: {webview}");
        if let Some(reason) = app.state::<crate::SafeMode>().0.as_deref() {
            let _ = writeln!(out, "Safe mode: {reason}");
        }
        if let Ok(h) = lock(&app.state::<Db>()).and_then(|c| maintenance::health(&c, &paths)) {
            let _ = writeln!(
                out,
                "Storage: database {} B (+{} B log, {} B free), {} files {} B, {} backups, last {}",
                h.database_bytes,
                h.wal_bytes,
                h.reclaimable_bytes,
                h.attachments,
                h.attachment_bytes,
                h.backups,
                h.last_backup.as_deref().unwrap_or("never"),
            );
            let _ = writeln!(
                out,
                "Content: {} workspaces, {} pages ({} trashed), {} blocks, {} records",
                h.workspaces, h.pages, h.trashed_pages, h.blocks, h.records
            );
        }
        let log = std::fs::read_to_string(paths.data.join("logs").join("suivelle.log"))
            .unwrap_or_default();
        let lines: Vec<&str> = log.lines().collect();
        let _ = writeln!(out, "\nRecent log:");
        for line in &lines[lines.len().saturating_sub(200)..] {
            let _ = writeln!(out, "{line}");
        }
        Ok(out)
    })
    .await
}

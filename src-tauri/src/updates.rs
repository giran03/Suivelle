//! Signed NSIS updates. The webview cannot choose a feed, asset, or installer path.
use crate::{
    backup,
    commands::worker,
    database::Db,
    errors::{AppError, AppResult},
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const FEED: &str = "https://github.com/giran03/Suivelle/releases/latest/download/latest.json";
const ASSET_PREFIX: &str = "https://github.com/giran03/Suivelle/releases/download/";
const VERSION: &str = env!("CARGO_PKG_VERSION");
pub static INSTALLING: AtomicBool = AtomicBool::new(false);

pub fn preparing() -> bool {
    INSTALLING.load(Ordering::SeqCst)
}
struct UpdatePause;
impl Drop for UpdatePause {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::SeqCst);
    }
}
fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Release {
    pub version: String,
    pub date: String,
    pub notes: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub auto_check: bool,
    pub auto_download: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            auto_check: true,
            auto_download: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Disk {
    preferences: Preferences,
    observed_version: Option<String>,
    presented_version: Option<String>,
    last_check: Option<String>,
    installed: Option<Release>,
    attempt: Option<Attempt>,
    pending_changelog: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Attempt {
    from: String,
    release: Release,
    backup: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub installed: Release,
    pub preferences: Preferences,
    pub last_check: Option<String>,
    pub available: Option<Release>,
    pub ready: bool,
    pub pending_changelog: bool,
    pub unsupported: Option<String>,
    pub recovery_backup: Option<String>,
    pub installation_failed: bool,
}
pub struct Runtime {
    disk: Disk,
    pending: Option<Update>,
    bytes: Option<Vec<u8>>,
    disabled: Option<String>,
}
pub struct UpdateState {
    runtime: tauri::async_runtime::Mutex<Runtime>,
    file: PathBuf,
}

fn newer(candidate: &str, current: &str) -> bool {
    match (
        semver::Version::parse(candidate.trim_start_matches('v')),
        semver::Version::parse(current.trim_start_matches('v')),
    ) {
        (Ok(next), Ok(old)) => next.pre.is_empty() && next > old,
        _ => false,
    }
}

fn reconcile(disk: &mut Disk, bundled: &Release) {
    let changed = disk
        .observed_version
        .as_deref()
        .is_some_and(|old| newer(VERSION, old));
    let installed = disk
        .attempt
        .as_ref()
        .filter(|a| a.release.version == VERSION)
        .map(|a| a.release.clone());
    disk.installed = Some(installed.unwrap_or_else(|| bundled.clone()));
    disk.pending_changelog =
        (disk.pending_changelog || changed) && disk.presented_version.as_deref() != Some(VERSION);
    disk.observed_version = Some(VERSION.into());
}

fn save(file: &std::path::Path, disk: &Disk) -> AppResult<()> {
    use std::io::Write;
    let temporary = file.with_extension(format!("{}.tmp", uuid::Uuid::now_v7()));
    let result = (|| {
        let bytes = serde_json::to_vec(disk).map_err(|e| AppError::Internal(e.to_string()))?;
        let mut output = std::fs::File::create(&temporary)?;
        output.write_all(&bytes)?;
        output.sync_all()?;
        drop(output);
        std::fs::rename(&temporary, file)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

pub fn init(app: &AppHandle) -> AppResult<()> {
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(e.to_string()))?
        .join("data")
        .join("updates.json");
    let loaded: AppResult<Disk> = match std::fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| invalid("Update settings are damaged. Your workspace is unaffected.")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Disk::default()),
        Err(e) => Err(e.into()),
    };
    let (mut disk, mut disabled) = match loaded {
        Ok(disk) => (disk, None),
        Err(e) => (
            Disk::default(),
            Some(format!(
                "Updates are unavailable: {e}. Your workspace is unaffected."
            )),
        ),
    };
    let bundled: Release = serde_json::from_str(include_str!("../../release-notes.json"))
        .map_err(|e| AppError::Internal(e.to_string()))?;
    reconcile(&mut disk, &bundled);
    if disabled.is_none() {
        if let Err(e) = save(&file, &disk) {
            disabled = Some(format!(
                "Could not save update settings: {e}. Your workspace is unaffected."
            ));
        }
    }
    app.manage(UpdateState {
        file,
        runtime: tauri::async_runtime::Mutex::new(Runtime {
            disk,
            pending: None,
            bytes: None,
            disabled,
        }),
    });
    Ok(())
}

fn distribution_reason() -> Option<String> {
    if cfg!(debug_assertions) {
        return Some(
            "Development builds do not install updates. Use an installed release build.".into(),
        );
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentPackageFullName(length: *mut u32, name: *mut u16) -> i32;
        }
        let mut length = 0;
        // APPMODEL_ERROR_NO_PACKAGE is 15700; fail closed on every other result.
        if unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) } != 15700 {
            return Some("This Windows package updates through its original installer. View GitHub releases for manual updates.".into());
        }
        use winreg::{
            enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WOW64_64KEY},
            RegKey,
        };
        let eligible = (|| -> Option<()> {
            let key = RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags(
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Suivelle",
                    KEY_READ | KEY_WOW64_64KEY,
                )
                .ok()?;
            let location: String = key.get_value("InstallLocation").ok()?;
            let binary: String = key.get_value("MainBinaryName").ok()?;
            let installed = PathBuf::from(location.trim_matches('"'));
            let expected = installed.join(binary).canonicalize().ok()?;
            let actual = std::env::current_exe().ok()?.canonicalize().ok()?;
            (expected == actual && installed.join("uninstall.exe").is_file()).then_some(())
        })()
        .is_some();
        if eligible {
            return None;
        }
    }
    Some("Automatic installation supports Windows x64 NSIS installations. Update this copy manually from GitHub releases.".into())
}

fn snapshot(runtime: &Runtime) -> Snapshot {
    Snapshot {
        installed: runtime
            .disk
            .installed
            .clone()
            .expect("update state initialized"),
        preferences: runtime.disk.preferences.clone(),
        last_check: runtime.disk.last_check.clone(),
        available: runtime.pending.as_ref().map(release),
        ready: runtime.bytes.is_some(),
        pending_changelog: runtime.disk.pending_changelog,
        unsupported: runtime.disabled.clone().or_else(distribution_reason),
        recovery_backup: runtime.disk.attempt.as_ref().map(|a| a.backup.clone()),
        installation_failed: runtime
            .disk
            .attempt
            .as_ref()
            .is_some_and(|a| a.from == VERSION && a.release.version != VERSION),
    }
}
fn release(update: &Update) -> Release {
    Release {
        version: update.version.clone(),
        date: update
            .raw_json
            .get("pub_date")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        notes: update
            .body
            .clone()
            .unwrap_or_else(|| "No release notes were provided.".into()),
    }
}
fn validate_update(update: &Update) -> AppResult<()> {
    validate_metadata(
        &update.version,
        update.download_url.as_str(),
        update.body.as_deref(),
    )
}
fn validate_metadata(version: &str, url: &str, notes: Option<&str>) -> AppResult<()> {
    let expected_release = format!("{ASSET_PREFIX}v{version}/");
    if !newer(version, VERSION)
        || !url.starts_with(&expected_release)
        || !url.ends_with("-setup.exe")
        || notes.is_some_and(|n| n.len() > 64 * 1024)
    {
        return Err(invalid(
            "The release metadata is invalid. Installation has been blocked.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn update_status(app: AppHandle) -> AppResult<Snapshot> {
    let state = app.state::<UpdateState>();
    let runtime = state.runtime.lock().await;
    Ok(snapshot(&runtime))
}
#[tauri::command]
pub async fn update_preferences(app: AppHandle, preferences: Preferences) -> AppResult<Snapshot> {
    let state = app.state::<UpdateState>();
    let mut runtime = state
        .runtime
        .try_lock()
        .map_err(|_| invalid("Wait for the current update operation to finish."))?;
    if let Some(reason) = &runtime.disabled {
        return Err(invalid(reason.clone()));
    }
    let mut disk = runtime.disk.clone();
    disk.preferences = preferences;
    save(&state.file, &disk)?;
    runtime.disk = disk;
    Ok(snapshot(&runtime))
}
#[tauri::command]
pub async fn update_check(app: AppHandle) -> AppResult<Snapshot> {
    if let Some(reason) = distribution_reason() {
        return Err(invalid(reason));
    }
    let state = app.state::<UpdateState>();
    let mut runtime = state
        .runtime
        .try_lock()
        .map_err(|_| invalid("An update operation is already running."))?;
    if let Some(reason) = &runtime.disabled {
        return Err(invalid(reason.clone()));
    }
    if runtime.bytes.is_some() {
        return Ok(snapshot(&runtime));
    }
    let pending = app
        .updater_builder()
        .endpoints(vec![FEED.parse().expect("fixed HTTPS feed")])
        .map_err(|e| invalid(e.to_string()))?
        .timeout(Duration::from_secs(30))
        .version_comparator(|old, next| next.version.pre.is_empty() && next.version > old)
        .build()
        .map_err(|e| invalid(e.to_string()))?
        .check()
        .await
        .map_err(|e| invalid(format!("Could not check GitHub for updates: {e}")))?;
    if let Some(ref update) = pending {
        validate_update(update)?;
    }
    let mut disk = runtime.disk.clone();
    disk.last_check = Some(chrono::Utc::now().to_rfc3339());
    save(&state.file, &disk)?;
    runtime.disk = disk;
    runtime.pending = pending;
    Ok(snapshot(&runtime))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}
#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    on_progress: Channel<Progress>,
) -> AppResult<Snapshot> {
    if let Some(reason) = distribution_reason() {
        return Err(invalid(reason));
    }
    let state = app.state::<UpdateState>();
    let mut runtime = state
        .runtime
        .try_lock()
        .map_err(|_| invalid("An update operation is already running."))?;
    if let Some(reason) = &runtime.disabled {
        return Err(invalid(reason.clone()));
    }
    if runtime.bytes.is_some() {
        return Ok(snapshot(&runtime));
    }
    let update = runtime
        .pending
        .as_ref()
        .ok_or_else(|| invalid("Check for an update first."))?;
    validate_update(update)?;
    let mut downloaded = 0;
    let mut last_sent = std::time::Instant::now() - Duration::from_secs(1);
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if last_sent.elapsed() >= Duration::from_millis(150) || total == Some(downloaded) {
                    let _ = on_progress.send(Progress { downloaded, total });
                    last_sent = std::time::Instant::now();
                }
            },
            || {},
        )
        .await
        .map_err(|e| {
            invalid(format!(
                "Download or signature verification failed: {e}. Retry the download."
            ))
        })?;
    runtime.bytes = Some(bytes);
    Ok(snapshot(&runtime))
}

#[tauri::command]
pub async fn update_install(app: AppHandle, on_progress: Channel<String>) -> AppResult<()> {
    if let Some(reason) = distribution_reason() {
        return Err(invalid(reason));
    }
    let state = app.state::<UpdateState>();
    let mut runtime = state
        .runtime
        .try_lock()
        .map_err(|_| invalid("An update operation is already running."))?;
    if let Some(reason) = &runtime.disabled {
        return Err(invalid(reason.clone()));
    }
    let update = runtime
        .pending
        .clone()
        .ok_or_else(|| invalid("Check for an update first."))?;
    validate_update(&update)?;
    let bytes = runtime
        .bytes
        .as_ref()
        .ok_or_else(|| invalid("Download and verify the update first."))?
        .clone();
    let mut disk = runtime.disk.clone();
    let file = state.file.clone();
    let handle = app.clone();
    let result = worker::blocking("update_install", move || {
        if worker::dialog_active() {
            return Err(invalid(
                "Finish the open file operation before installing the update.",
            ));
        }
        let db = handle.state::<Db>();
        // Lock acquisition drains existing DB writes. Future jobs fail closed until handoff.
        {
            let _connection =
                db.0.lock()
                    .map_err(|_| invalid("Could not finish pending database writes."))?;
            worker::begin_update()?;
        }
        let _pause = UpdatePause;
        let prepared = (|| {
            let _ = on_progress.send("Creating safety backup…".into());
            let paths = handle.state::<backup::Paths>();
            let verified = backup::create_in_app(&db.0, &paths, "pre-update")?;
            disk.attempt = Some(Attempt {
                from: VERSION.into(),
                release: release(&update),
                backup: verified.name,
            });
            save(&file, &disk)?;
            let _ = on_progress.send("Installing update…".into());
            // The Windows plugin starts NSIS with /R and exits this process itself.
            update
                .install(&bytes)
                .map_err(|e| invalid(format!("Could not start the update installer: {e}")))
        })();
        prepared
    })
    .await;
    // On Windows success exits the app. Failure retains the verified download for retry.
    if let Ok(bytes) = std::fs::read(&state.file) {
        if let Ok(disk) = serde_json::from_slice(&bytes) {
            runtime.disk = disk;
        }
    }
    result
}

#[tauri::command]
pub async fn update_changelog_presented(app: AppHandle) -> AppResult<()> {
    let state = app.state::<UpdateState>();
    let mut runtime = state.runtime.lock().await;
    let mut disk = runtime.disk.clone();
    disk.presented_version = Some(VERSION.into());
    disk.pending_changelog = false;
    save(&state.file, &disk)?;
    runtime.disk = disk;
    Ok(())
}

#[tauri::command]
pub fn update_open_releases() -> AppResult<()> {
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe")
            .args([
                "url.dll,FileProtocolHandler",
                "https://github.com/giran03/Suivelle/releases",
            ])
            .spawn()?;
        return Ok(());
    }
    #[cfg(not(windows))]
    Err(invalid(
        "Open https://github.com/giran03/Suivelle/releases in your browser.",
    ))
}

#[tauri::command]
pub fn update_window_visible(app: AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_foreign_assets_wrong_installer_types_and_oversized_notes() {
        let asset = format!("{ASSET_PREFIX}v9.0.0/Suivelle_9.0.0_x64-setup.exe");
        assert!(validate_metadata("9.0.0", &asset, Some("Notes")).is_ok());
        assert!(validate_metadata("9.0.0", &asset.replace("/v9.0.0/", "/v8.0.0/"), None).is_err());
        assert!(validate_metadata("9.0.0-beta.1", &asset, None).is_err());
        assert!(validate_metadata(
            "9.0.0",
            "https://github.com/other/app/releases/download/v9/a-setup.exe",
            None
        )
        .is_err());
        assert!(validate_metadata("9.0.0", &asset.replace("-setup.exe", ".msi"), None).is_err());
        assert!(validate_metadata("9.0.0", &asset, Some(&"x".repeat(65537))).is_err());
    }
    fn bundled() -> Release {
        Release {
            version: VERSION.into(),
            date: String::new(),
            notes: "Installed notes".into(),
        }
    }
    #[test]
    fn stable_versions_only_and_no_downgrades() {
        assert!(newer("1.0.0", "0.9.9"));
        assert!(!newer("1.1.0-beta.1", "1.0.0"));
        assert!(!newer("1.0.0", "1.0.0"));
        assert!(!newer("bad", "1.0.0"));
        assert!(!newer("0.9.0", "1.0.0"));
    }
    #[test]
    fn fresh_install_and_failed_attempt_do_not_claim_update_success() {
        let mut disk = Disk::default();
        reconcile(&mut disk, &bundled());
        assert!(!disk.pending_changelog);
        disk.attempt = Some(Attempt {
            from: VERSION.into(),
            release: Release {
                version: "9.0.0".into(),
                ..bundled()
            },
            backup: "pre-update.zip".into(),
        });
        reconcile(&mut disk, &bundled());
        assert!(!disk.pending_changelog);
        assert!(
            snapshot(&Runtime {
                disk,
                pending: None,
                bytes: None,
                disabled: None
            })
            .installation_failed
        );
    }
    #[test]
    fn upgrade_is_queued_until_presented_even_after_another_launch() {
        let mut disk = Disk {
            observed_version: Some("0.0.1".into()),
            ..Disk::default()
        };
        reconcile(&mut disk, &bundled());
        assert!(disk.pending_changelog);
        reconcile(&mut disk, &bundled());
        assert!(disk.pending_changelog);
        disk.presented_version = Some(VERSION.into());
        reconcile(&mut disk, &bundled());
        assert!(!disk.pending_changelog);
    }
}

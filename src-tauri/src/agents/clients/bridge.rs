//! Where connected apps find `suivelle-mcp`.
//!
//! App configs store an absolute path, so the connector is copied to a folder that stays the same
//! across updates and install locations (`<local app data>/Suivelle/bin`), with an `app-path`
//! file beside it naming the Suivelle program the connector may start. Installed builds refresh
//! the copy when they start; development builds only when the user connects or repairs an app.

use crate::errors::{AppError, AppResult};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const NAME: &str = if cfg!(windows) {
    "suivelle-mcp.exe"
} else {
    "suivelle-mcp"
};

/// The connector shipped with this build: next to the Suivelle program (installers, `cargo
/// build -p suivelle-mcp`) or in a `bin` folder beside it.
pub fn bundled() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    [dir.join(NAME), dir.join("bin").join(NAME)]
        .into_iter()
        .find(|p| p.is_file())
}

/// The folder connected apps point at.
pub fn stable_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("Suivelle").join("bin"))
}

fn digest(path: &Path) -> Option<Vec<u8>> {
    std::fs::read(path)
        .ok()
        .map(|b| Sha256::digest(&b).to_vec())
}

/// Whether `dest` holds the same program as `source`.
pub fn current(source: &Path, dest: &Path) -> bool {
    matches!((digest(source), digest(dest)), (Some(a), Some(b)) if a == b)
}

/// Copies `source` into `dir` (unless it is already there) and records `app` beside it.
/// Returns the copy's path.
pub fn install(source: &Path, dir: &Path, app: Option<&Path>) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let dest = dir.join(NAME);
    if !current(source, &dest) {
        // A running connector cannot be overwritten on Windows, but it can be renamed.
        let old = dir.join(format!("{NAME}.old"));
        let _ = std::fs::remove_file(&old);
        if dest.exists() {
            std::fs::rename(&dest, &old)?;
        }
        let tmp = dir.join(format!(".{NAME}.tmp"));
        std::fs::copy(source, &tmp)?;
        std::fs::rename(&tmp, &dest)?;
        let _ = std::fs::remove_file(&old);
    }
    if let Some(app) = app {
        std::fs::write(dir.join("app-path"), app.to_string_lossy().as_bytes())?;
    }
    Ok(dest)
}

/// Installs this build's connector into the stable folder.
pub fn install_current() -> AppResult<PathBuf> {
    let source = bundled().ok_or_else(|| {
        AppError::Validation(
            "The suivelle-mcp connector is missing from this copy of Suivelle. Reinstall Suivelle, or build it with `cargo build -p suivelle-mcp`.".into(),
        )
    })?;
    let dir = stable_dir().ok_or_else(|| AppError::Internal("No local app-data folder.".into()))?;
    install(&source, &dir, std::env::current_exe().ok().as_deref())
}

/// At startup: keeps an existing stable copy in step with an installed (release) build, so apps
/// connected before an update keep working.
pub fn refresh_on_startup() {
    if cfg!(debug_assertions) {
        return;
    }
    let (Some(source), Some(dir)) = (bundled(), stable_dir()) else {
        return;
    };
    if !dir.join(NAME).exists() {
        return;
    }
    let app = std::env::current_exe().ok();
    let app_recorded = std::fs::read_to_string(dir.join("app-path")).ok();
    let app_changed = app
        .as_ref()
        .is_some_and(|a| app_recorded.as_deref() != Some(&*a.to_string_lossy()));
    if !current(&source, &dir.join(NAME)) || app_changed {
        if let Err(e) = install(&source, &dir, app.as_deref()) {
            tracing::warn!(error = %e, "could not refresh the suivelle-mcp connector");
        }
    }
}

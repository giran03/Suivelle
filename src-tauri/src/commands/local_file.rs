use crate::errors::{AppError, AppResult};
use std::path::{Path, PathBuf};

fn document_path(raw: &str) -> AppResult<PathBuf> {
    let path = Path::new(raw);
    if raw.len() > 4096
        || raw.chars().any(char::is_control)
        || !path.is_absolute()
        || raw.get(2..).is_some_and(|s| s.contains(':'))
    {
        return Err(AppError::Validation(
            "This file path is not supported on this computer.".into(),
        ));
    }
    let path = path.canonicalize().map_err(|_| {
        AppError::NotFound(
            "That file is missing or unavailable. You can still copy its path.".into(),
        )
    })?;
    if !path.is_file() {
        return Err(AppError::Validation(
            "This path does not point to a file.".into(),
        ));
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // Open documents only: shell associations must never launch pasted scripts or shortcuts.
    if [
        "exe",
        "com",
        "scr",
        "bat",
        "cmd",
        "ps1",
        "psm1",
        "msi",
        "msp",
        "cpl",
        "lnk",
        "url",
        "appref-ms",
        "vbs",
        "vbe",
        "js",
        "jse",
        "wsf",
        "wsh",
        "hta",
        "reg",
        "inf",
        "sh",
        "py",
        "pyw",
        "rb",
        "pl",
        "jar",
        "ahk",
        "pif",
        "scf",
        "application",
        "gadget",
    ]
    .contains(&ext.as_str())
    {
        return Err(AppError::Validation("Executable files and shortcuts cannot be opened from a file badge. Copy the path instead.".into()));
    }
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(unc) = raw.strip_prefix("\\\\?\\UNC\\") {
            return Ok(PathBuf::from(format!("\\\\{unc}")));
        }
        if let Some(drive) = raw.strip_prefix("\\\\?\\") {
            return Ok(PathBuf::from(drive));
        }
    }
    Ok(path)
}

#[tauri::command(async)]
pub fn local_file_open(path: String) -> AppResult<()> {
    let path = document_path(&path)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(path)
            .creation_flags(0x08000000)
            .spawn()?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(AppError::Validation(
            "Opening local file badges is supported on Windows. Copy the path instead.".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_relative_missing_and_executable_paths() {
        assert!(document_path("relative.txt").is_err());
        assert!(document_path("/missing/suivelle.txt").is_err());
        let dir = std::env::temp_dir().join(crate::domain::new_id());
        std::fs::create_dir(&dir).unwrap();
        let script = dir.join("test.CMD");
        std::fs::write(&script, "echo nope").unwrap();
        assert!(document_path(script.to_str().unwrap()).is_err());
        let doc = dir.join("notes.txt");
        std::fs::write(&doc, "notes").unwrap();
        assert!(document_path(doc.to_str().unwrap()).is_ok());
        std::fs::remove_file(script).unwrap();
        std::fs::remove_file(doc).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}

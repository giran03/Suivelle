//! Unpacking an imported zip (a Notion export, or any zip of notes) into a private temporary
//! folder, so the folder importers can read it like any other folder.
//!
//! Every entry name is checked before anything is written (no absolute paths, no `..`), sizes are
//! capped as they are copied (a zip can lie about them), and zips inside the zip, which is how
//! Notion splits large exports into parts, are unpacked into the same folder.

use crate::errors::{AppError, AppResult};
use crate::files::MAX_ATTACHMENT_BYTES;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

/// The most an import may unpack, in total.
pub const MAX_EXTRACT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 60_000;
/// Zips nested deeper than this are left packed.
const MAX_NESTING: usize = 2;

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

fn zip_err(e: impl std::fmt::Display) -> AppError {
    AppError::Validation(format!("the zip file could not be read: {e}"))
}

/// A folder that deletes itself (and everything in it) when dropped.
#[derive(Debug)]
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> AppResult<TempDir> {
        let dir = std::env::temp_dir().join(format!("suivelle-import-{}", crate::domain::new_id()));
        std::fs::create_dir_all(&dir)?;
        Ok(TempDir(dir.canonicalize().unwrap_or(dir)))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Whether the zip is a Suivelle archive (it has a manifest at its root).
pub fn is_suivelle_archive(path: &Path) -> bool {
    File::open(path)
        .ok()
        .and_then(|f| ZipArchive::new(f).ok())
        .is_some_and(|z| z.file_names().any(|n| n == "manifest.json"))
}

/// A relative path that is safe to create under the destination, or `None` to skip the entry.
fn safe_relative(name: &str) -> Option<PathBuf> {
    let name = name.replace('\\', "/");
    if name.starts_with('/') || name.contains(':') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in name.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            p if p.chars().any(char::is_control) => return None,
            p => out.push(p),
        }
    }
    let first = out
        .components()
        .next()?
        .as_os_str()
        .to_string_lossy()
        .into_owned();
    if first == "__MACOSX" || out.file_name().is_some_and(|f| f == ".DS_Store") {
        return None;
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

struct Budget {
    bytes: u64,
    entries: usize,
    warnings: Vec<String>,
}

impl Budget {
    fn warn(&mut self, m: String) {
        if self.warnings.len() < 20 {
            self.warnings.push(m);
        }
    }
}

fn unpack(zip_path: &Path, dest: &Path, depth: usize, budget: &mut Budget) -> AppResult<()> {
    let mut zip = ZipArchive::new(File::open(zip_path)?).map_err(zip_err)?;
    budget.entries += zip.len();
    if budget.entries > MAX_ENTRIES {
        return bad(format!(
            "this zip has more than {MAX_ENTRIES} files; export a smaller part at a time"
        ));
    }
    let mut nested: Vec<PathBuf> = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(zip_err)?;
        if entry.is_dir() {
            continue;
        }
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            continue; // a symbolic link
        }
        let Some(rel) = safe_relative(entry.name()) else {
            continue;
        };
        let declared = entry.size();
        if declared > MAX_ATTACHMENT_BYTES {
            budget.warn(format!(
                "“{}” is larger than 1 GB and was left out",
                rel.file_name().unwrap_or_default().to_string_lossy()
            ));
            continue;
        }
        let remaining = MAX_EXTRACT_BYTES.saturating_sub(budget.bytes);
        if declared > remaining {
            return bad("this zip unpacks to more than 4 GB; export a smaller part at a time");
        }
        let target = dest.join(&rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Two entries with the same name (from two parts): keep the first.
        if target.exists() {
            continue;
        }
        let mut out = File::create(&target)?;
        let limit = declared.min(remaining);
        let mut reader = (&mut entry).take(limit + 1);
        let written = std::io::copy(&mut reader, &mut out)?;
        out.flush()?;
        if written > limit {
            drop(out);
            let _ = std::fs::remove_file(&target);
            return bad("the zip file is damaged: an entry is larger than it says");
        }
        budget.bytes += written;
        let is_zip = rel
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("zip"));
        if is_zip && depth < MAX_NESTING {
            nested.push(target);
        }
    }
    drop(zip);
    for inner in nested {
        // Notion's "Part" zips each hold a slice of the same tree, so they all unpack in place.
        unpack(&inner, dest, depth + 1, budget)?;
        let _ = std::fs::remove_file(&inner);
    }
    Ok(())
}

/// Unpacks `path` into a new temporary folder. Returns the folder and anything left out.
pub fn extract(path: &Path) -> AppResult<(TempDir, Vec<String>)> {
    let dir = TempDir::new()?;
    let mut budget = Budget {
        bytes: 0,
        entries: 0,
        warnings: vec![],
    };
    unpack(path, dir.path(), 0, &mut budget)?;
    Ok((dir, budget.warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in files {
            w.start_file(*name, SimpleFileOptions::default()).unwrap();
            w.write_all(bytes).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn unsafe_names_are_skipped() {
        assert!(safe_relative("../evil.txt").is_none());
        assert!(safe_relative("a/../../evil.txt").is_none());
        assert!(safe_relative("/etc/passwd").is_none());
        assert!(safe_relative("C:/x.txt").is_none());
        assert!(safe_relative("__MACOSX/a.md").is_none());
        assert_eq!(
            safe_relative("a\\b.md"),
            Some(PathBuf::from("a").join("b.md"))
        );
    }

    #[test]
    fn nested_parts_unpack_into_one_tree() {
        let part1 = zip_bytes(&[("Home abc/One.md", b"# One")]);
        let part2 = zip_bytes(&[("Home abc/Two.md", b"# Two")]);
        let outer = zip_bytes(&[
            ("Export-1-Part-1.zip", &part1),
            ("Export-1-Part-2.zip", &part2),
            ("../escape.md", b"no"),
        ]);
        let src = TempDir::new().unwrap();
        let file = src.path().join("export.zip");
        std::fs::write(&file, outer).unwrap();
        assert!(!is_suivelle_archive(&file));
        let (dir, _) = extract(&file).unwrap();
        assert!(dir.path().join("Home abc/One.md").is_file());
        assert!(dir.path().join("Home abc/Two.md").is_file());
        assert!(!dir.path().join("Export-1-Part-1.zip").exists());
        assert!(!dir.path().parent().unwrap().join("escape.md").exists());
        let kept = dir.path().to_path_buf();
        drop(dir);
        assert!(!kept.exists(), "the temporary folder is removed");
    }

    #[test]
    fn long_paths_unpack() {
        let deep = format!(
            "{}/{}.md",
            ["Segment with a long name 0123456789abcdef0123456789abcdef"; 6].join("/"),
            "Leaf 0123456789abcdef0123456789abcdef"
        );
        let src = TempDir::new().unwrap();
        let file = src.path().join("long.zip");
        std::fs::write(&file, zip_bytes(&[(deep.as_str(), b"# Leaf")])).unwrap();
        let (dir, _) = extract(&file).unwrap();
        assert!(dir.path().join(&deep).is_file());
    }
}

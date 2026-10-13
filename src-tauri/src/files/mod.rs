//! Content-addressed attachment storage.
//!
//! Files are copied into `attachments/<hash[0..2]>/<sha256>`; the frontend only ever sees ids,
//! hashes and metadata, never filesystem paths. Identical content is stored once per workspace.

pub mod manage;
pub mod protocol;
pub mod remote;
pub mod thumb;

use crate::domain::{new_id, now, validate_id, Attachment};
use crate::errors::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub const MAX_ATTACHMENT_BYTES: u64 = 1024 * 1024 * 1024;

/// Managed by Tauri: where blobs live.
pub struct AttachmentStore {
    pub root: PathBuf,
}

/// Moves a file or folder. A plain rename is tried first; some folders (for example ones the
/// system encrypts or syncs) refuse it with "cannot move the file to a different disk drive", so
/// it then copies and removes instead. The original error is reported if that fails too.
pub fn move_path(from: &Path, to: &Path) -> std::io::Result<()> {
    let first = match std::fs::rename(from, to) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    let copied = if from.is_dir() {
        copy_dir(from, to).and_then(|()| std::fs::remove_dir_all(from))
    } else {
        std::fs::copy(from, to).and_then(|_| std::fs::remove_file(from))
    };
    copied.map_err(|_| first)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

pub fn is_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn blob_path(root: &Path, hash: &str) -> PathBuf {
    root.join(&hash[..2]).join(hash)
}

/// Kinds the editor can ask for, with the extensions offered in the native picker.
pub fn kind_extensions(kind: &str) -> AppResult<&'static [&'static str]> {
    Ok(match kind {
        "image" => &[
            "png", "apng", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg",
        ],
        "audio" => &["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"],
        "video" => &["mp4", "webm", "mov", "m4v", "ogv"],
        "pdf" => &["pdf"],
        "file" => &[],
        _ => {
            return Err(AppError::Validation(format!(
                "unknown attachment kind '{kind}'"
            )))
        }
    })
}

pub fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" | "apng" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn attachment_row(r: &rusqlite::Row) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        hash: r.get(2)?,
        original_name: r.get(3)?,
        mime_type: r.get(4)?,
        size: r.get(5)?,
        created_at: r.get(6)?,
    })
}

const COLS: &str = "id, workspace_id, hash, original_name, mime_type, size, created_at";

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<Attachment>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM attachment WHERE id = ?1"),
            [id],
            attachment_row,
        )
        .optional()?)
}

/// Looks up the stored content type and size for the URI-scheme handler.
pub fn meta_by_hash(conn: &Connection, hash: &str) -> AppResult<Option<(String, u64)>> {
    Ok(conn
        .query_row(
            "SELECT mime_type, size FROM attachment WHERE hash = ?1 LIMIT 1",
            [hash],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64)),
        )
        .optional()?)
}

/// Copies `src` into the store (hashing as it goes) and records it. Re-importing identical
/// content in the same workspace returns the existing attachment.
pub fn import_file(
    conn: &mut Connection,
    root: &Path,
    workspace_id: &str,
    src: &Path,
    kind: &str,
) -> AppResult<Attachment> {
    validate_id(workspace_id, "workspace")?;
    kind_extensions(kind)?;
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Validation("file has no usable name".into()))?
        .to_string();
    let mime = mime_for(&name);
    match kind {
        "image" | "audio" | "video" if !mime.starts_with(&format!("{kind}/")) => {
            return Err(AppError::Validation(format!(
                "'{name}' is not a supported {kind} file"
            )));
        }
        "pdf" if mime != "application/pdf" => {
            return Err(AppError::Validation(format!("'{name}' is not a PDF")));
        }
        _ => {}
    }

    let mut input = File::open(src)?;
    let (hash, size) = store_reader(root, &mut input, MAX_ATTACHMENT_BYTES)?;
    let tx = conn.transaction()?;
    let att = insert_attachment_in(&tx, workspace_id, &hash, &name, mime, size)?;
    tx.commit()?;
    Ok(att)
}

/// Streams `input` into the store (hashing as it goes) and returns its hash and size. Content
/// that is already stored is not written again.
pub fn store_reader(root: &Path, input: &mut dyn Read, limit: u64) -> AppResult<(String, u64)> {
    let tmp_dir = root.join("tmp");
    std::fs::create_dir_all(&tmp_dir)?;
    let tmp = tmp_dir.join(new_id());
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let written = (|| -> AppResult<()> {
        let mut out = File::create(&tmp)?;
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = input.read(&mut buf)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            if size > limit {
                return Err(AppError::Validation("file is larger than 1 GiB".into()));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])?;
        }
        out.sync_all()?;
        Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let hash: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let dest = blob_path(root, &hash);
    if dest.exists() {
        let _ = std::fs::remove_file(&tmp);
    } else {
        std::fs::create_dir_all(dest.parent().expect("blob path has a parent"))?;
        if let Err(e) = move_path(&tmp, &dest) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
    }
    Ok((hash, size))
}

/// Records a stored file in a workspace (or returns the record that is already there).
pub fn insert_attachment_in(
    tx: &Connection,
    workspace_id: &str,
    hash: &str,
    name: &str,
    mime: &str,
    size: u64,
) -> AppResult<Attachment> {
    if tx
        .query_row(
            "SELECT 1 FROM workspace WHERE id = ?1",
            [workspace_id],
            |_| Ok(()),
        )
        .optional()?
        .is_none()
    {
        return Err(AppError::NotFound("workspace".into()));
    }
    let existing = tx
        .query_row(
            &format!("SELECT {COLS} FROM attachment WHERE workspace_id = ?1 AND hash = ?2"),
            params![workspace_id, hash],
            attachment_row,
        )
        .optional()?;
    if let Some(a) = existing {
        return Ok(a);
    }
    let a = Attachment {
        id: new_id(),
        workspace_id: workspace_id.to_string(),
        hash: hash.to_string(),
        original_name: name.to_string(),
        mime_type: mime.to_string(),
        size: size as i64,
        created_at: now(),
    };
    tx.execute(
        "INSERT INTO attachment (id, workspace_id, hash, original_name, mime_type, size, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![a.id, a.workspace_id, a.hash, a.original_name, a.mime_type, a.size, a.created_at],
    )?;
    Ok(a)
}

/// Parses a single `bytes=a-b` range against a body of `len` bytes. Returns inclusive (start, end).
pub fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            if n == 0 {
                return None;
            }
            (len.saturating_sub(n), len - 1)
        }
        (start, "") => (start.parse().ok()?, len - 1),
        (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.min(len - 1)),
    };
    (start <= end && start < len).then_some((start, end))
}

/// Reads `[start, end]` (inclusive) of a stored blob.
pub fn read_range(root: &Path, hash: &str, start: u64, end: u64) -> AppResult<Vec<u8>> {
    let mut f = File::open(blob_path(root, hash))?;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0u8; (end - start + 1) as usize];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::open_in_memory;
    use crate::domain::WorkspaceCreate;
    use crate::services;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("tako-files-{}", new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn setup() -> (Connection, String, PathBuf) {
        let mut conn = open_in_memory().unwrap();
        let ws = services::workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "W".into(),
                icon: None,
                ..Default::default()
            },
        )
        .unwrap();
        (conn, ws.id, temp_dir())
    }

    #[test]
    fn imports_and_deduplicates_by_content() {
        let (mut conn, ws, dir) = setup();
        let a = dir.join("a.png");
        let b = dir.join("copy-of-a.png");
        std::fs::write(&a, b"\x89PNG fake image bytes").unwrap();
        std::fs::write(&b, b"\x89PNG fake image bytes").unwrap();
        let root = dir.join("attachments");
        let first = import_file(&mut conn, &root, &ws, &a, "image").unwrap();
        let second = import_file(&mut conn, &root, &ws, &b, "image").unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.mime_type, "image/png");
        assert_eq!(first.size, 21);
        assert!(is_hash(&first.hash));
        assert!(blob_path(&root, &first.hash).exists());
        assert!(std::fs::read_dir(root.join("tmp"))
            .unwrap()
            .next()
            .is_none());
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachment", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        assert_eq!(get(&conn, &first.id).unwrap().unwrap().hash, first.hash);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_kind_mismatch_and_unknown_kinds() {
        let (mut conn, ws, dir) = setup();
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, b"hello").unwrap();
        let root = dir.join("attachments");
        assert!(matches!(
            import_file(&mut conn, &root, &ws, &txt, "image"),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            import_file(&mut conn, &root, &ws, &txt, "pdf"),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            import_file(&mut conn, &root, &ws, &txt, "bogus"),
            Err(AppError::Validation(_))
        ));
        assert!(import_file(&mut conn, &root, &ws, &txt, "file").is_ok());
        assert!(matches!(
            import_file(&mut conn, &root, &new_id(), &txt, "file"),
            Err(AppError::NotFound(_))
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn hash_validation_blocks_path_tricks() {
        assert!(is_hash(&"a".repeat(64)));
        assert!(!is_hash(&"A".repeat(64)));
        assert!(!is_hash("../../etc/passwd"));
        assert!(!is_hash(&"g".repeat(64)));
        assert!(!is_hash(&"a".repeat(63)));
    }

    #[test]
    fn move_path_moves_files_and_folders_and_replaces_existing_files() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a.txt"), dir.join("b.txt"));
        std::fs::write(&a, "one").unwrap();
        std::fs::write(&b, "old").unwrap();
        move_path(&a, &b).unwrap();
        assert!(!a.exists());
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "one");
        let (src, dst) = (dir.join("src"), dir.join("dst"));
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("sub").join("f"), "x").unwrap();
        move_path(&src, &dst).unwrap();
        assert!(!src.exists());
        assert_eq!(
            std::fs::read_to_string(dst.join("sub").join("f")).unwrap(),
            "x"
        );
        assert!(move_path(&dir.join("missing"), &dir.join("elsewhere")).is_err());
        // The fallback path itself: copy then remove.
        let (s2, d2) = (dir.join("s2"), dir.join("d2"));
        std::fs::create_dir_all(s2.join("n")).unwrap();
        std::fs::write(s2.join("n").join("g"), "y").unwrap();
        copy_dir(&s2, &d2).unwrap();
        assert_eq!(
            std::fs::read_to_string(d2.join("n").join("g")).unwrap(),
            "y"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn parses_http_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=500-5000", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=5-1", 1000), None);
        assert_eq!(parse_range("bytes=0-1,5-9", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
        assert_eq!(parse_range("bytes=0-1", 0), None);
    }

    #[test]
    fn reads_byte_ranges_from_a_blob() {
        let (mut conn, ws, dir) = setup();
        let f = dir.join("clip.mp4");
        std::fs::write(&f, b"0123456789").unwrap();
        let root = dir.join("attachments");
        let att = import_file(&mut conn, &root, &ws, &f, "video").unwrap();
        assert_eq!(read_range(&root, &att.hash, 2, 5).unwrap(), b"2345");
        assert_eq!(
            meta_by_hash(&conn, &att.hash).unwrap(),
            Some(("video/mp4".to_string(), 10))
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
pub mod image_edit;

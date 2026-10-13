//! Backups: one verified `.takobak` file holding a consistent copy of the database plus every
//! attachment, with a manifest that can be read without unpacking anything.
//!
//! Layout of a file: the 8-byte magic `TAKOBAK1`, then entries (`1`, name length u16, name,
//! size u64, bytes) - the manifest first, then `workspace.db`, then `attachments/xx/<hash>` -
//! then a `0` byte and the SHA-256 of everything before the trailer. A file whose hash does not
//! match is never restored, and a new backup is re-read and verified before it is kept.
//!
//! Restoring takes a safety backup of the current data first, unpacks and checks the chosen
//! backup next to the live data, swaps the files while the connection is closed, and puts the old
//! files back if any step fails. A marker file lets the next start finish or undo a swap that was
//! interrupted.

#[cfg(test)]
mod tests;

use crate::database;
use crate::errors::{AppError, AppResult};
use chrono::{DateTime, Local, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAGIC: &[u8; 8] = b"TAKOBAK1";
pub const EXTENSION: &str = "takobak";
pub const KEEP_AUTO: usize = 3;
const MAX_NAME: usize = 200;
const CHUNK: usize = 256 * 1024;
const MANIFEST_LIMIT: u64 = 1 << 20;

pub struct Paths {
    pub data: PathBuf,
}

impl Paths {
    pub fn new(data: &Path) -> Paths {
        Paths { data: data.into() }
    }
    pub fn db(&self) -> PathBuf {
        self.data.join("workspace.db")
    }
    pub fn attachments(&self) -> PathBuf {
        self.data.join("attachments")
    }
    pub fn backups(&self) -> PathBuf {
        self.data.join("backups")
    }
    fn marker(&self) -> PathBuf {
        self.data.join("restore.pending")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub app_version: String,
    pub schema_version: i64,
    pub created_at: String,
    /// "auto", "manual", "export" or "safety".
    pub kind: String,
    pub workspace_name: String,
    pub pages: i64,
    pub attachments: i64,
    pub attachment_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// The file name inside the app's backup folder; empty for a file picked elsewhere.
    pub name: String,
    pub manifest: Manifest,
    pub size: u64,
}

/// What a restore would replace and bring in, shown before anything is touched.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub backup: BackupInfo,
    pub current_pages: i64,
    pub current_attachments: i64,
    /// The backup was made by a newer version and cannot be restored.
    pub too_new: bool,
}

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

fn io_err(e: std::io::Error) -> AppError {
    AppError::Internal(format!("backup file error: {e}"))
}

pub fn current_schema() -> i64 {
    database::latest_version()
}

// ---------------------------------------------------------------------------------------------
// archive format
// ---------------------------------------------------------------------------------------------

struct HashWriter<W: Write> {
    inner: W,
    hasher: Sha256,
}

impl<W: Write> HashWriter<W> {
    fn put(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.hasher.update(bytes);
        self.inner.write_all(bytes)
    }
    fn entry(&mut self, name: &str, size: u64, mut data: impl Read) -> AppResult<()> {
        if name.len() > MAX_NAME {
            return bad("a file name in the backup is too long");
        }
        self.put(&[1]).map_err(io_err)?;
        self.put(&(name.len() as u16).to_le_bytes())
            .map_err(io_err)?;
        self.put(name.as_bytes()).map_err(io_err)?;
        self.put(&size.to_le_bytes()).map_err(io_err)?;
        let mut left = size;
        let mut buf = vec![0u8; CHUNK];
        while left > 0 {
            let n = data.read(&mut buf[..take(left, CHUNK)]).map_err(io_err)?;
            if n == 0 {
                return Err(AppError::Internal(
                    "a file changed while it was being backed up".into(),
                ));
            }
            self.put(&buf[..n]).map_err(io_err)?;
            left -= n as u64;
        }
        Ok(())
    }
}

fn take(left: u64, cap: usize) -> usize {
    left.min(cap as u64) as usize
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A valid attachment entry name: `attachments/<two hex>/<64 hex>` with matching prefix.
fn attachment_entry(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("attachments/")?;
    let (dir, hash) = rest.split_once('/')?;
    (crate::files::is_hash(hash) && hash.starts_with(dir) && dir.len() == 2).then_some(hash)
}

struct EntryHeader {
    name: String,
    size: u64,
    data_at: u64,
}

fn read_entry_header(f: &mut (impl Read + Seek), limit: u64) -> AppResult<Option<EntryHeader>> {
    let mut tag = [0u8; 1];
    f.read_exact(&mut tag)
        .map_err(|_| AppError::Validation("this backup file is damaged".into()))?;
    if tag[0] == 0 {
        return Ok(None);
    }
    if tag[0] != 1 {
        return bad("this backup file is damaged");
    }
    let mut len = [0u8; 2];
    f.read_exact(&mut len).map_err(io_err)?;
    let len = u16::from_le_bytes(len) as usize;
    if len == 0 || len > MAX_NAME {
        return bad("this backup file is damaged");
    }
    let mut name = vec![0u8; len];
    f.read_exact(&mut name).map_err(io_err)?;
    let mut size = [0u8; 8];
    f.read_exact(&mut size).map_err(io_err)?;
    let size = u64::from_le_bytes(size);
    let data_at = f.stream_position().map_err(io_err)?;
    if data_at.checked_add(size).is_none_or(|end| end > limit) {
        return bad("this backup file is damaged");
    }
    let name = String::from_utf8(name)
        .map_err(|_| AppError::Validation("this backup file is damaged".into()))?;
    Ok(Some(EntryHeader {
        name,
        size,
        data_at,
    }))
}

/// Reads the whole file once and checks its trailing hash.
pub fn verify(path: &Path) -> AppResult<()> {
    let mut f = BufReader::new(File::open(path).map_err(io_err)?);
    let len = f.get_ref().metadata().map_err(io_err)?.len();
    if len < (MAGIC.len() + 1 + 32) as u64 {
        return bad("this is not a Suivelle backup");
    }
    let mut hasher = Sha256::new();
    let mut left = len - 32;
    let mut buf = vec![0u8; CHUNK];
    while left > 0 {
        let n = f.read(&mut buf[..take(left, CHUNK)]).map_err(io_err)?;
        if n == 0 {
            return bad("this backup file is damaged");
        }
        hasher.update(&buf[..n]);
        left -= n as u64;
    }
    let mut want = [0u8; 32];
    f.read_exact(&mut want).map_err(io_err)?;
    if hasher.finalize().as_slice() != want {
        return bad("this backup file is damaged: its checksum does not match");
    }
    Ok(())
}

fn read_manifest(path: &Path) -> AppResult<Manifest> {
    let mut f = File::open(path).map_err(io_err)?;
    let len = f.metadata().map_err(io_err)?.len();
    let mut magic = [0u8; 8];
    f.read_exact(&mut magic)
        .map_err(|_| AppError::Validation("this is not a Suivelle backup".into()))?;
    if &magic != MAGIC {
        return bad("this is not a Suivelle backup");
    }
    let Some(h) = read_entry_header(&mut f, len)? else {
        return bad("this backup file is empty");
    };
    if h.name != "manifest.json" || h.size > MANIFEST_LIMIT {
        return bad("this backup file is damaged");
    }
    let mut buf = vec![0u8; h.size as usize];
    f.read_exact(&mut buf).map_err(io_err)?;
    let m: Manifest = serde_json::from_slice(&buf)
        .map_err(|_| AppError::Validation("this backup file is damaged".into()))?;
    if m.format != 1 {
        return bad("this backup was made by a different version of the format");
    }
    Ok(m)
}

/// Reads a backup's manifest and checks the file's integrity.
pub fn inspect(path: &Path, name: &str) -> AppResult<BackupInfo> {
    let manifest = read_manifest(path)?;
    verify(path)?;
    let size = fs::metadata(path).map_err(io_err)?.len();
    Ok(BackupInfo {
        name: name.into(),
        manifest,
        size,
    })
}

// ---------------------------------------------------------------------------------------------
// creating
// ---------------------------------------------------------------------------------------------

/// A consistent copy of the database plus what the manifest needs, taken while the connection is held.
pub struct Pending {
    tmp_db: PathBuf,
    manifest: Manifest,
    hashes: Vec<String>,
}

fn new_token() -> String {
    uuid::Uuid::now_v7().simple().to_string()
}

/// Checks the database, copies it with `VACUUM INTO` (safe while the app is running) and gathers
/// the manifest. Hold the connection lock only for this call; `finish` does the slow part.
pub fn begin(conn: &Connection, paths: &Paths, kind: &str) -> AppResult<Pending> {
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(AppError::Internal(format!(
            "the database failed its integrity check ({check}); no backup was made"
        )));
    }
    fs::create_dir_all(paths.backups()).map_err(io_err)?;
    let tmp_db = paths.backups().join(format!(".tmp-{}.db", new_token()));
    conn.execute("VACUUM INTO ?1", [tmp_db.to_string_lossy().as_ref()])?;
    let (pages, attachments, bytes): (i64, i64, i64) = (
        conn.query_row(
            "SELECT COUNT(*) FROM page WHERE deleted_at IS NULL AND kind IN ('page', 'database', 'dashboard')",
            [],
            |r| r.get(0),
        )?,
        conn.query_row("SELECT COUNT(*) FROM attachment", [], |r| r.get(0))?,
        conn.query_row("SELECT COALESCE(SUM(size), 0) FROM attachment", [], |r| {
            r.get(0)
        })?,
    );
    let workspace_name: String = conn
        .query_row(
            "SELECT name FROM workspace ORDER BY created_at LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();
    let mut stmt = conn.prepare("SELECT DISTINCT hash FROM attachment")?;
    let hashes: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let schema_version: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )?;
    Ok(Pending {
        tmp_db,
        manifest: Manifest {
            format: 1,
            app_version: env!("CARGO_PKG_VERSION").into(),
            schema_version,
            created_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            kind: kind.into(),
            workspace_name,
            pages,
            attachments,
            attachment_bytes: bytes,
        },
        hashes,
    })
}

/// Writes the archive to `dest`, re-reads it to verify, and only then puts it in place.
pub fn finish(paths: &Paths, pending: Pending, dest: &Path) -> AppResult<BackupInfo> {
    let result = write_and_verify(paths, &pending, dest);
    let _ = fs::remove_file(&pending.tmp_db);
    result
}

fn write_and_verify(paths: &Paths, pending: &Pending, dest: &Path) -> AppResult<BackupInfo> {
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(io_err)?;
    }
    let part = dest.with_extension(format!("{EXTENSION}.part"));
    let written = (|| -> AppResult<()> {
        let mut w = HashWriter {
            inner: BufWriter::new(File::create(&part).map_err(io_err)?),
            hasher: Sha256::new(),
        };
        w.put(MAGIC).map_err(io_err)?;
        let manifest = serde_json::to_vec_pretty(&pending.manifest)
            .map_err(|e| AppError::Internal(e.to_string()))?;
        w.entry("manifest.json", manifest.len() as u64, manifest.as_slice())?;
        let db = File::open(&pending.tmp_db).map_err(io_err)?;
        let db_len = db.metadata().map_err(io_err)?.len();
        w.entry("workspace.db", db_len, db)?;
        for hash in &pending.hashes {
            let blob = crate::files::blob_path(&paths.attachments(), hash);
            // A file missing on disk is skipped rather than failing the whole backup.
            let Ok(f) = File::open(&blob) else {
                tracing::warn!("attachment file missing from disk; not included in backup");
                continue;
            };
            let len = f.metadata().map_err(io_err)?.len();
            w.entry(&format!("attachments/{}/{hash}", &hash[..2]), len, f)?;
        }
        w.put(&[0]).map_err(io_err)?;
        let digest = w.hasher.clone().finalize();
        w.inner.write_all(&digest).map_err(io_err)?;
        w.inner.flush().map_err(io_err)?;
        w.inner
            .into_inner()
            .map_err(|e| io_err(e.into_error()))?
            .sync_all()
            .map_err(io_err)?;
        Ok(())
    })();
    let verified = written.and_then(|()| inspect(&part, ""));
    match verified {
        Ok(mut info) => {
            crate::files::move_path(&part, dest).map_err(io_err)?;
            info.name = dest
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            Ok(info)
        }
        Err(e) => {
            let _ = fs::remove_file(&part);
            Err(e)
        }
    }
}

fn stamp() -> String {
    Utc::now().format("%Y%m%d-%H%M%S").to_string()
}

/// Makes a backup in the app's backup folder (the connection lock is held only for `begin`).
pub fn create_in_app(conn: &Mutex<Connection>, paths: &Paths, kind: &str) -> AppResult<BackupInfo> {
    let pending = {
        let c = conn
            .lock()
            .map_err(|_| AppError::Internal("database lock poisoned".into()))?;
        begin(&c, paths, kind)?
    };
    finish_in_app(paths, pending)
}

pub fn finish_in_app(paths: &Paths, pending: Pending) -> AppResult<BackupInfo> {
    let kind = &pending.manifest.kind;
    let dest = paths
        .backups()
        .join(format!("{kind}-{}.{EXTENSION}", stamp()));
    let dest = unique(dest);
    finish(paths, pending, &dest)
}

fn unique(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    (2..)
        .map(|n| path.with_file_name(format!("{stem}-{n}.{EXTENSION}")))
        .find(|p| !p.exists())
        .expect("an unused name exists")
}

// ---------------------------------------------------------------------------------------------
// listing, rotating
// ---------------------------------------------------------------------------------------------

/// Backups in the app's folder, newest first. Damaged or foreign files are skipped.
pub fn list(paths: &Paths) -> Vec<BackupInfo> {
    let Ok(dir) = fs::read_dir(paths.backups()) else {
        return Vec::new();
    };
    let mut out: Vec<BackupInfo> = dir
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == EXTENSION))
        .filter_map(|e| {
            let manifest = read_manifest(&e.path()).ok()?;
            let size = e.metadata().ok()?.len();
            Some(BackupInfo {
                name: e.file_name().to_string_lossy().into_owned(),
                manifest,
                size,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.manifest
            .created_at
            .cmp(&a.manifest.created_at)
            .then_with(|| b.name.cmp(&a.name))
    });
    out
}

/// A name that is safe to join onto the backup folder.
pub fn app_backup_path(paths: &Paths, name: &str) -> AppResult<PathBuf> {
    let ok = !name.is_empty()
        && name.len() <= MAX_NAME
        && !name.starts_with('.')
        && name.ends_with(&format!(".{EXTENSION}"))
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !ok {
        return bad("unknown backup");
    }
    let p = paths.backups().join(name);
    if !p.is_file() {
        return Err(AppError::NotFound("backup".into()));
    }
    Ok(p)
}

pub fn delete(paths: &Paths, name: &str) -> AppResult<()> {
    fs::remove_file(app_backup_path(paths, name)?).map_err(io_err)
}

/// Deletes automatic backups beyond the configured count. Called only after a new one has been
/// verified, so the newest known-good backup always remains.
pub fn rotate(paths: &Paths, keep: usize) -> usize {
    let autos: Vec<BackupInfo> = list(paths)
        .into_iter()
        .filter(|b| b.manifest.kind == "auto")
        .collect();
    let mut removed = 0;
    for b in autos.iter().skip(keep.max(1)) {
        if fs::remove_file(paths.backups().join(&b.name)).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Whether an automatic backup already exists for today (local time).
pub fn auto_backup_done_today(paths: &Paths, today: chrono::NaiveDate) -> bool {
    list(paths).iter().any(|b| {
        b.manifest.kind == "auto"
            && DateTime::parse_from_rfc3339(&b.manifest.created_at)
                .is_ok_and(|d| d.with_timezone(&Local).date_naive() == today)
    })
}

/// Makes the daily automatic backup if it is due, then rotates. Returns the new backup, if any.
pub fn auto_backup(conn: &Mutex<Connection>, paths: &Paths) -> AppResult<Option<BackupInfo>> {
    if auto_backup_done_today(paths, Local::now().date_naive()) {
        return Ok(None);
    }
    let info = create_in_app(conn, paths, "auto")?;
    let keep = {
        let conn = conn
            .lock()
            .map_err(|_| AppError::Internal("database lock poisoned".into()))?;
        crate::repositories::workspace::get_first(&conn)?
            .and_then(|w| serde_json::from_str::<serde_json::Value>(&w.settings_json).ok())
            .and_then(|v| v.get("backupKeep").and_then(serde_json::Value::as_u64))
            .filter(|n| (1..=1000).contains(n))
            .map(|n| n as usize)
            .unwrap_or(KEEP_AUTO)
    };
    rotate(paths, keep);
    // An unplugged drive or full share must never fail the backup itself.
    if let Err(error) = copy_to_mirror(paths, &info, keep) {
        tracing::warn!(error = %error, "could not copy the backup to the second folder");
    }
    Ok(Some(info))
}

/// A second folder, such as an external drive or a NAS share, that receives a copy of every
/// automatic backup. Chosen per device, so it lives beside the data rather than in a workspace.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mirror {
    pub folder: Option<String>,
}

fn mirror_file(paths: &Paths) -> PathBuf {
    paths.data.join("backup-mirror.json")
}

pub fn mirror(paths: &Paths) -> Mirror {
    fs::read_to_string(mirror_file(paths))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Remembers `folder` (or stops copying with `None`) after checking that it can be written to.
pub fn set_mirror(paths: &Paths, folder: Option<&Path>) -> AppResult<Mirror> {
    if let Some(folder) = folder {
        let probe = folder.join(format!(".suivelle-probe-{}", new_token()));
        fs::write(&probe, b"").map_err(|e| {
            AppError::Validation(format!("Suivelle cannot save files in that folder: {e}"))
        })?;
        let _ = fs::remove_file(probe);
    }
    let mirror = Mirror {
        folder: folder.map(|f| f.to_string_lossy().into_owned()),
    };
    fs::create_dir_all(&paths.data)?;
    let json = serde_json::to_string(&mirror).map_err(|e| AppError::Internal(e.to_string()))?;
    fs::write(mirror_file(paths), json)?;
    Ok(mirror)
}

/// Copies `info` into the second folder, if one is set, and keeps only its newest `keep`
/// automatic backups there. Files Suivelle did not name are never touched.
pub fn copy_to_mirror(paths: &Paths, info: &BackupInfo, keep: usize) -> AppResult<Option<PathBuf>> {
    let Some(folder) = mirror(paths).folder.map(PathBuf::from) else {
        return Ok(None);
    };
    let partial = folder.join(format!(".{}.partial", info.name));
    let dest = folder.join(&info.name);
    fs::copy(paths.backups().join(&info.name), &partial)?;
    fs::rename(&partial, &dest)?;
    let mut autos: Vec<String> = fs::read_dir(&folder)?
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with("auto-") && n.ends_with(&format!(".{EXTENSION}")))
        .collect();
    autos.sort_unstable_by(|a, b| b.cmp(a));
    for old in autos.iter().skip(keep.max(1)) {
        let _ = fs::remove_file(folder.join(old));
    }
    Ok(Some(dest))
}

// ---------------------------------------------------------------------------------------------
// restoring
// ---------------------------------------------------------------------------------------------

pub fn preview(conn: &Connection, path: &Path, name: &str) -> AppResult<RestorePreview> {
    let backup = inspect(path, name)?;
    let current_pages = conn.query_row(
        "SELECT COUNT(*) FROM page WHERE deleted_at IS NULL AND kind IN ('page', 'database', 'dashboard')",
        [],
        |r| r.get(0),
    )?;
    let current_attachments =
        conn.query_row("SELECT COUNT(*) FROM attachment", [], |r| r.get(0))?;
    let too_new = backup.manifest.schema_version > current_schema();
    Ok(RestorePreview {
        backup,
        current_pages,
        current_attachments,
        too_new,
    })
}

/// Unpacks `archive` into `staging`, checking every file against its name or the manifest.
fn extract(archive: &Path, staging: &Path) -> AppResult<()> {
    let mut f = BufReader::new(File::open(archive).map_err(io_err)?);
    let len = f.get_ref().metadata().map_err(io_err)?.len() - 32;
    f.seek(SeekFrom::Start(MAGIC.len() as u64))
        .map_err(io_err)?;
    let mut saw_db = false;
    while let Some(h) = read_entry_header(&mut f, len)? {
        let target = if h.name == "manifest.json" {
            f.seek(SeekFrom::Start(h.data_at + h.size))
                .map_err(io_err)?;
            continue;
        } else if h.name == "workspace.db" {
            saw_db = true;
            staging.join("workspace.db")
        } else if let Some(hash) = attachment_entry(&h.name) {
            staging.join("attachments").join(&hash[..2]).join(hash)
        } else {
            return bad("this backup contains an unexpected file");
        };
        fs::create_dir_all(target.parent().expect("target has a parent")).map_err(io_err)?;
        let mut out = BufWriter::new(File::create(&target).map_err(io_err)?);
        let mut hasher = Sha256::new();
        let mut left = h.size;
        let mut buf = vec![0u8; CHUNK];
        while left > 0 {
            let n = f.read(&mut buf[..take(left, CHUNK)]).map_err(io_err)?;
            if n == 0 {
                return bad("this backup file is damaged");
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(io_err)?;
            left -= n as u64;
        }
        out.flush().map_err(io_err)?;
        if let Some(hash) = attachment_entry(&h.name) {
            if hex(&hasher.finalize()) != hash {
                return bad("an attachment in this backup does not match its checksum");
            }
        }
    }
    if !saw_db {
        return bad("this backup has no database");
    }
    Ok(())
}

fn rename_if_exists(from: &Path, to: &Path) -> AppResult<()> {
    if from.exists() {
        crate::files::move_path(from, to).map_err(io_err)?;
    }
    Ok(())
}

const DB_SUFFIXES: [&str; 3] = ["", "-wal", "-shm"];

fn db_file(paths: &Paths, suffix: &str, old: bool) -> PathBuf {
    let name = format!("workspace.db{suffix}{}", if old { ".old" } else { "" });
    paths.data.join(name)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    /// The safety backup of the data that was replaced.
    pub safety_backup: String,
}

/// Replaces the live data with a backup. The connection inside `conn` is closed during the swap
/// and a connection to the restored data is put in its place.
pub fn restore(
    conn: &Mutex<Connection>,
    paths: &Paths,
    archive: &Path,
) -> AppResult<RestoreOutcome> {
    let info = {
        let c = conn
            .lock()
            .map_err(|_| AppError::Internal("database lock poisoned".into()))?;
        preview(&c, archive, "")?
    };
    if info.too_new {
        return bad(
            "this backup was made by a newer version of Suivelle and cannot be restored here",
        );
    }
    let safety = create_in_app(conn, paths, "safety")?;

    let staging = paths.data.join(format!("restore-staging-{}", new_token()));
    let prepared = (|| -> AppResult<()> {
        fs::create_dir_all(&staging).map_err(io_err)?;
        extract(archive, &staging)?;
        // Open the unpacked database: this checks it and brings an older schema up to date.
        let staged = database::open(&staging.join("workspace.db"))?;
        staged
            .pragma_update(None, "wal_checkpoint", "TRUNCATE")
            .ok();
        drop(staged);
        for s in ["-wal", "-shm"] {
            let _ = fs::remove_file(staging.join(format!("workspace.db{s}")));
        }
        Ok(())
    })();
    if let Err(e) = prepared {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }

    fs::write(
        paths.marker(),
        format!(
            "{{\"staging\":\"{}\"}}",
            staging.file_name().unwrap_or_default().to_string_lossy()
        ),
    )
    .map_err(io_err)?;
    let mut guard = conn
        .lock()
        .map_err(|_| AppError::Internal("database lock poisoned".into()))?;
    let placeholder = Connection::open_in_memory()?;
    let old_conn = std::mem::replace(&mut *guard, placeholder);
    drop(old_conn);

    let swap = (|| -> AppResult<()> {
        for s in DB_SUFFIXES {
            rename_if_exists(&db_file(paths, s, false), &db_file(paths, s, true))?;
        }
        rename_if_exists(&paths.attachments(), &paths.data.join("attachments.old"))?;
        crate::files::move_path(&staging.join("workspace.db"), &paths.db()).map_err(io_err)?;
        let staged_attachments = staging.join("attachments");
        if staged_attachments.exists() {
            crate::files::move_path(&staged_attachments, &paths.attachments()).map_err(io_err)?;
        } else {
            fs::create_dir_all(paths.attachments()).map_err(io_err)?;
        }
        *guard = database::open(&paths.db())?;
        Ok(())
    })();

    match swap {
        Ok(()) => {
            for s in DB_SUFFIXES {
                let _ = fs::remove_file(db_file(paths, s, true));
            }
            let _ = fs::remove_dir_all(paths.data.join("attachments.old"));
            let _ = fs::remove_dir_all(&staging);
            let _ = fs::remove_file(paths.marker());
            let _ = fs::remove_dir_all(paths.data.join("thumbnails"));
            Ok(RestoreOutcome {
                safety_backup: safety.name,
            })
        }
        Err(e) => {
            tracing::error!("restore failed; putting the previous data back");
            roll_back(paths);
            match database::open(&paths.db()) {
                Ok(c) => *guard = c,
                Err(open_err) => {
                    tracing::error!(error = %open_err, "could not reopen the previous database")
                }
            }
            let _ = fs::remove_dir_all(&staging);
            let _ = fs::remove_file(paths.marker());
            Err(e)
        }
    }
}

/// Puts the `.old` files back in place of whatever the swap managed to move in.
fn roll_back(paths: &Paths) {
    if !db_file(paths, "", true).exists() {
        return;
    }
    for s in DB_SUFFIXES {
        let _ = fs::remove_file(db_file(paths, s, false));
        let _ = rename_if_exists(&db_file(paths, s, true), &db_file(paths, s, false));
    }
    let old = paths.data.join("attachments.old");
    if old.exists() {
        let _ = fs::remove_dir_all(paths.attachments());
        let _ = crate::files::move_path(&old, &paths.attachments());
    }
}

/// At start-up: an unfinished restore (the app was closed during the swap) is undone from the
/// `.old` files, so the data is always whole. Returns whether anything was recovered.
pub fn recover(paths: &Paths) -> bool {
    if !paths.marker().exists() {
        return false;
    }
    tracing::warn!("an unfinished restore was found; restoring the previous data");
    roll_back(paths);
    if let Ok(dir) = fs::read_dir(&paths.data) {
        for e in dir.filter_map(Result::ok) {
            if e.file_name()
                .to_string_lossy()
                .starts_with("restore-staging-")
            {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
    let _ = fs::remove_file(paths.marker());
    true
}

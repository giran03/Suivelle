//! Installation health and storage upkeep: how big everything is, what can be reclaimed, and the
//! tools to reclaim it. Nothing here deletes a file that any attachment record still points at.

use crate::backup::{self, Paths};
use crate::errors::AppResult;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Files younger than this are left alone: an import or upload may still be about to record them.
const SETTLE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Health {
    pub database_bytes: u64,
    pub wal_bytes: u64,
    /// Space inside the database file that compacting would give back.
    pub reclaimable_bytes: u64,
    pub workspaces: i64,
    pub pages: i64,
    pub trashed_pages: i64,
    pub blocks: i64,
    pub records: i64,
    pub attachments: i64,
    pub attachment_bytes: i64,
    pub thumbnail_bytes: u64,
    pub search_documents: i64,
    pub backups: usize,
    pub backup_bytes: u64,
    pub last_backup: Option<String>,
    pub leftovers: Sweep,
}

/// Files nothing uses: stored blobs with no attachment record, thumbnails of those, and
/// abandoned temporary files.
#[derive(Debug, Default, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Sweep {
    pub files: u64,
    pub bytes: u64,
}

pub fn health(conn: &Connection, paths: &Paths) -> AppResult<Health> {
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0));
    let page_size = count("PRAGMA page_size")?;
    let backups = backup::list(paths);
    Ok(Health {
        database_bytes: size(&paths.db()),
        wal_bytes: size(&paths.db().with_extension("db-wal")),
        reclaimable_bytes: (count("PRAGMA freelist_count")? * page_size).max(0) as u64,
        workspaces: count("SELECT COUNT(*) FROM workspace")?,
        pages: count("SELECT COUNT(*) FROM page WHERE deleted_at IS NULL")?,
        trashed_pages: count("SELECT COUNT(*) FROM page WHERE deleted_at IS NOT NULL")?,
        blocks: count("SELECT COUNT(*) FROM block")?,
        records: count("SELECT COUNT(*) FROM db_record")?,
        attachments: count("SELECT COUNT(*) FROM attachment")?,
        attachment_bytes: count("SELECT COALESCE(SUM(size), 0) FROM attachment")?,
        thumbnail_bytes: files_in(&paths.data.join("thumbnails"))
            .iter()
            .map(|f| f.1)
            .sum(),
        search_documents: count("SELECT COUNT(*) FROM search_doc")?,
        backup_bytes: backups.iter().map(|b| b.size).sum(),
        last_backup: backups.iter().map(|b| b.manifest.created_at.clone()).max(),
        backups: backups.len(),
        leftovers: sweep(conn, paths, false)?,
    })
}

/// Measures (`apply == false`) or removes (`apply == true`) the files nothing uses.
pub fn sweep(conn: &Connection, paths: &Paths, apply: bool) -> AppResult<Sweep> {
    let known: HashSet<String> = conn
        .prepare("SELECT DISTINCT hash FROM attachment")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let now = SystemTime::now();
    let settled = |path: &Path| {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .is_ok_and(|t| now.duration_since(t).is_ok_and(|age| age >= SETTLE))
    };
    let attachments = paths.attachments();
    let mut unused: Vec<(PathBuf, u64)> = Vec::new();
    for (path, bytes) in files_in(&attachments) {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let in_tmp = path.parent() == Some(attachments.join("tmp").as_path());
        if (in_tmp || (crate::files::is_hash(name) && !known.contains(name))) && settled(&path) {
            unused.push((path, bytes));
        }
    }
    for (path, bytes) in files_in(&paths.data.join("thumbnails")) {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let hash = name.split('-').next().unwrap_or("");
        if !known.contains(hash) && settled(&path) {
            unused.push((path, bytes));
        }
    }
    for (path, bytes) in files_in(&paths.backups()) {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with(".tmp-") && settled(&path) {
            unused.push((path, bytes));
        }
    }
    let mut result = Sweep::default();
    for (path, bytes) in unused {
        if apply && std::fs::remove_file(&path).is_err() {
            continue;
        }
        result.files += 1;
        result.bytes += bytes;
    }
    if apply && result.files > 0 {
        tracing::info!(
            files = result.files,
            bytes = result.bytes,
            "removed unused files"
        );
    }
    Ok(result)
}

/// Rewrites the database without its free pages and folds the write-ahead log back in.
/// Returns the database size before and after.
pub fn compact(conn: &Connection, paths: &Paths) -> AppResult<(u64, u64)> {
    let before = size(&paths.db()) + size(&paths.db().with_extension("db-wal"));
    conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;")?;
    Ok((before, size(&paths.db())))
}

fn size(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |m| m.len())
}

/// Every file under `dir`, recursively, with its size.
fn files_in(dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                out.push((entry.path(), meta.len()));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database;

    fn age(path: &Path) {
        let old = SystemTime::now() - SETTLE - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(old)
            .unwrap();
    }

    #[test]
    fn sweep_removes_only_settled_files_nothing_records() {
        let root = std::env::temp_dir().join(format!("tako-sweep-{}", uuid::Uuid::now_v7()));
        let paths = Paths::new(&root);
        let mut conn = database::open(&paths.db()).unwrap();
        let ws = crate::services::workspace::create(
            &mut conn,
            crate::domain::WorkspaceCreate {
                name: "W".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let kept = crate::files::manage::import_bytes(
            &mut conn,
            &paths.attachments(),
            &ws.id,
            "kept.txt",
            b"kept",
        )
        .unwrap();
        let kept_path = crate::files::blob_path(&paths.attachments(), &kept.hash);
        age(&kept_path);
        let orphan_hash = "ab".repeat(32);
        let orphan = crate::files::blob_path(&paths.attachments(), &orphan_hash);
        std::fs::create_dir_all(orphan.parent().unwrap()).unwrap();
        std::fs::write(&orphan, b"orphaned bytes").unwrap();
        age(&orphan);
        let fresh = crate::files::blob_path(&paths.attachments(), &"cd".repeat(32));
        std::fs::create_dir_all(fresh.parent().unwrap()).unwrap();
        std::fs::write(&fresh, b"still being imported").unwrap();
        let thumb = root
            .join("thumbnails")
            .join("ab")
            .join(format!("{orphan_hash}-256-v2.png"));
        std::fs::create_dir_all(thumb.parent().unwrap()).unwrap();
        std::fs::write(&thumb, b"png").unwrap();
        age(&thumb);

        let preview = sweep(&conn, &paths, false).unwrap();
        assert_eq!(preview.files, 2);
        assert!(
            orphan.exists() && thumb.exists(),
            "a preview deletes nothing"
        );
        assert_eq!(health(&conn, &paths).unwrap().leftovers, preview);

        assert_eq!(sweep(&conn, &paths, true).unwrap(), preview);
        assert!(!orphan.exists() && !thumb.exists());
        assert!(kept_path.exists(), "recorded files stay");
        assert!(fresh.exists(), "recent files stay until they settle");
        drop(conn);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn health_counts_content_and_compact_reclaims_free_pages() {
        let root = std::env::temp_dir().join(format!("tako-health-{}", uuid::Uuid::now_v7()));
        let paths = Paths::new(&root);
        let conn = database::open(&paths.db()).unwrap();
        conn.execute_batch(
            "CREATE TABLE filler (x BLOB); INSERT INTO filler SELECT randomblob(4096) FROM
             (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) SELECT i FROM n);
             DROP TABLE filler; PRAGMA wal_checkpoint(TRUNCATE);",
        )
        .unwrap();
        let health = health(&conn, &paths).unwrap();
        assert_eq!(health.pages, 0);
        assert!(health.reclaimable_bytes > 1_000_000);
        let (before, after) = compact(&conn, &paths).unwrap();
        assert!(after < before);
        assert_eq!(super::health(&conn, &paths).unwrap().reclaimable_bytes, 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(root);
    }
}

use crate::errors::{AppError, AppResult};
use rusqlite::Connection;
use std::{path::Path, sync::Mutex, time::Duration};

/// Shared connection handle managed by Tauri.
pub struct Db(pub Mutex<Connection>);

/// (version, name, sql). Every schema change needs a new entry here.
const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "init", include_str!("../../migrations/0001_init.sql")),
    (
        2,
        "attachments",
        include_str!("../../migrations/0002_attachments.sql"),
    ),
    (
        3,
        "search",
        include_str!("../../migrations/0003_search.sql"),
    ),
    (
        4,
        "databases",
        include_str!("../../migrations/0004_databases.sql"),
    ),
    (
        5,
        "relations",
        include_str!("../../migrations/0005_relations.sql"),
    ),
    (
        6,
        "history",
        include_str!("../../migrations/0006_history.sql"),
    ),
    (
        7,
        "advanced_views",
        include_str!("../../migrations/0007_advanced_views.sql"),
    ),
    (
        8,
        "automation",
        include_str!("../../migrations/0008_automation.sql"),
    ),
    (
        9,
        "performance",
        include_str!("../../migrations/0009_performance.sql"),
    ),
    (
        10,
        "value_lookup",
        include_str!("../../migrations/0010_value_lookup.sql"),
    ),
    (
        11,
        "reminders_tags",
        include_str!("../../migrations/0011_reminders_tags.sql"),
    ),
    (
        12,
        "calendar",
        include_str!("../../migrations/0012_calendar.sql"),
    ),
    (
        13,
        "calendar_collections",
        include_str!("../../migrations/0013_calendar_collections.sql"),
    ),
];

/// The schema version a fully migrated database has.
pub fn latest_version() -> i64 {
    MIGRATIONS.last().map_or(0, |m| m.0)
}

pub fn open(path: &Path) -> AppResult<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    quick_check(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

/// Opens the workspace database at start-up. The integrity check, whose cost grows with the
/// database, runs only when the previous session did not close cleanly or a migration is about
/// to run. Restores and backup verification keep using `open`, which always checks.
pub fn open_at_startup(path: &Path, unclean_exit: bool) -> AppResult<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    let current = schema_version(&conn)?;
    let pending = current != latest_version();
    if unclean_exit || pending {
        quick_check(&conn)?;
    }
    if pending && current > 0 {
        snapshot_before_migration(&conn, path, current)?;
    }
    migrate(&mut conn)?;
    // Lets SQLite refresh planner statistics cheaply for this long-lived connection.
    conn.execute_batch("PRAGMA optimize = 0x10002")?;
    Ok(conn)
}

/// Opens the workspace without the ability to change it, for safe mode: when the integrity check
/// or a migration fails, the app still opens so the user can back up, export or restore.
pub fn open_read_only(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure(&conn)?;
    conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| {
        r.get::<_, i64>(0)
    })?;
    Ok(conn)
}

/// The newest migration applied, or 0 for a database that has none yet.
fn schema_version(conn: &Connection) -> AppResult<i64> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(0);
    }
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )?)
}

#[cfg(test)]
fn migration_pending(conn: &Connection) -> AppResult<bool> {
    Ok(schema_version(conn)? != latest_version())
}

/// How many pre-migration snapshots are kept beside the automatic backups.
const MIGRATION_SNAPSHOTS: usize = 3;

/// Copies the database before an upgrade changes its schema. If the copy cannot be made, the
/// upgrade does not run and the app opens read-only instead.
fn snapshot_before_migration(conn: &Connection, path: &Path, version: i64) -> AppResult<()> {
    let dir = path
        .parent()
        .unwrap_or(Path::new("."))
        .join("backups")
        .join("pre-migration");
    std::fs::create_dir_all(&dir)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%3f");
    let file = dir.join(format!("workspace-v{version}-{stamp}.db"));
    conn.execute("VACUUM INTO ?1", [file.to_string_lossy()])?;
    tracing::info!(version, file = %file.display(), "saved a copy before upgrading the database");
    let mut kept: Vec<_> = std::fs::read_dir(&dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "db"))
        .collect();
    kept.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    let excess = kept.len().saturating_sub(MIGRATION_SNAPSHOTS);
    for old in kept.into_iter().take(excess) {
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

/// Clean-exit housekeeping: refresh planner statistics and fold the WAL back into the database
/// so the next start has nothing to replay and the -wal file does not linger at its peak size.
pub fn close_cleanly(conn: &Connection) {
    if let Err(error) = conn.execute_batch("PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);") {
        tracing::warn!(%error, "database shutdown maintenance failed");
    }
}

pub fn open_in_memory() -> AppResult<Connection> {
    let mut conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> AppResult<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(Duration::from_millis(5000))?;
    // Sorted database views build temporary candidate tables; keep them off the disk.
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(())
}

/// SQLite's quick integrity check: "ok", or a description of what is wrong.
pub fn integrity(conn: &Connection) -> AppResult<String> {
    Ok(conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?)
}

fn quick_check(conn: &Connection) -> AppResult<()> {
    let result: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if result != "ok" {
        return Err(AppError::Internal(format!(
            "integrity check failed: {result}"
        )));
    }
    Ok(())
}

pub fn migrate(conn: &mut Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )",
    )?;
    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )?;
    if current > latest_version() {
        return Err(AppError::Validation("This database was opened by a newer version of Suivelle. Install that version or restore a compatible backup before opening it.".into()));
    }
    for (version, name, sql) in MIGRATIONS.iter().filter(|m| m.0 > current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        // Data a migration cannot derive in SQL alone.
        if *version == 11 {
            crate::search::index::backfill_tags(&tx)?;
        }
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![version, name, crate::domain::now()],
        )?;
        tx.commit()?;
        tracing::info!(version, name, "applied migration");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_newer_schema_without_changing_it() {
        let mut conn = open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO schema_migrations VALUES (?1, 'future', 't')",
            [latest_version() + 1],
        )
        .unwrap();
        assert!(migrate(&mut conn)
            .unwrap_err()
            .to_string()
            .contains("newer version"));
        let current: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(current, latest_version() + 1);
    }

    #[test]
    fn migrations_are_idempotent() {
        let mut conn = open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, MIGRATIONS.len() as i64);
    }

    #[test]
    fn performance_migration_upgrades_existing_pages_and_indexes_live_queries() {
        let mut conn = open_in_memory().unwrap();
        conn.execute_batch("DROP INDEX idx_page_live_position; DROP INDEX idx_page_live_children;
            DROP INDEX idx_db_value_cover;
            DELETE FROM schema_migrations WHERE version >= 9;
            INSERT INTO workspace (id,name,created_at,updated_at) VALUES ('w','Existing','t','t');
            INSERT INTO page (id,workspace_id,title,position,created_at,updated_at) VALUES ('p','w','Existing page',12,'t','t');").unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(
            crate::repositories::page::next_position(&conn, "w", None).unwrap(),
            13.0
        );
        let title: String = conn
            .query_row("SELECT title FROM page WHERE id = 'p'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "Existing page");
        for (query, index) in [
            ("EXPLAIN QUERY PLAN SELECT MAX(position) FROM page WHERE workspace_id = 'w' AND parent_page_id IS NULL AND deleted_at IS NULL", "idx_page_live_position"),
            ("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM page WHERE parent_page_id = 'p' AND deleted_at IS NULL AND kind <> 'record'", "idx_page_live_children"),
        ] {
            let plan: String = conn.query_row(query, [], |r| r.get(3)).unwrap();
            assert!(plan.contains(index), "{plan}");
        }
        let plan: String = conn.query_row("EXPLAIN QUERY PLAN SELECT value_json FROM db_value INDEXED BY idx_db_value_cover WHERE record_id = 'r' AND property_id = 'p'", [], |r| r.get(3)).unwrap();
        assert!(plan.contains("COVERING INDEX idx_db_value_cover"), "{plan}");
    }

    #[test]
    fn file_database_persists_and_uses_wal() {
        let dir = std::env::temp_dir().join(format!("tako-test-{}", uuid::Uuid::now_v7()));
        let path = dir.join("workspace.db");
        {
            let conn = open(&path).unwrap();
            let mode: String = conn
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap();
            assert_eq!(mode, "wal");
            conn.execute(
                "INSERT INTO workspace (id, name, created_at, updated_at) VALUES ('w','n','t','t')",
                [],
            )
            .unwrap();
        }
        let conn = open(&path).unwrap();
        let name: String = conn
            .query_row("SELECT name FROM workspace WHERE id='w'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "n");
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn startup_open_migrates_new_files_and_folds_the_wal_on_clean_close() {
        let dir = std::env::temp_dir().join(format!("tako-test-{}", uuid::Uuid::now_v7()));
        let path = dir.join("workspace.db");
        let conn = open_at_startup(&path, false).unwrap();
        assert!(!migration_pending(&conn).unwrap());
        let temp: i64 = conn
            .query_row("PRAGMA temp_store", [], |r| r.get(0))
            .unwrap();
        assert_eq!(temp, 2, "temporary tables stay in memory");
        conn.execute(
            "INSERT INTO workspace (id, name, created_at, updated_at) VALUES ('w','n','t','t')",
            [],
        )
        .unwrap();
        close_cleanly(&conn);
        let wal = std::fs::metadata(dir.join("workspace.db-wal")).map_or(0, |m| m.len());
        assert_eq!(wal, 0, "a clean close truncates the write-ahead log");
        drop(conn);
        // After an unclean exit the check runs and the data is still there.
        let conn = open_at_startup(&path, true).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_only_open_reads_but_refuses_writes() {
        let dir = std::env::temp_dir().join(format!("tako-test-{}", uuid::Uuid::now_v7()));
        let path = dir.join("workspace.db");
        let conn = open(&path).unwrap();
        conn.execute(
            "INSERT INTO workspace (id, name, created_at, updated_at) VALUES ('w','n','t','t')",
            [],
        )
        .unwrap();
        drop(conn);
        let ro = open_read_only(&path).unwrap();
        let name: String = ro
            .query_row("SELECT name FROM workspace", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "n");
        assert!(ro.execute("DELETE FROM workspace", []).is_err());
        drop(ro);
        assert!(open_read_only(&dir.join("missing.db")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn upgrades_snapshot_the_database_first_and_keep_the_latest_three() {
        let dir = std::env::temp_dir().join(format!("tako-test-{}", uuid::Uuid::now_v7()));
        let path = dir.join("workspace.db");
        let conn = open(&path).unwrap();
        conn.execute(
            "INSERT INTO workspace (id, name, created_at, updated_at) VALUES ('w','kept','t','t')",
            [],
        )
        .unwrap();
        for _ in 0..5 {
            snapshot_before_migration(&conn, &path, 9).unwrap();
            std::thread::sleep(Duration::from_millis(5));
        }
        let snapshots: Vec<_> = std::fs::read_dir(dir.join("backups/pre-migration"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(snapshots.len(), MIGRATION_SNAPSHOTS);
        let copy = Connection::open(&snapshots[0]).unwrap();
        let name: String = copy
            .query_row("SELECT name FROM workspace", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "kept");
        drop((conn, copy));
        let _ = std::fs::remove_dir_all(dir);
    }
}

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

pub fn open_in_memory() -> AppResult<Connection> {
    let mut conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> AppResult<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(Duration::from_millis(5000))?;
    Ok(())
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
}

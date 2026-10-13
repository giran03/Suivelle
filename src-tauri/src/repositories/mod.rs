use crate::domain::{Block, Page, Workspace};
use crate::errors::AppResult;
use rusqlite::{params, Connection, OptionalExtension, Row};

// ---------- workspace ----------

const WORKSPACE_COLS: &str =
    "id, name, icon, settings_json, schema_version, revision, created_at, updated_at";

fn workspace_row(r: &Row) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: r.get(0)?,
        name: r.get(1)?,
        icon: r.get(2)?,
        settings_json: r.get(3)?,
        schema_version: r.get(4)?,
        revision: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

pub mod workspace {
    use super::*;

    pub fn insert(conn: &Connection, w: &Workspace) -> AppResult<()> {
        conn.execute(
            "INSERT INTO workspace (id, name, icon, settings_json, schema_version, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![w.id, w.name, w.icon, w.settings_json, w.schema_version, w.revision, w.created_at, w.updated_at],
        )?;
        Ok(())
    }

    pub fn get(conn: &Connection, id: &str) -> AppResult<Option<Workspace>> {
        Ok(conn
            .query_row(
                &format!("SELECT {WORKSPACE_COLS} FROM workspace WHERE id = ?1"),
                [id],
                workspace_row,
            )
            .optional()?)
    }

    pub fn get_first(conn: &Connection) -> AppResult<Option<Workspace>> {
        Ok(conn
            .query_row(
                &format!("SELECT {WORKSPACE_COLS} FROM workspace ORDER BY created_at, id LIMIT 1"),
                [],
                workspace_row,
            )
            .optional()?)
    }

    pub fn list(conn: &Connection) -> AppResult<Vec<Workspace>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT {WORKSPACE_COLS} FROM workspace ORDER BY created_at, id"
        ))?;
        let rows = stmt
            .query_map([], workspace_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn stats(conn: &Connection, id: &str) -> AppResult<crate::domain::WorkspaceStats> {
        Ok(conn.query_row(
            "SELECT COALESCE(SUM(kind='page'),0), COALESCE(SUM(kind='record'),0), COALESCE(SUM(kind='database'),0), COALESCE(SUM(kind='dashboard'),0), COALESCE(SUM(deleted_at IS NOT NULL),0) FROM page WHERE workspace_id=?1",
            [id], |r| Ok(crate::domain::WorkspaceStats { pages: r.get(0)?, records: r.get(1)?, databases: r.get(2)?, dashboards: r.get(3)?, trashed: r.get(4)? }),
        )?)
    }

    pub fn update_profile(
        conn: &Connection,
        id: &str,
        name: &str,
        icon: Option<&str>,
        settings_json: &str,
        now: &str,
    ) -> AppResult<usize> {
        Ok(conn.execute(
            "UPDATE workspace SET name = ?2, icon = ?3, settings_json = ?5, revision = revision + 1, updated_at = ?4 WHERE id = ?1",
            params![id, name, icon, now, settings_json],
        )?)
    }

    pub fn count(conn: &Connection) -> AppResult<i64> {
        Ok(conn.query_row("SELECT COUNT(*) FROM workspace", [], |r| r.get(0))?)
    }

    /// Hard delete; pages and blocks follow via ON DELETE CASCADE.
    pub fn delete(conn: &Connection, id: &str) -> AppResult<usize> {
        Ok(conn.execute("DELETE FROM workspace WHERE id = ?1", [id])?)
    }

    pub fn update_settings(
        conn: &Connection,
        id: &str,
        settings_json: &str,
        now: &str,
    ) -> AppResult<usize> {
        Ok(conn.execute(
            "UPDATE workspace SET settings_json = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?1",
            params![id, settings_json, now],
        )?)
    }
}

// ---------- page ----------

const PAGE_COLS: &str =
    "id, workspace_id, parent_page_id, title, icon, cover, position, favorite, archived, deleted_at, revision, created_at, updated_at, kind";
/// Read projection: the stored columns plus the derived live child count.
const PAGE_SELECT: &str = "id, workspace_id, parent_page_id, title, icon, cover, position, favorite, archived, deleted_at, revision, created_at, updated_at, kind,
    (SELECT COUNT(*) FROM page c WHERE c.parent_page_id = page.id AND c.deleted_at IS NULL AND c.kind <> 'record')";

fn page_row(r: &Row) -> rusqlite::Result<Page> {
    Ok(Page {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        parent_page_id: r.get(2)?,
        title: r.get(3)?,
        icon: r.get(4)?,
        cover: r.get(5)?,
        position: r.get(6)?,
        favorite: r.get(7)?,
        archived: r.get(8)?,
        deleted_at: r.get(9)?,
        revision: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
        kind: r.get(13)?,
        child_count: r.get(14)?,
    })
}

pub mod page {
    use super::*;

    pub fn insert(conn: &Connection, p: &Page) -> AppResult<()> {
        conn.execute(
            &format!("INSERT INTO page ({PAGE_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"),
            params![
                p.id,
                p.workspace_id,
                p.parent_page_id,
                p.title,
                p.icon,
                p.cover,
                p.position,
                p.favorite,
                p.archived,
                p.deleted_at,
                p.revision,
                p.created_at,
                p.updated_at,
                p.kind
            ],
        )?;
        Ok(())
    }

    pub fn get(conn: &Connection, id: &str) -> AppResult<Option<Page>> {
        Ok(conn
            .query_row(
                &format!("SELECT {PAGE_SELECT} FROM page WHERE id = ?1"),
                [id],
                page_row,
            )
            .optional()?)
    }

    /// Next append position among live siblings.
    pub fn next_position(
        conn: &Connection,
        workspace_id: &str,
        parent: Option<&str>,
    ) -> AppResult<f64> {
        let max: Option<f64> = conn.query_row(
            "SELECT MAX(position) FROM page WHERE workspace_id = ?1 AND parent_page_id IS ?2 AND deleted_at IS NULL",
            params![workspace_id, parent],
            |r| r.get(0),
        )?;
        Ok(max.map_or(0.0, |m| m + 1.0))
    }

    pub fn update(conn: &Connection, p: &Page) -> AppResult<()> {
        conn.execute(
            "UPDATE page SET title = ?2, icon = ?3, cover = ?4, position = ?5, favorite = ?6, archived = ?7,
                    revision = revision + 1, updated_at = ?8
             WHERE id = ?1",
            params![p.id, p.title, p.icon, p.cover, p.position, p.favorite, p.archived, p.updated_at],
        )?;
        Ok(())
    }

    /// Soft-deletes a page and all of its descendants. Returns the number of pages affected.
    pub fn soft_delete_tree(conn: &Connection, id: &str, now: &str) -> AppResult<usize> {
        Ok(conn.execute(
            "WITH RECURSIVE tree(id) AS (
                 SELECT id FROM page WHERE id = ?1
                 UNION ALL
                 SELECT p.id FROM page p JOIN tree t ON p.parent_page_id = t.id
             )
             UPDATE page SET deleted_at = ?2, revision = revision + 1, updated_at = ?2
             WHERE id IN (SELECT id FROM tree) AND deleted_at IS NULL",
            params![id, now],
        )?)
    }

    pub fn set_parent_position(
        conn: &Connection,
        id: &str,
        parent: Option<&str>,
        position: f64,
        now: &str,
    ) -> AppResult<()> {
        conn.execute(
            "UPDATE page SET parent_page_id = ?2, position = ?3, revision = revision + 1, updated_at = ?4 WHERE id = ?1",
            params![id, parent, position, now],
        )?;
        Ok(())
    }

    /// Raw position write used when renumbering siblings; does not bump the revision.
    pub fn set_position(conn: &Connection, id: &str, position: f64) -> AppResult<()> {
        conn.execute(
            "UPDATE page SET position = ?2 WHERE id = ?1",
            params![id, position],
        )?;
        Ok(())
    }

    /// True when `candidate` is `root` itself or lives anywhere beneath it.
    pub fn in_subtree(conn: &Connection, root: &str, candidate: &str) -> AppResult<bool> {
        let n: i64 = conn.query_row(
            "WITH RECURSIVE tree(id) AS (
                 SELECT id FROM page WHERE id = ?1
                 UNION ALL
                 SELECT p.id FROM page p JOIN tree t ON p.parent_page_id = t.id
             )
             SELECT COUNT(*) FROM tree WHERE id = ?2",
            params![root, candidate],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn list_favorites(conn: &Connection, workspace_id: &str) -> AppResult<Vec<Page>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT {PAGE_SELECT} FROM page
             WHERE workspace_id = ?1 AND favorite = 1 AND deleted_at IS NULL
             ORDER BY title COLLATE NOCASE, id"
        ))?;
        let rows = stmt.query_map([workspace_id], page_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Roots of trashed batches: trashed pages whose parent was not trashed in the same operation.
    pub fn list_trash(conn: &Connection, workspace_id: &str) -> AppResult<Vec<Page>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT {PAGE_SELECT} FROM page
             WHERE workspace_id = ?1 AND deleted_at IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM page par WHERE par.id = page.parent_page_id AND par.deleted_at = page.deleted_at)
             ORDER BY deleted_at DESC, id"
        ))?;
        let rows = stmt.query_map([workspace_id], page_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Restores the page and the descendants that were trashed together with it.
    pub fn restore_tree(
        conn: &Connection,
        id: &str,
        deleted_at: &str,
        now: &str,
    ) -> AppResult<usize> {
        Ok(conn.execute(
            "WITH RECURSIVE tree(id) AS (
                 SELECT id FROM page WHERE id = ?1
                 UNION ALL
                 SELECT p.id FROM page p JOIN tree t ON p.parent_page_id = t.id
             )
             UPDATE page SET deleted_at = NULL, revision = revision + 1, updated_at = ?3
             WHERE id IN (SELECT id FROM tree) AND deleted_at = ?2",
            params![id, deleted_at, now],
        )?)
    }

    /// Hard delete of a page; descendants and blocks follow via ON DELETE CASCADE.
    pub fn hard_delete(conn: &Connection, id: &str) -> AppResult<usize> {
        Ok(conn.execute("DELETE FROM page WHERE id = ?1", [id])?)
    }

    pub fn hard_delete_trashed(conn: &Connection, workspace_id: &str) -> AppResult<usize> {
        Ok(conn.execute(
            "DELETE FROM page WHERE workspace_id = ?1 AND deleted_at IS NOT NULL",
            [workspace_id],
        )?)
    }

    /// Content edits count as modifying the page (used by the "modified" search filter).
    pub fn touch_updated(conn: &Connection, id: &str, now: &str) -> AppResult<()> {
        conn.execute(
            "UPDATE page SET updated_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        Ok(())
    }

    /// Records that a page was opened. Does not change revision or updated_at.
    pub fn touch_opened(conn: &Connection, id: &str, now: &str) -> AppResult<usize> {
        Ok(conn.execute(
            "UPDATE page SET last_opened_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now],
        )?)
    }

    pub fn list_recent(conn: &Connection, workspace_id: &str, limit: i64) -> AppResult<Vec<Page>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT {PAGE_SELECT} FROM page
             WHERE workspace_id = ?1 AND last_opened_at IS NOT NULL AND deleted_at IS NULL
             ORDER BY last_opened_at DESC LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![workspace_id, limit], page_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The page and every descendant, trashed or not.
    pub fn subtree_ids(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
        let mut stmt = conn.prepare(
            "WITH RECURSIVE tree(id) AS (
                 SELECT id FROM page WHERE id = ?1
                 UNION ALL
                 SELECT p.id FROM page p JOIN tree t ON p.parent_page_id = t.id
             ) SELECT id FROM tree",
        )?;
        let rows = stmt.query_map([id], |r| r.get(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn trashed_ids(conn: &Connection, workspace_id: &str) -> AppResult<Vec<String>> {
        let mut stmt =
            conn.prepare("SELECT id FROM page WHERE workspace_id = ?1 AND deleted_at IS NOT NULL")?;
        let rows = stmt.query_map([workspace_id], |r| r.get(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn list_children(
        conn: &Connection,
        workspace_id: &str,
        parent: Option<&str>,
    ) -> AppResult<Vec<Page>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT {PAGE_SELECT} FROM page
             WHERE workspace_id = ?1 AND parent_page_id IS ?2 AND deleted_at IS NULL AND kind <> 'record'
             ORDER BY position, id"
        ))?;
        let rows = stmt.query_map(params![workspace_id, parent], page_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

// ---------- block ----------

const BLOCK_COLS: &str =
    "id, page_id, parent_block_id, type, position, data_json, schema_version, revision, created_at, updated_at";

fn block_row(r: &Row) -> rusqlite::Result<Block> {
    Ok(Block {
        id: r.get(0)?,
        page_id: r.get(1)?,
        parent_block_id: r.get(2)?,
        block_type: r.get(3)?,
        position: r.get(4)?,
        data_json: r.get(5)?,
        schema_version: r.get(6)?,
        revision: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
    })
}

pub mod block {
    use super::*;

    pub fn insert(conn: &Connection, b: &Block) -> AppResult<()> {
        conn.execute(
            &format!(
                "INSERT INTO block ({BLOCK_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
            ),
            params![
                b.id,
                b.page_id,
                b.parent_block_id,
                b.block_type,
                b.position,
                b.data_json,
                b.schema_version,
                b.revision,
                b.created_at,
                b.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn get(conn: &Connection, id: &str) -> AppResult<Option<Block>> {
        Ok(conn
            .query_row(
                &format!("SELECT {BLOCK_COLS} FROM block WHERE id = ?1"),
                [id],
                block_row,
            )
            .optional()?)
    }

    pub fn update(conn: &Connection, b: &Block) -> AppResult<()> {
        conn.execute(
            "UPDATE block SET type = ?2, position = ?3, data_json = ?4, revision = revision + 1, updated_at = ?5
             WHERE id = ?1",
            params![b.id, b.block_type, b.position, b.data_json, b.updated_at],
        )?;
        Ok(())
    }

    /// Hard delete; child blocks go with it via ON DELETE CASCADE.
    pub fn delete(conn: &Connection, id: &str) -> AppResult<usize> {
        Ok(conn.execute("DELETE FROM block WHERE id = ?1", [id])?)
    }

    pub fn list(conn: &Connection, page_id: &str) -> AppResult<Vec<Block>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT {BLOCK_COLS} FROM block WHERE page_id = ?1 ORDER BY parent_block_id IS NOT NULL, parent_block_id, position, id"
        ))?;
        let rows = stmt.query_map([page_id], block_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn upsert(conn: &Connection, b: &Block) -> AppResult<()> {
        conn.execute(
            &format!(
                "INSERT INTO block ({BLOCK_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                     parent_block_id = excluded.parent_block_id,
                     type = excluded.type,
                     position = excluded.position,
                     data_json = excluded.data_json,
                     schema_version = excluded.schema_version,
                     revision = block.revision + 1,
                     updated_at = excluded.updated_at"
            ),
            params![
                b.id,
                b.page_id,
                b.parent_block_id,
                b.block_type,
                b.position,
                b.data_json,
                b.schema_version,
                b.revision,
                b.created_at,
                b.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn page_of(conn: &Connection, id: &str) -> AppResult<Option<String>> {
        Ok(conn
            .query_row("SELECT page_id FROM block WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()?)
    }

    /// True when `candidate` is `root` itself or lives anywhere beneath it.
    pub fn in_subtree(conn: &Connection, root: &str, candidate: &str) -> AppResult<bool> {
        let n: i64 = conn.query_row(
            "WITH RECURSIVE tree(id) AS (
                 SELECT id FROM block WHERE id = ?1
                 UNION ALL
                 SELECT b.id FROM block b JOIN tree t ON b.parent_block_id = t.id
             )
             SELECT COUNT(*) FROM tree WHERE id = ?2",
            params![root, candidate],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn position_of(conn: &Connection, id: &str) -> AppResult<Option<f64>> {
        Ok(conn
            .query_row("SELECT position FROM block WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn next_position(conn: &Connection, page_id: &str, parent: Option<&str>) -> AppResult<f64> {
        let max: Option<f64> = conn.query_row(
            "SELECT MAX(position) FROM block WHERE page_id = ?1 AND parent_block_id IS ?2",
            params![page_id, parent],
            |r| r.get(0),
        )?;
        Ok(max.map_or(0.0, |m| m + 1.0))
    }

    /// Smallest position among siblings strictly greater than `after`.
    pub fn next_sibling_position(
        conn: &Connection,
        page_id: &str,
        parent: Option<&str>,
        after: f64,
    ) -> AppResult<Option<f64>> {
        Ok(conn.query_row(
            "SELECT MIN(position) FROM block WHERE page_id = ?1 AND parent_block_id IS ?2 AND position > ?3",
            params![page_id, parent, after],
            |r| r.get(0),
        )?)
    }
}

//! Provenance: every set of changes an agent or the mirror applies is one changeset, listing the
//! pages it touched and the snapshot each had before, so it can be shown and reverted as a whole.

use crate::domain::{new_id, now, validate_id};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub struct Recorder {
    pub id: String,
    pub page_ids: Vec<String>,
}

impl Recorder {
    /// Starts a changeset inside the caller's transaction.
    pub fn begin(
        tx: &Connection,
        actor_kind: &str,
        actor_id: Option<&str>,
        proposal_id: Option<&str>,
        summary: &str,
    ) -> AppResult<Recorder> {
        let id = new_id();
        let summary: String = summary.chars().take(300).collect();
        tx.execute(
            "INSERT INTO changeset (id, actor_kind, actor_id, proposal_id, summary, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, actor_kind, actor_id, proposal_id, summary, now()],
        )?;
        Ok(Recorder {
            id,
            page_ids: vec![],
        })
    }

    /// Notes that `page_id` is about to change by `op`. For edits and renames, the page's current
    /// state is saved to its history first; for moves, its current parent is kept.
    pub fn touch(&mut self, tx: &Connection, page_id: &str, op: &str) -> AppResult<()> {
        let state = match op {
            "updated" | "renamed" => crate::history::snapshot(tx, page_id, "agent")?
                .map(|m| m.id)
                .or(latest_revision(tx, page_id)?),
            "moved" => repo::page::get(tx, page_id)?
                .map(|p| format!("parent:{}", p.parent_page_id.unwrap_or_default())),
            _ => None,
        };
        self.touch_with(tx, page_id, op, state)
    }

    /// Like [`touch`](Self::touch), with the state to return to given by the caller (a record's
    /// previous values, as JSON, for "values").
    pub fn touch_with(&mut self, tx: &Connection, page_id: &str, op: &str, state: Option<String>) -> AppResult<()> {
        tx.execute(
            "INSERT OR IGNORE INTO changeset_page (changeset_id, page_id, op, revision_id) VALUES (?1, ?2, ?3, ?4)",
            params![self.id, page_id, op, state],
        )?;
        if !self.page_ids.iter().any(|p| p == page_id) {
            self.page_ids.push(page_id.to_string());
        }
        Ok(())
    }
}

fn latest_revision(conn: &Connection, page_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM page_revision WHERE page_id = ?1 ORDER BY seq DESC LIMIT 1",
            [page_id],
            |r| r.get(0),
        )
        .optional()?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedPage {
    pub page_id: String,
    pub title: Option<String>,
    pub op: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesetInfo {
    pub id: String,
    pub actor_kind: String,
    pub actor_id: Option<String>,
    pub actor_name: Option<String>,
    pub proposal_id: Option<String>,
    pub summary: String,
    pub created_at: String,
    pub reverted_at: Option<String>,
    pub pages: Vec<ChangedPage>,
}

fn pages_of(conn: &Connection, id: &str) -> AppResult<Vec<ChangedPage>> {
    let mut stmt = conn.prepare(
        "SELECT c.page_id, p.title, c.op FROM changeset_page c LEFT JOIN page p ON p.id = c.page_id
         WHERE c.changeset_id = ?1 ORDER BY c.rowid",
    )?;
    let rows = stmt.query_map([id], |r| {
        Ok(ChangedPage {
            page_id: r.get(0)?,
            title: r.get(1)?,
            op: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The newest changesets, optionally of one agent or touching one page.
pub fn list(
    conn: &Connection,
    agent_id: Option<&str>,
    page_id: Option<&str>,
    limit: i64,
) -> AppResult<Vec<ChangesetInfo>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.actor_kind, c.actor_id, a.name, c.proposal_id, c.summary, c.created_at, c.reverted_at
         FROM changeset c LEFT JOIN agent a ON a.id = c.actor_id
         WHERE (?1 IS NULL OR c.actor_id = ?1)
           AND (?2 IS NULL OR c.id IN (SELECT changeset_id FROM changeset_page WHERE page_id = ?2))
         ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?3",
    )?;
    let rows: Vec<ChangesetInfo> = stmt
        .query_map(params![agent_id, page_id, limit.clamp(1, 200)], |r| {
            Ok(ChangesetInfo {
                id: r.get(0)?,
                actor_kind: r.get(1)?,
                actor_id: r.get(2)?,
                actor_name: r.get(3)?,
                proposal_id: r.get(4)?,
                summary: r.get(5)?,
                created_at: r.get(6)?,
                reverted_at: r.get(7)?,
                pages: vec![],
            })
        })?
        .collect::<Result<_, _>>()?;
    rows.into_iter()
        .map(|mut c| {
            c.pages = pages_of(conn, &c.id)?;
            Ok(c)
        })
        .collect()
}

/// Undoes a changeset: edited pages go back to the snapshot taken before it, created pages go
/// to the trash and trashed pages come back. Each restore keeps a safety snapshot, so a revert
/// can itself be undone from page history. Returns the pages it touched.
pub fn revert(conn: &mut Connection, id: &str) -> AppResult<Vec<String>> {
    validate_id(id, "changeset")?;
    let reverted: Option<Option<String>> = conn
        .query_row(
            "SELECT reverted_at FROM changeset WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    match reverted {
        None => return Err(AppError::NotFound("changeset".into())),
        Some(Some(_)) => return Err(AppError::Validation("These changes were already reverted.".into())),
        Some(None) => {}
    }
    let mut stmt = conn.prepare(
        "SELECT page_id, op, revision_id FROM changeset_page WHERE changeset_id = ?1 ORDER BY rowid DESC",
    )?;
    let entries: Vec<(String, String, Option<String>)> = stmt
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    let mut touched = Vec::new();
    for (page_id, op, revision) in entries {
        let page = repo::page::get(conn, &page_id)?;
        match op.as_str() {
            "created" => {
                if page.is_some_and(|p| p.deleted_at.is_none()) {
                    crate::services::page::delete(conn, &page_id)?;
                }
            }
            "trashed" => {
                if page.is_some_and(|p| p.deleted_at.is_some()) {
                    crate::services::page::restore(conn, &page_id)?;
                }
            }
            "updated" | "renamed" => {
                if let (Some(rev), Some(p)) = (revision, page) {
                    if p.deleted_at.is_none() {
                        crate::history::restore(conn, &rev)?;
                    }
                }
            }
            "moved" => {
                if let (Some(parent), Some(p)) = (revision.as_deref().and_then(|r| r.strip_prefix("parent:")), page) {
                    if p.deleted_at.is_none() {
                        let parent = (!parent.is_empty()).then(|| parent.to_string());
                        if p.parent_page_id != parent {
                            crate::services::page::move_page(
                                conn,
                                crate::domain::PageMove {
                                    id: page_id.clone(),
                                    parent_page_id: parent,
                                    before_page_id: None,
                                },
                            )?;
                        }
                    }
                }
            }
            "values" => {
                let before: serde_json::Map<String, serde_json::Value> = revision
                    .as_deref()
                    .and_then(|r| serde_json::from_str(r).ok())
                    .unwrap_or_default();
                let record: Option<String> = conn
                    .query_row("SELECT id FROM db_record WHERE page_id = ?1", [&page_id], |r| r.get(0))
                    .optional()?;
                if let (Some(record_id), true) = (record, page.is_some_and(|p| p.deleted_at.is_none())) {
                    for (property_id, value) in before {
                        crate::databases::service::set_value(
                            conn,
                            crate::databases::SetValue {
                                record_id: record_id.clone(),
                                property_id,
                                value,
                            },
                        )?;
                    }
                }
            }
            _ => {}
        }
        if !touched.contains(&page_id) {
            touched.push(page_id);
        }
    }
    conn.execute(
        "UPDATE changeset SET reverted_at = ?2 WHERE id = ?1",
        params![id, now()],
    )?;
    Ok(touched)
}

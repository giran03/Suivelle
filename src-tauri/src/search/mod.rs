//! Full-text search (SQLite FTS5), page references and recents.
//!
//! The index is maintained incrementally inside the same transaction as every page and block
//! write, so it cannot drift from the data. Trashed pages stay indexed and are hidden at query
//! time, which makes trashing and restoring free.

pub mod text;

#[cfg(test)]
mod tests;

use crate::domain::{validate_id, Block, Page};
use crate::errors::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Private-use characters that wrap matched terms in snippets; the UI splits on them, so no
/// HTML is ever produced here.
pub const MARK_START: char = '\u{E000}';
pub const MARK_END: char = '\u{E001}';

pub const MAX_QUERY_CHARS: usize = 200;
pub const MAX_LIMIT: i64 = 50;
const SNIPPET_TOKENS: i64 = 14;

// ---------------------------------------------------------------------------------------------
// index maintenance
// ---------------------------------------------------------------------------------------------

pub mod index {
    use super::*;

    fn doc_id(conn: &Connection, key: &str) -> AppResult<Option<i64>> {
        Ok(conn
            .query_row("SELECT id FROM search_doc WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn remove_key(conn: &Connection, key: &str) -> AppResult<()> {
        if let Some(id) = doc_id(conn, key)? {
            conn.execute("DELETE FROM search_fts WHERE rowid = ?1", [id])?;
            conn.execute("DELETE FROM search_doc WHERE id = ?1", [id])?;
        }
        Ok(())
    }

    fn upsert(
        conn: &Connection,
        key: &str,
        workspace_id: &str,
        page_id: &str,
        block_id: Option<&str>,
        title: &str,
        body: &str,
    ) -> AppResult<()> {
        if title.is_empty() && body.is_empty() {
            return remove_key(conn, key);
        }
        match doc_id(conn, key)? {
            Some(id) => {
                conn.execute(
                    "UPDATE search_fts SET title = ?2, body = ?3 WHERE rowid = ?1",
                    params![id, title, body],
                )?;
            }
            None => {
                conn.execute(
                    "INSERT INTO search_doc (key, workspace_id, page_id, block_id) VALUES (?1, ?2, ?3, ?4)",
                    params![key, workspace_id, page_id, block_id],
                )?;
                let id = conn.last_insert_rowid();
                conn.execute(
                    "INSERT INTO search_fts (rowid, title, body) VALUES (?1, ?2, ?3)",
                    params![id, title, body],
                )?;
            }
        }
        Ok(())
    }

    pub fn upsert_page(conn: &Connection, page: &Page) -> AppResult<()> {
        upsert(
            conn,
            &format!("p:{}", page.id),
            &page.workspace_id,
            &page.id,
            None,
            page.title.trim(),
            "",
        )?;
        // A page that now answers to a pending [[wikilink]] turns it into a mention.
        crate::agents::content::resolve_pending(conn, page)?;
        Ok(())
    }

    /// Indexes a block's text and replaces its page references.
    pub fn upsert_block(
        conn: &Connection,
        workspace_id: &str,
        page_id: &str,
        block_id: &str,
        block_type: &str,
        schema_version: i64,
        data_json: &str,
    ) -> AppResult<()> {
        let text = text::plain_text(block_type, schema_version, data_json);
        let (title, body) = if block_type.starts_with("heading_") {
            (text.as_str(), "")
        } else {
            ("", text.as_str())
        };
        upsert(
            conn,
            &format!("b:{block_id}"),
            workspace_id,
            page_id,
            Some(block_id),
            title,
            body,
        )?;

        conn.execute(
            "DELETE FROM page_reference WHERE source_block_id = ?1",
            [block_id],
        )?;
        for target in text::extract_refs(data_json) {
            conn.execute(
                "INSERT OR IGNORE INTO page_reference (source_page_id, source_block_id, target_page_id) VALUES (?1, ?2, ?3)",
                params![page_id, block_id, target],
            )?;
        }
        let targets = if text.contains("[[") {
            crate::agents::content::block_wikilinks(block_type, schema_version, data_json)
        } else {
            Vec::new()
        };
        set_unresolved(conn, workspace_id, page_id, block_id, targets)?;
        set_tags(conn, workspace_id, page_id, block_id, &text)
    }

    /// Records the block's `[[wikilinks]]` that no page answers to yet. Wikilinks written in
    /// code spans are examples, not links, so they are never recorded.
    fn set_unresolved(
        conn: &Connection,
        workspace_id: &str,
        page_id: &str,
        block_id: &str,
        targets: Vec<String>,
    ) -> AppResult<()> {
        conn.execute(
            "DELETE FROM page_link_unresolved WHERE source_block_id = ?1",
            [block_id],
        )?;
        use crate::agents::content::{norm, resolve_title};
        for target in targets {
            if resolve_title(conn, workspace_id, &target)?.is_none() {
                conn.execute(
                    "INSERT OR IGNORE INTO page_link_unresolved (source_block_id, source_page_id, workspace_id, target_text, target_norm)
                     SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM block WHERE id = ?1)",
                    params![block_id, page_id, workspace_id, target, norm(&target)],
                )?;
            }
        }
        Ok(())
    }

    fn set_tags(
        conn: &Connection,
        workspace_id: &str,
        page_id: &str,
        block_id: &str,
        text: &str,
    ) -> AppResult<()> {
        conn.execute("DELETE FROM block_tag WHERE block_id = ?1", [block_id])?;
        for tag in text::extract_tags(text) {
            conn.execute(
                "INSERT OR IGNORE INTO block_tag (block_id, page_id, workspace_id, tag) VALUES (?1, ?2, ?3, ?4)",
                params![block_id, page_id, workspace_id, tag],
            )?;
        }
        Ok(())
    }

    /// Fills the tag table from existing blocks, once, when the table is introduced.
    pub fn backfill_tags(conn: &Connection) -> AppResult<()> {
        let blocks: Vec<(String, String, String, String, i64, String)> = {
            let mut stmt = conn.prepare(
                "SELECT b.id, b.page_id, p.workspace_id, b.type, b.schema_version, b.data_json
                 FROM block b JOIN page p ON p.id = b.page_id WHERE instr(b.data_json, '#') > 0",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        for (id, page_id, workspace_id, kind, version, data) in blocks {
            let text = text::plain_text(&kind, version, &data);
            set_tags(conn, &workspace_id, &page_id, &id, &text)?;
        }
        Ok(())
    }

    /// Indexes a text property's value so records can be found by it (body text, no heading rank).
    pub fn upsert_property_text(
        conn: &Connection,
        workspace_id: &str,
        page_id: &str,
        record_id: &str,
        property_id: &str,
        text: &str,
    ) -> AppResult<()> {
        upsert(
            conn,
            &format!("v:{record_id}:{property_id}"),
            workspace_id,
            page_id,
            None,
            "",
            text.trim(),
        )
    }

    pub fn remove_property_text(
        conn: &Connection,
        record_id: &str,
        property_id: &str,
    ) -> AppResult<()> {
        remove_key(conn, &format!("v:{record_id}:{property_id}"))
    }

    /// Removes every record's indexed text for one property (when the property is deleted).
    pub fn remove_property_docs(conn: &Connection, property_id: &str) -> AppResult<()> {
        let pattern = format!("v:%:{property_id}");
        conn.execute(
            "DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_doc WHERE key LIKE ?1)",
            [&pattern],
        )?;
        conn.execute("DELETE FROM search_doc WHERE key LIKE ?1", [&pattern])?;
        Ok(())
    }

    /// Removes a block and all of its descendants from the index (call before deleting the block).
    pub fn remove_block_tree(conn: &Connection, block_id: &str) -> AppResult<()> {
        let mut stmt = conn.prepare(
            "WITH RECURSIVE tree(id) AS (
                 SELECT id FROM block WHERE id = ?1
                 UNION ALL
                 SELECT b.id FROM block b JOIN tree t ON b.parent_block_id = t.id
             ) SELECT id FROM tree",
        )?;
        let ids = stmt
            .query_map([block_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for id in ids {
            remove_key(conn, &format!("b:{id}"))?;
        }
        Ok(())
    }

    /// Removes a page's title and block documents and every reference pointing at it.
    pub fn remove_page(conn: &Connection, page_id: &str) -> AppResult<()> {
        conn.execute(
            "DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_doc WHERE page_id = ?1)",
            [page_id],
        )?;
        conn.execute("DELETE FROM search_doc WHERE page_id = ?1", [page_id])?;
        conn.execute(
            "DELETE FROM page_reference WHERE target_page_id = ?1",
            [page_id],
        )?;
        Ok(())
    }

    pub fn remove_workspace(conn: &Connection, workspace_id: &str) -> AppResult<()> {
        conn.execute(
            "DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_doc WHERE workspace_id = ?1)",
            [workspace_id],
        )?;
        conn.execute(
            "DELETE FROM search_doc WHERE workspace_id = ?1",
            [workspace_id],
        )?;
        Ok(())
    }

    /// Rebuilds one workspace's index and references from the stored pages and blocks.
    /// Returns the number of documents indexed.
    pub fn rebuild_workspace(conn: &Connection, workspace_id: &str) -> AppResult<i64> {
        remove_workspace(conn, workspace_id)?;
        conn.execute(
            "DELETE FROM page_reference WHERE source_page_id IN (SELECT id FROM page WHERE workspace_id = ?1)",
            [workspace_id],
        )?;
        let pages: Vec<(String, String)> = {
            let mut stmt = conn.prepare("SELECT id, title FROM page WHERE workspace_id = ?1")?;
            let rows = stmt.query_map([workspace_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        for (id, title) in &pages {
            upsert(
                conn,
                &format!("p:{id}"),
                workspace_id,
                id,
                None,
                title.trim(),
                "",
            )?;
        }
        let blocks: Vec<Block> = {
            let mut stmt = conn.prepare(
                "SELECT b.id, b.page_id, b.parent_block_id, b.type, b.position, b.data_json, b.schema_version,
                        b.revision, b.created_at, b.updated_at
                 FROM block b JOIN page p ON p.id = b.page_id WHERE p.workspace_id = ?1",
            )?;
            let rows = stmt.query_map([workspace_id], |r| {
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
            })?;
            rows.collect::<Result<_, _>>()?
        };
        for b in &blocks {
            upsert_block(
                conn,
                workspace_id,
                &b.page_id,
                &b.id,
                &b.block_type,
                b.schema_version,
                &b.data_json,
            )?;
        }
        let texts: Vec<(String, String, String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT v.record_id, rec.page_id, v.property_id, v.value_json
                 FROM db_value v
                 JOIN db_property pr ON pr.id = v.property_id AND pr.type IN ('text', 'url', 'email', 'phone')
                 JOIN db_record rec ON rec.id = v.record_id
                 JOIN page p ON p.id = rec.page_id
                 WHERE p.workspace_id = ?1",
            )?;
            let rows = stmt.query_map([workspace_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        for (record_id, page_id, property_id, json_text) in texts {
            if let Ok(serde_json::Value::String(text)) =
                serde_json::from_str::<serde_json::Value>(&json_text)
            {
                upsert_property_text(
                    conn,
                    workspace_id,
                    &page_id,
                    &record_id,
                    &property_id,
                    &text,
                )?;
            }
        }
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM search_doc WHERE workspace_id = ?1",
            [workspace_id],
            |r| r.get(0),
        )?;
        Ok(n)
    }

    /// Startup safety net: if there is content but no index (first run after this feature
    /// shipped, or a damaged index), build it.
    pub fn ensure_index(conn: &Connection) -> AppResult<()> {
        let docs: bool =
            conn.query_row("SELECT EXISTS(SELECT 1 FROM search_doc)", [], |r| r.get(0))?;
        let pages: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM page)", [], |r| r.get(0))?;
        if !docs && pages {
            let ids: Vec<String> = {
                let mut stmt = conn.prepare("SELECT id FROM workspace")?;
                let rows = stmt.query_map([], |r| r.get(0))?;
                rows.collect::<Result<_, _>>()?
            };
            for id in ids {
                rebuild_workspace(conn, &id)?;
            }
            tracing::info!("search index rebuilt on startup");
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchInput {
    pub workspace_id: String,
    pub query: String,
    #[serde(default)]
    pub titles_only: bool,
    pub modified_within_days: Option<i64>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct SearchHit {
    /// "page" for a title match, "block" for text inside a page.
    pub kind: &'static str,
    pub page_id: String,
    pub block_id: Option<String>,
    pub page_title: String,
    pub parent_title: Option<String>,
    /// Matched terms are wrapped in `MARK_START` / `MARK_END`.
    pub snippet: String,
    pub updated_at: String,
}

pub fn search(conn: &Connection, input: &SearchInput) -> AppResult<Vec<SearchHit>> {
    validate_id(&input.workspace_id, "workspace")?;
    if input.query.chars().count() > MAX_QUERY_CHARS {
        return Err(AppError::Validation("search text is too long".into()));
    }
    let Some(expr) = text::fts_query(&input.query, input.titles_only) else {
        return Ok(Vec::new());
    };
    let limit = input.limit.unwrap_or(30).clamp(1, MAX_LIMIT);
    let offset = input.offset.unwrap_or(0).max(0);
    let since = input.modified_within_days.filter(|d| *d > 0).map(|d| {
        (chrono::Utc::now() - chrono::Duration::days(d))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    });

    let sql = format!(
        "SELECT d.page_id, d.block_id, p.title, pp.title, p.updated_at,
                snippet(search_fts, -1, '{MARK_START}', '{MARK_END}', '…', {SNIPPET_TOKENS}), d.key
         FROM search_fts
         JOIN search_doc d ON d.id = search_fts.rowid
         JOIN page p ON p.id = d.page_id
         LEFT JOIN page pp ON pp.id = p.parent_page_id
         WHERE search_fts MATCH ?1 AND d.workspace_id = ?2 AND p.deleted_at IS NULL
           AND (?3 IS NULL OR p.updated_at >= ?3)
         ORDER BY bm25(search_fts, 10.0, 1.0), (d.block_id IS NOT NULL), p.updated_at DESC
         LIMIT ?4 OFFSET ?5"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        params![expr, input.workspace_id, since, limit, offset],
        |r| {
            let block_id: Option<String> = r.get(1)?;
            let key: String = r.get(6)?;
            Ok(SearchHit {
                // Titles are "p:" documents; block text and record property text are both content.
                kind: if key.starts_with("p:") {
                    "page"
                } else {
                    "block"
                },
                page_id: r.get(0)?,
                block_id,
                page_title: r.get(2)?,
                parent_title: r.get(3)?,
                snippet: r.get(5)?,
                updated_at: r.get(4)?,
            })
        },
    )?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Backlink {
    pub source_page_id: String,
    pub source_page_title: String,
    pub parent_title: Option<String>,
    pub source_block_id: String,
    pub snippet: String,
    /// `paragraph` for text blocks and list items, `table_row` for a row of a table.
    pub context_kind: String,
    pub row_index: Option<u32>,
    /// Header-row text for `table_row` hits (empty when the table has no header or the hit is it).
    pub header: Vec<String>,
    /// Cell text of the matching row.
    pub cells: Vec<String>,
}

/// Pages that mention or link to `page_id`, with the paragraph or table row around each reference.
pub fn backlinks(conn: &Connection, page_id: &str) -> AppResult<Vec<Backlink>> {
    validate_id(page_id, "page")?;
    let mut stmt = conn.prepare(
        "SELECT r.source_page_id, sp.title, pp.title, r.source_block_id, b.type, b.schema_version, b.data_json
         FROM page_reference r
         JOIN page sp ON sp.id = r.source_page_id AND sp.deleted_at IS NULL
         JOIN block b ON b.id = r.source_block_id
         LEFT JOIN page pp ON pp.id = sp.parent_page_id
         WHERE r.target_page_id = ?1 AND r.source_page_id <> ?1
         ORDER BY sp.updated_at DESC, b.position
         LIMIT 200",
    )?;
    let target = page_id.to_ascii_lowercase();
    let mut title_stmt = conn.prepare("SELECT title FROM page WHERE id = ?1")?;
    let mut titles: std::collections::HashMap<String, Option<String>> = Default::default();
    let mut title_of = |id: &str| -> Option<String> {
        titles
            .entry(id.to_string())
            .or_insert_with(|| title_stmt.query_row([id], |r| r.get(0)).ok())
            .clone()
    };
    let title_cell = std::cell::RefCell::new(&mut title_of);
    let mention = |id: &str| (title_cell.borrow_mut())(id);
    let rows = stmt.query_map([&target], |r| {
        let block_type: String = r.get(4)?;
        let data_json: String = r.get(6)?;
        let base = Backlink {
            source_page_id: r.get(0)?,
            source_page_title: r.get(1)?,
            parent_title: r.get(2)?,
            source_block_id: r.get(3)?,
            snippet: String::new(),
            context_kind: "paragraph".into(),
            row_index: None,
            header: Vec::new(),
            cells: Vec::new(),
        };
        if block_type == "simple_table" {
            let hits = text::table_rows_referencing(&data_json, &target, &mention);
            if !hits.is_empty() {
                return Ok(hits
                    .into_iter()
                    .map(|h| Backlink {
                        snippet: h.cells.join(" | ").chars().take(320).collect(),
                        context_kind: "table_row".into(),
                        row_index: Some(h.row_index as u32),
                        header: h.header,
                        cells: h.cells,
                        ..base.clone()
                    })
                    .collect::<Vec<_>>());
            }
        }
        let text = text::plain_text_with(&block_type, r.get(5)?, &data_json, &mention);
        Ok(vec![Backlink {
            snippet: text.chars().take(320).collect(),
            ..base
        }])
    })?;
    let mut out = Vec::new();
    for group in rows {
        out.extend(group?);
    }
    out.truncate(200);
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct PageTitle {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    pub deleted: bool,
}

/// Titles for many ids at once (mention chips). Unknown ids are simply absent from the result.
pub fn page_titles(conn: &Connection, ids: &[String]) -> AppResult<Vec<PageTitle>> {
    if ids.len() > 200 {
        return Err(AppError::Validation("too many pages requested".into()));
    }
    let mut stmt =
        conn.prepare("SELECT id, title, icon, deleted_at IS NOT NULL FROM page WHERE id = ?1")?;
    let mut out = Vec::new();
    for id in ids {
        validate_id(id, "page")?;
        if let Some(t) = stmt
            .query_row([id], |r| {
                Ok(PageTitle {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    icon: r.get(2)?,
                    deleted: r.get(3)?,
                })
            })
            .optional()?
        {
            out.push(t);
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct PreviewLine {
    /// The block type (`heading_1`, `bullet_list`, `paragraph`, ...), so the card can style it.
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct PagePreview {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    pub deleted: bool,
    pub lines: Vec<PreviewLine>,
    pub image_hash: Option<String>,
}

const PREVIEW_LINES: usize = 8;
const PREVIEW_LINE_CHARS: usize = 220;

/// A short read-only excerpt of a page for the hover card: its title and the first few text blocks.
pub fn page_preview(conn: &Connection, page_id: &str) -> AppResult<Option<PagePreview>> {
    validate_id(page_id, "page")?;
    let Some((title, icon, deleted)) = conn
        .query_row(
            "SELECT title, icon, deleted_at IS NOT NULL FROM page WHERE id = ?1",
            [page_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT type, schema_version, data_json FROM block
         WHERE page_id = ?1 AND parent_block_id IS NULL ORDER BY position LIMIT 40",
    )?;
    let mut lines = Vec::new();
    let mut image_hash = None;
    let rows = stmt.query_map([page_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (kind, version, data) = row?;
        if kind == "image" && image_hash.is_none() {
            image_hash = serde_json::from_str::<serde_json::Value>(&data)
                .ok()
                .and_then(|v| {
                    v.pointer("/attachment/hash")
                        .and_then(|h| h.as_str().map(String::from))
                });
            continue;
        }
        if lines.len() >= PREVIEW_LINES {
            continue;
        }
        let text: String = text::plain_text(&kind, version, &data)
            .chars()
            .take(PREVIEW_LINE_CHARS)
            .collect();
        if !text.is_empty() {
            lines.push(PreviewLine { kind, text });
        }
    }
    Ok(Some(PagePreview {
        id: page_id.to_string(),
        title,
        icon,
        deleted,
        lines,
        image_hash,
    }))
}

// ---------------------------------------------------------------------------------------------
// tags and the link graph
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct TagCount {
    pub tag: String,
    pub pages: i64,
}

/// Every #tag in the workspace with how many live pages use it, most used first.
pub fn tags(conn: &Connection, workspace_id: &str) -> AppResult<Vec<TagCount>> {
    validate_id(workspace_id, "workspace")?;
    let mut stmt = conn.prepare(
        "SELECT t.tag, COUNT(DISTINCT t.page_id) FROM block_tag t
         JOIN page p ON p.id = t.page_id AND p.deleted_at IS NULL
         WHERE t.workspace_id = ?1 GROUP BY t.tag ORDER BY 2 DESC, 1",
    )?;
    let rows = stmt.query_map([workspace_id], |r| {
        Ok(TagCount {
            tag: r.get(0)?,
            pages: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Live pages whose text uses `tag`, most recently edited first.
pub fn tagged_pages(conn: &Connection, workspace_id: &str, tag: &str) -> AppResult<Vec<PageTitle>> {
    validate_id(workspace_id, "workspace")?;
    let mut stmt = conn.prepare(
        "SELECT DISTINCT p.id, p.title, p.icon, p.updated_at FROM block_tag t
         JOIN page p ON p.id = t.page_id AND p.deleted_at IS NULL
         WHERE t.workspace_id = ?1 AND t.tag = ?2 ORDER BY p.updated_at DESC LIMIT 200",
    )?;
    let rows = stmt.query_map(
        params![workspace_id, tag.trim_start_matches('#').to_lowercase()],
        |r| {
            Ok(PageTitle {
                id: r.get(0)?,
                title: r.get(1)?,
                icon: r.get(2)?,
                deleted: false,
            })
        },
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkGraph {
    pub nodes: Vec<PageTitle>,
    /// Pairs of page ids: the page that links, and the page it links to.
    pub edges: Vec<(String, String)>,
}

/// Pages and the links between them, for the graph view. Database records are left out so the
/// graph shows documents rather than every row.
pub fn link_graph(conn: &Connection, workspace_id: &str) -> AppResult<LinkGraph> {
    validate_id(workspace_id, "workspace")?;
    let mut stmt = conn.prepare(
        "SELECT id, title, icon FROM page
         WHERE workspace_id = ?1 AND deleted_at IS NULL AND kind != 'record' LIMIT 5000",
    )?;
    let nodes: Vec<PageTitle> = stmt
        .query_map([workspace_id], |r| {
            Ok(PageTitle {
                id: r.get(0)?,
                title: r.get(1)?,
                icon: r.get(2)?,
                deleted: false,
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare(
        "SELECT DISTINCT r.source_page_id, r.target_page_id FROM page_reference r
         JOIN page s ON s.id = r.source_page_id AND s.deleted_at IS NULL AND s.kind != 'record'
         JOIN page t ON t.id = r.target_page_id AND t.deleted_at IS NULL AND t.kind != 'record'
         WHERE s.workspace_id = ?1 AND r.source_page_id != r.target_page_id",
    )?;
    let edges = stmt
        .query_map([workspace_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    Ok(LinkGraph { nodes, edges })
}

/// Pages whose text names this page's title without linking to it, so a link can be added.
/// Titles shorter than three characters would match too much and are skipped.
pub fn unlinked_mentions(conn: &Connection, page_id: &str) -> AppResult<Vec<Backlink>> {
    validate_id(page_id, "page")?;
    let Some((title, workspace_id)) = conn
        .query_row(
            "SELECT title, workspace_id FROM page WHERE id = ?1",
            [page_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
    else {
        return Ok(Vec::new());
    };
    let words: Vec<String> = title
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(8)
        .map(str::to_string)
        .collect();
    if words.concat().chars().count() < 3 {
        return Ok(Vec::new());
    }
    let phrase = format!("body : \"{}\"", words.join(" "));
    let mut stmt = conn.prepare(
        "SELECT d.page_id, d.block_id, p.title, pp.title, snippet(search_fts, 1, '', '', '…', 14)
         FROM search_fts
         JOIN search_doc d ON d.id = search_fts.rowid
         JOIN page p ON p.id = d.page_id
         LEFT JOIN page pp ON pp.id = p.parent_page_id
         WHERE search_fts MATCH ?1 AND d.workspace_id = ?2 AND p.deleted_at IS NULL
           AND d.block_id IS NOT NULL AND d.page_id != ?3
           AND d.page_id NOT IN (SELECT source_page_id FROM page_reference WHERE target_page_id = ?3)
         ORDER BY p.updated_at DESC LIMIT 20",
    )?;
    let rows = stmt.query_map(params![phrase, workspace_id, page_id], |r| {
        Ok(Backlink {
            source_page_id: r.get(0)?,
            source_block_id: r.get(1)?,
            source_page_title: r.get(2)?,
            parent_title: r.get(3)?,
            snippet: r.get(4)?,
            context_kind: "paragraph".into(),
            row_index: None,
            header: Vec::new(),
            cells: Vec::new(),
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

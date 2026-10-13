//! Page history: compressed snapshots of a page's title and blocks, a preview with a diff against
//! the current page, and restore.
//!
//! A snapshot is taken (never more than needed):
//! - before an edit that changes many blocks at once, or when the page has no snapshot from the
//!   last ten minutes (so there is always a recent state to go back to);
//! - when you leave the page;
//! - when you ask for one ("Save version");
//! - just before a restore, so restoring can be undone.
//!
//! An automatic snapshot identical to the previous one is skipped. Per page the newest 50
//! automatic snapshots are kept, plus the newest of each day for 30 days. Manual ones are kept.

#[cfg(test)]
mod tests;

use crate::domain::{new_id, now, validate_id, Block, BlockBatch, BlockUpsert};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use crate::search;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use flate2::{read::DeflateDecoder, write::DeflateEncoder, Compression};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};

/// A batch of this many block changes counts as a structural edit.
pub const STRUCTURAL_OPS: usize = 10;
pub const AUTO_INTERVAL_MINUTES: i64 = 10;
pub const KEEP_RECENT: usize = 50;
pub const KEEP_DAILY_DAYS: i64 = 30;
const PREVIEW_CHARS: usize = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapBlock {
    id: String,
    parent_block_id: Option<String>,
    #[serde(rename = "type")]
    block_type: String,
    position: f64,
    data_json: String,
    schema_version: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Snapshot {
    title: String,
    blocks: Vec<SnapBlock>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionMeta {
    pub id: String,
    pub page_id: String,
    pub seq: i64,
    /// "auto", "manual" or "restore" (the state saved just before a restore).
    pub kind: String,
    pub title: String,
    pub block_count: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBlock {
    pub id: String,
    #[serde(rename = "type")]
    pub block_type: String,
    pub text: String,
    pub depth: usize,
    /// For blocks in the snapshot: "same", "changed" (differs from the page now) or "added" (the
    /// page no longer has it). Blocks only the page has are listed separately as removed.
    pub change: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDetail {
    pub meta: RevisionMeta,
    pub current_title: String,
    pub blocks: Vec<PreviewBlock>,
    /// Blocks on the page now that restoring this version would remove.
    pub removed: Vec<PreviewBlock>,
}

fn collect(conn: &Connection, page_id: &str) -> AppResult<Snapshot> {
    let page = repo::page::get(conn, page_id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
    let mut blocks: Vec<SnapBlock> = repo::block::list(conn, page_id)?
        .into_iter()
        .map(|b| SnapBlock {
            id: b.id,
            parent_block_id: b.parent_block_id,
            block_type: b.block_type,
            position: b.position,
            data_json: b.data_json,
            schema_version: b.schema_version,
        })
        .collect();
    blocks.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Snapshot {
        title: page.title,
        blocks,
    })
}

fn compress(json: &[u8]) -> AppResult<Vec<u8>> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
    enc.write_all(json)?;
    Ok(enc.finish()?)
}

fn decode(blob: &[u8]) -> AppResult<Snapshot> {
    let mut json = Vec::new();
    DeflateDecoder::new(blob)
        .read_to_end(&mut json)
        .map_err(|_| AppError::Internal("a saved version could not be read".into()))?;
    serde_json::from_slice(&json)
        .map_err(|_| AppError::Internal("a saved version could not be read".into()))
}

fn meta_row(r: &rusqlite::Row) -> rusqlite::Result<RevisionMeta> {
    Ok(RevisionMeta {
        id: r.get(0)?,
        page_id: r.get(1)?,
        seq: r.get(2)?,
        kind: r.get(3)?,
        title: r.get(4)?,
        block_count: r.get(5)?,
        created_at: r.get(6)?,
    })
}

const META_COLS: &str = "id, page_id, seq, kind, title, block_count, created_at";

fn latest(conn: &Connection, page_id: &str) -> AppResult<Option<(String, String, i64)>> {
    Ok(conn
        .query_row(
            "SELECT content_hash, created_at, seq FROM page_revision WHERE page_id = ?1 ORDER BY seq DESC LIMIT 1",
            [page_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?)
}

/// Stores a snapshot of the page as it is now. Automatic and restore snapshots are skipped when
/// they would repeat the newest one (or when an automatic one would capture an empty page).
pub fn snapshot(conn: &Connection, page_id: &str, kind: &str) -> AppResult<Option<RevisionMeta>> {
    let snap = collect(conn, page_id)?;
    let json = serde_json::to_vec(&snap).map_err(|e| AppError::Internal(e.to_string()))?;
    let hash: String = Sha256::digest(&json)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let last = latest(conn, page_id)?;
    if kind != "manual" {
        if last.as_ref().is_some_and(|(h, _, _)| *h == hash) {
            return Ok(None);
        }
        if last.is_none() && snap.blocks.is_empty() {
            return Ok(None);
        }
    }
    // Compare the canonical hash before doing compression for an unchanged checkpoint.
    let blob = compress(&json)?;
    let meta = RevisionMeta {
        id: new_id(),
        page_id: page_id.into(),
        seq: last.map_or(1, |(_, _, s)| s + 1),
        kind: kind.into(),
        title: snap.title.clone(),
        block_count: snap.blocks.len() as i64,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO page_revision (id, page_id, seq, kind, title, block_count, content_hash, snapshot, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![meta.id, meta.page_id, meta.seq, meta.kind, meta.title, meta.block_count, hash, blob, meta.created_at],
    )?;
    prune(conn, page_id, Utc::now())?;
    Ok(Some(meta))
}

/// Called before a batch of block edits is applied: saves the page as it was when the edit is
/// large, or when there has been no snapshot for a while.
pub fn before_edit(conn: &Connection, page_id: &str, ops: usize) -> AppResult<()> {
    let due = match latest(conn, page_id)? {
        None => true,
        Some((_, at, _)) => parse_time(&at)
            .is_none_or(|t| Utc::now() - t >= Duration::minutes(AUTO_INTERVAL_MINUTES)),
    };
    if ops >= STRUCTURAL_OPS || due {
        snapshot(conn, page_id, "auto")?;
    }
    Ok(())
}

fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// Keeps the newest `KEEP_RECENT` automatic snapshots, plus the newest of each day within
/// `KEEP_DAILY_DAYS`. Manual snapshots are never removed.
pub fn prune(conn: &Connection, page_id: &str, at: DateTime<Utc>) -> AppResult<usize> {
    let mut stmt = conn.prepare(
        "SELECT id, created_at FROM page_revision WHERE page_id = ?1 AND kind <> 'manual' ORDER BY seq DESC",
    )?;
    let autos: Vec<(String, String)> = stmt
        .query_map([page_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut seen_days: HashSet<NaiveDate> = HashSet::new();
    let mut doomed = Vec::new();
    for (i, (id, created)) in autos.iter().enumerate() {
        if i < KEEP_RECENT {
            if let Some(t) = parse_time(created) {
                seen_days.insert(t.date_naive());
            }
            continue;
        }
        let keep = parse_time(created).is_some_and(|t| {
            at - t <= Duration::days(KEEP_DAILY_DAYS) && seen_days.insert(t.date_naive())
        });
        if !keep {
            doomed.push(id.clone());
        }
    }
    for id in &doomed {
        conn.execute("DELETE FROM page_revision WHERE id = ?1", [id])?;
    }
    Ok(doomed.len())
}

pub fn list(conn: &Connection, page_id: &str) -> AppResult<Vec<RevisionMeta>> {
    validate_id(page_id, "page")?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {META_COLS} FROM page_revision WHERE page_id = ?1 ORDER BY seq DESC"
    ))?;
    let rows = stmt.query_map([page_id], meta_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn load(conn: &Connection, id: &str) -> AppResult<(RevisionMeta, Snapshot)> {
    validate_id(id, "version")?;
    let (meta, blob) = conn
        .query_row(
            &format!("SELECT {META_COLS}, snapshot FROM page_revision WHERE id = ?1"),
            [id],
            |r| Ok((meta_row(r)?, r.get::<_, Vec<u8>>(7)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("version".into()))?;
    Ok((meta, decode(&blob)?))
}

fn preview(b: &SnapBlock, depth: usize, change: &'static str) -> PreviewBlock {
    let mut text = search::text::plain_text(&b.block_type, b.schema_version, &b.data_json);
    if text.chars().count() > PREVIEW_CHARS {
        text = text.chars().take(PREVIEW_CHARS).collect::<String>() + "…";
    }
    PreviewBlock {
        id: b.id.clone(),
        block_type: b.block_type.clone(),
        text,
        depth,
        change,
    }
}

fn depth_of(b: &SnapBlock, by_id: &HashMap<&str, &SnapBlock>) -> usize {
    let mut depth = 0;
    let mut cur = b.parent_block_id.as_deref();
    while let Some(p) = cur {
        depth += 1;
        if depth > 32 {
            break;
        }
        cur = by_id.get(p).and_then(|x| x.parent_block_id.as_deref());
    }
    depth
}

/// Blocks in reading order: each parent followed by its children, siblings by position.
fn reading_order(blocks: &[SnapBlock]) -> Vec<&SnapBlock> {
    let ids: HashSet<&str> = blocks.iter().map(|b| b.id.as_str()).collect();
    let mut kids: HashMap<Option<&str>, Vec<&SnapBlock>> = HashMap::new();
    for b in blocks {
        let key = b.parent_block_id.as_deref().filter(|p| ids.contains(p));
        kids.entry(key).or_default().push(b);
    }
    for v in kids.values_mut() {
        v.sort_by(|a, b| {
            a.position
                .total_cmp(&b.position)
                .then_with(|| a.id.cmp(&b.id))
        });
    }
    let mut out = Vec::new();
    fn walk<'a>(
        parent: Option<&'a str>,
        kids: &HashMap<Option<&'a str>, Vec<&'a SnapBlock>>,
        out: &mut Vec<&'a SnapBlock>,
        guard: usize,
    ) {
        if guard > 32 {
            return;
        }
        for b in kids.get(&parent).into_iter().flatten() {
            out.push(b);
            walk(Some(b.id.as_str()), kids, out, guard + 1);
        }
    }
    walk(None, &kids, &mut out, 0);
    out
}

pub fn get(conn: &Connection, id: &str) -> AppResult<RevisionDetail> {
    let (meta, snap) = load(conn, id)?;
    let now_snap = collect(conn, &meta.page_id)?;
    let current: HashMap<&str, &SnapBlock> =
        now_snap.blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let by_id: HashMap<&str, &SnapBlock> = snap.blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let blocks = reading_order(&snap.blocks)
        .into_iter()
        .map(|b| {
            let change = match current.get(b.id.as_str()) {
                None => "added",
                Some(c)
                    if c.block_type != b.block_type
                        || c.data_json != b.data_json
                        || c.parent_block_id != b.parent_block_id =>
                {
                    "changed"
                }
                Some(_) => "same",
            };
            preview(b, depth_of(b, &by_id), change)
        })
        .collect();
    let cur_by_id = current.clone();
    let removed = reading_order(&now_snap.blocks)
        .into_iter()
        .filter(|b| !by_id.contains_key(b.id.as_str()))
        .map(|b| preview(b, depth_of(b, &cur_by_id), "removed"))
        .collect();
    Ok(RevisionDetail {
        meta,
        current_title: now_snap.title,
        blocks,
        removed,
    })
}

/// Replaces the page's title and blocks with a saved version. The page as it is now is saved
/// first (kind "restore"), so a restore can itself be undone by restoring that snapshot.
/// Returns the id of that safety snapshot, if one was needed.
pub fn restore(conn: &mut Connection, revision_id: &str) -> AppResult<Option<String>> {
    let tx = conn.transaction()?;
    let (meta, snap) = load(&tx, revision_id)?;
    let mut page = match repo::page::get(&tx, &meta.page_id)? {
        Some(p) if p.deleted_at.is_none() => p,
        _ => return Err(AppError::NotFound("page".into())),
    };
    let safety = snapshot(&tx, &meta.page_id, "restore")?;
    let current_ids: Vec<String> = repo::block::list(&tx, &meta.page_id)?
        .into_iter()
        .map(|b: Block| b.id)
        .collect();
    let keep: HashSet<&str> = snap.blocks.iter().map(|b| b.id.as_str()).collect();
    let batch = BlockBatch {
        page_id: meta.page_id.clone(),
        upserts: snap
            .blocks
            .iter()
            .map(|b| BlockUpsert {
                id: b.id.clone(),
                parent_block_id: b.parent_block_id.clone(),
                block_type: b.block_type.clone(),
                position: b.position,
                data_json: b.data_json.clone(),
                schema_version: b.schema_version,
            })
            .collect(),
        delete_ids: current_ids
            .into_iter()
            .filter(|id| !keep.contains(id.as_str()))
            .collect(),
    };
    crate::services::block::apply_batch_in(&tx, &batch)?;
    if page.title != snap.title {
        page.title = snap.title.clone();
        page.updated_at = now();
        repo::page::update(&tx, &page)?;
        search::index::upsert_page(&tx, &page)?;
    }
    tx.commit()?;
    Ok(safety.map(|s| s.id))
}

pub fn save_version(conn: &Connection, page_id: &str) -> AppResult<RevisionMeta> {
    validate_id(page_id, "page")?;
    match repo::page::get(conn, page_id)? {
        Some(p) if p.deleted_at.is_none() => {}
        _ => return Err(AppError::NotFound("page".into())),
    }
    snapshot(conn, page_id, "manual")?
        .ok_or_else(|| AppError::Internal("a manual version is always saved".into()))
}

/// Called when you leave a page: saves it if it changed since its newest snapshot.
pub fn checkpoint(conn: &Connection, page_id: &str) -> AppResult<()> {
    validate_id(page_id, "page")?;
    match repo::page::get(conn, page_id)? {
        Some(p) if p.deleted_at.is_none() => {}
        _ => return Ok(()),
    }
    snapshot(conn, page_id, "auto")?;
    Ok(())
}

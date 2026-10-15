//! Pages as Markdown for agents and the mirror, and Markdown back into pages.
//!
//! Blocks Markdown cannot carry (media, embeds, database views, columns, callouts, synced blocks)
//! are written as one-line `<!-- suivelle:keep <id> … -->` markers. Writing a marker back keeps
//! the original block untouched; leaving it out removes the block (page history keeps it).
//! Mentions are written as `[Title](suivelle://page/<id>)` and read back as mentions;
//! `[[Title]]` links to a page by title or alias, and stays as text until that page exists.

use crate::domain::{Block, BlockBatch, BlockUpsert, Page, BLOCK_SCHEMA_VERSION};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use crate::search::text::INTERNAL_PAGE_LINK;
use crate::transfer::blocks::{self, Blk, Inline, Mark};
use crate::transfer::markdown;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// The most Markdown an agent or the mirror may write into one page at once.
pub const MAX_MARKDOWN_BYTES: usize = 512 * 1024;

const KEEP: &str = "<!-- suivelle:keep ";

/// Block types whose content survives a trip through Markdown.
fn round_trips(kind: &str) -> bool {
    matches!(
        kind,
        "paragraph"
            | "heading_1"
            | "heading_2"
            | "heading_3"
            | "bullet_list"
            | "numbered_list"
            | "todo"
            | "quote"
            | "divider"
            | "code"
            | "equation"
            | "simple_table"
            | "toggle"
    )
}

fn whole_round_trips(b: &Blk) -> bool {
    round_trips(&b.kind) && b.children.iter().all(whole_round_trips)
}

/// Lower-case, trimmed, single-spaced: how titles, aliases and link targets are compared.
pub fn norm(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn short(s: &str, n: usize) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(n).collect();
    if flat.chars().count() > n {
        out.push('…');
    }
    out.replace("--", "–")
}

fn summary(b: &Blk) -> String {
    let text = blocks::plain_of(&b.inline);
    let detail = match b.kind.as_str() {
        k if blocks::is_media(k) => b.media.as_ref().map(|m| m.name.clone()).unwrap_or_default(),
        "embed" => b
            .embed
            .as_ref()
            .and_then(|e| e["url"].as_str().map(String::from))
            .unwrap_or_default(),
        "tab_panel" => b.label.clone(),
        _ if !text.is_empty() => text,
        _ => {
            let mut inner = String::new();
            blocks::visit(&b.children, &mut |c| {
                if inner.len() < 200 {
                    inner.push_str(&blocks::plain_of(&c.inline));
                    inner.push(' ');
                }
            });
            inner
        }
    };
    short(&detail, 120)
}

fn title_of(conn: &Connection, id: &str) -> Option<String> {
    repo::page::get(conn, id)
        .ok()
        .flatten()
        .filter(|p| p.deleted_at.is_none())
        .map(|p| p.title)
}

/// The page body as Markdown, without a title or front matter.
pub fn body_markdown(conn: &Connection, page_id: &str) -> AppResult<String> {
    let rows = repo::block::list(conn, page_id)?;
    // Top-level rows in reading order, so markers can name the block they stand for.
    let mut top: Vec<&Block> = rows.iter().filter(|r| r.parent_block_id.is_none()).collect();
    top.sort_by(|a, b| a.position.total_cmp(&b.position).then(a.id.cmp(&b.id)));
    let tree = blocks::tree_from_rows(&rows);
    let title = |id: &str| title_of(conn, id);
    let link = |id: &str| Some(format!("{INTERNAL_PAGE_LINK}{id}"));
    let asset = |m: &blocks::Media| Some(m.name.clone());
    let ctx = markdown::Ctx {
        asset: &asset,
        title: &title,
        link: &link,
    };
    let mut out: Vec<String> = Vec::new();
    let mut run: Vec<Blk> = Vec::new();
    let flush = |run: &mut Vec<Blk>, out: &mut Vec<String>| {
        if !run.is_empty() {
            let s = markdown::render(run, &ctx);
            if !s.trim().is_empty() {
                out.push(s);
            }
            run.clear();
        }
    };
    for (row, b) in top.iter().zip(tree) {
        if whole_round_trips(&b) {
            run.push(b);
        } else {
            flush(&mut run, &mut out);
            let s = summary(&b);
            out.push(format!(
                "{KEEP}{} {}{}{} -->",
                row.id,
                b.kind,
                if s.is_empty() { "" } else { ": " },
                s
            ));
        }
    }
    flush(&mut run, &mut out);
    // The renderer escapes brackets; `[[wikilinks]]` read better, and are read back as links.
    Ok(out.join("\n\n").replace(r"\[\[", "[[").replace(r"\]\]", "]]"))
}

/// A short fingerprint of the page body, so a later write can tell whether it changed meanwhile.
pub fn content_hash(conn: &Connection, page_id: &str) -> AppResult<String> {
    let page = repo::page::get(conn, page_id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
    let body = body_markdown(conn, page_id)?;
    let digest = Sha256::digest(format!("{}\n{}", page.title, body).as_bytes());
    Ok(digest.iter().take(8).map(|b| format!("{b:02x}")).collect())
}

/// Finds a live page in the workspace by exact title (case-insensitive), then by alias.
pub fn resolve_title(conn: &Connection, workspace_id: &str, text: &str) -> AppResult<Option<String>> {
    let key = norm(text);
    if key.is_empty() {
        return Ok(None);
    }
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM page WHERE workspace_id = ?1 AND deleted_at IS NULL
               AND lower(trim(title)) = ?2
             ORDER BY (kind = 'page') DESC, created_at LIMIT 1",
            params![workspace_id, key],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(Some(id));
    }
    Ok(conn
        .query_row(
            "SELECT a.page_id FROM page_alias a JOIN page p ON p.id = a.page_id
             WHERE a.workspace_id = ?1 AND a.alias_norm = ?2 AND p.deleted_at IS NULL LIMIT 1",
            params![workspace_id, key],
            |r| r.get(0),
        )
        .optional()?)
}

/// The `[[target]]` and optional `|label` of every wikilink in `text`, with their byte ranges.
pub fn wikilinks(text: &str) -> Vec<(std::ops::Range<usize>, String, Option<String>)> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(start) = text[i..].find("[[").map(|s| s + i) {
        let Some(end) = text[start + 2..].find("]]").map(|e| e + start + 2) else {
            break;
        };
        let inner = &text[start + 2..end];
        if !inner.is_empty() && !inner.contains('[') && !inner.contains('\n') && inner.len() <= 300 {
            let (target, label) = match inner.split_once('|') {
                Some((t, l)) => (t, Some(l.trim().to_string()).filter(|l| !l.is_empty())),
                None => (inner, None),
            };
            // `[[Page#Heading]]` links to the page; the heading part is kept as the label.
            let target = target.split('#').next().unwrap_or("").trim().to_string();
            if !target.is_empty() {
                out.push((start..end + 2, target, label));
            }
            i = end + 2;
        } else {
            i = start + 2;
        }
    }
    out
}

/// The `[[wikilink]]` targets in a stored block that can become links: like [`link_inlines`],
/// text in code spans or already inside a link is left alone, and code blocks have none.
pub fn block_wikilinks(block_type: &str, schema_version: i64, data_json: &str) -> Vec<String> {
    let b = Blk::from_row(block_type, data_json, schema_version);
    let cells = b.table.iter().flatten().flatten();
    std::iter::once(&b.inline)
        .chain(cells)
        .flatten()
        .filter_map(|item| match item {
            Inline::Text { text, marks }
                if text.contains("[[") && !marks.iter().any(|m| matches!(m, Mark::Code | Mark::Link(_))) =>
            {
                Some(wikilinks(text).into_iter().map(|(_, target, _)| target))
            }
            _ => None,
        })
        .flatten()
        .collect()
}

/// Rewrites resolvable `[[wikilinks]]` in running text as mentions or links, and turns
/// `[Title](suivelle://page/<id>)` back into a mention when its text is the page's title.
pub fn link_inlines(conn: &Connection, workspace_id: &str, items: Vec<Inline>) -> AppResult<Vec<Inline>> {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Inline::Text { text, marks } => {
                if let Some(id) = marks.iter().find_map(|m| match m {
                    Mark::Link(h) => h.strip_prefix(INTERNAL_PAGE_LINK).map(String::from),
                    _ => None,
                }) {
                    if marks.len() == 1 && title_of(conn, &id).is_some_and(|t| norm(&t) == norm(&text)) {
                        out.push(Inline::Mention(id));
                        continue;
                    }
                }
                let code = marks.iter().any(|m| matches!(m, Mark::Code | Mark::Link(_)));
                let links = if code { vec![] } else { wikilinks(&text) };
                if links.is_empty() {
                    out.push(Inline::Text { text, marks });
                    continue;
                }
                let mut last = 0;
                for (range, target, label) in links {
                    let Some(id) = resolve_title(conn, workspace_id, &target)? else {
                        continue;
                    };
                    if range.start > last {
                        out.push(Inline::Text {
                            text: text[last..range.start].to_string(),
                            marks: marks.clone(),
                        });
                    }
                    match label {
                        Some(label) => {
                            let mut m = marks.clone();
                            m.push(Mark::Link(format!("{INTERNAL_PAGE_LINK}{id}")));
                            out.push(Inline::Text { text: label, marks: m });
                        }
                        None => out.push(Inline::Mention(id)),
                    }
                    last = range.end;
                }
                if last < text.len() {
                    out.push(Inline::Text {
                        text: text[last..].to_string(),
                        marks,
                    });
                }
            }
            other => out.push(other),
        }
    }
    Ok(out)
}

fn link_tree(conn: &Connection, workspace_id: &str, list: &mut [Blk]) -> AppResult<()> {
    for b in list.iter_mut() {
        let inline = std::mem::take(&mut b.inline);
        b.inline = link_inlines(conn, workspace_id, inline)?;
        if let Some(table) = b.table.as_mut() {
            for row in table.iter_mut() {
                for cell in row.iter_mut() {
                    let c = std::mem::take(cell);
                    *cell = link_inlines(conn, workspace_id, c)?;
                }
            }
        }
        link_tree(conn, workspace_id, &mut b.children)?;
    }
    Ok(())
}

/// A marker paragraph's block id.
fn keep_marker(b: &Blk) -> Option<String> {
    if b.kind != "paragraph" || !b.children.is_empty() {
        return None;
    }
    let text = blocks::plain_of(&b.inline);
    let rest = text.trim().strip_prefix(KEEP)?;
    let id = rest.split_whitespace().next()?;
    crate::domain::validate_id(id, "block").ok()?;
    Some(id.to_string())
}

/// Whether to add to the page or replace what it holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    Replace,
    Append,
}

/// Parsed Markdown, ready to write: its title (from front matter or a leading heading, when
/// asked for) and its blocks.
pub struct Prepared {
    pub title: Option<String>,
    pub blocks: Vec<Blk>,
}

pub fn prepare(conn: &Connection, workspace_id: &str, md: &str, take_title: bool) -> AppResult<Prepared> {
    if md.len() > MAX_MARKDOWN_BYTES {
        return Err(AppError::Validation(format!(
            "Markdown is limited to {} KB per page",
            MAX_MARKDOWN_BYTES / 1024
        )));
    }
    let (title, mut list) = if take_title {
        let p = markdown::parse(md);
        (p.title, p.blocks)
    } else {
        (None, markdown::fragment(md))
    };
    link_tree(conn, workspace_id, &mut list)?;
    Ok(Prepared { title, blocks: list })
}

/// Writes Markdown into a page inside the caller's transaction. Returns how many blocks changed.
pub fn write_markdown(tx: &Connection, page: &Page, md: &str, mode: WriteMode) -> AppResult<usize> {
    let prepared = prepare(tx, &page.workspace_id, md, false)?;
    write_blocks(tx, page, prepared.blocks, mode)
}

pub fn write_blocks(tx: &Connection, page: &Page, new: Vec<Blk>, mode: WriteMode) -> AppResult<usize> {
    let rows = repo::block::list(tx, &page.id)?;
    let by_id: HashMap<&str, &Block> = rows.iter().map(|r| (r.id.as_str(), r)).collect();
    let mut top: Vec<&Block> = rows.iter().filter(|r| r.parent_block_id.is_none()).collect();
    top.sort_by(|a, b| a.position.total_cmp(&b.position).then(a.id.cmp(&b.id)));
    let start = match mode {
        WriteMode::Append => top.last().map_or(0.0, |b| b.position.floor() + 1.0),
        WriteMode::Replace => 0.0,
    };
    // Old childless top-level blocks that new ones may keep the identity of, by content.
    let mut reusable: HashMap<(String, String), Vec<String>> = HashMap::new();
    if mode == WriteMode::Replace {
        let has_children: HashSet<&str> = rows.iter().filter_map(|r| r.parent_block_id.as_deref()).collect();
        for r in &top {
            if round_trips(&r.block_type) && !has_children.contains(r.id.as_str()) {
                let b = Blk::from_row(&r.block_type, &r.data_json, r.schema_version);
                reusable
                    .entry((r.block_type.clone(), b.data().to_string()))
                    .or_default()
                    .push(r.id.clone());
            }
        }
    }
    let mut kept: HashSet<String> = HashSet::new();
    let mut upserts: Vec<BlockUpsert> = Vec::new();
    for (i, b) in new.iter().enumerate() {
        let position = start + i as f64;
        if let Some(id) = keep_marker(b) {
            // Only markers for blocks this page has and that were not already placed.
            if let Some(row) = by_id.get(id.as_str()).filter(|r| r.parent_block_id.is_none()) {
                if mode == WriteMode::Replace && kept.insert(id.clone()) {
                    upserts.push(BlockUpsert {
                        id: row.id.clone(),
                        parent_block_id: None,
                        block_type: row.block_type.clone(),
                        position,
                        data_json: row.data_json.clone(),
                        schema_version: row.schema_version,
                    });
                }
            }
            continue;
        }
        let mut flat = blocks::flatten(std::slice::from_ref(b));
        if b.children.is_empty() {
            if let Some(id) = reusable
                .get_mut(&(b.kind.clone(), b.data().to_string()))
                .and_then(|ids| ids.pop())
            {
                flat[0].id = id.clone();
                kept.insert(id);
            }
        }
        flat[0].position = position;
        upserts.extend(flat);
    }
    let delete_ids: Vec<String> = match mode {
        WriteMode::Append => vec![],
        WriteMode::Replace => top
            .iter()
            .filter(|r| !kept.contains(&r.id))
            .map(|r| r.id.clone())
            .collect(),
    };
    // Kept blocks are rewritten unchanged; only the rest counts as a change.
    let changed = upserts.iter().filter(|u| !kept.contains(&u.id)).count() + delete_ids.len();
    if upserts.len() + delete_ids.len() > crate::domain::MAX_BATCH_OPS {
        return Err(AppError::Validation("too many blocks in one write".into()));
    }
    for u in &upserts {
        crate::domain::validate_block_type(&u.block_type)?;
        debug_assert!(u.schema_version <= BLOCK_SCHEMA_VERSION);
    }
    if changed == 0 {
        return Ok(0);
    }
    crate::services::block::apply_batch_in(
        tx,
        &BlockBatch {
            page_id: page.id.clone(),
            upserts,
            delete_ids,
        },
    )?;
    Ok(changed)
}

/// Rewrites `[[target]]` in this workspace's unresolved links now that `page` answers to it.
/// Called whenever a page is created or renamed, or gains an alias.
pub fn resolve_pending(tx: &Connection, page: &Page) -> AppResult<usize> {
    if page.deleted_at.is_some() {
        return Ok(0);
    }
    let mut names = vec![norm(&page.title)];
    let mut alias = tx.prepare("SELECT alias_norm FROM page_alias WHERE page_id = ?1")?;
    for a in alias.query_map([&page.id], |r| r.get::<_, String>(0))? {
        names.push(a?);
    }
    names.retain(|n| !n.is_empty());
    let mut blocks_to_fix: Vec<String> = Vec::new();
    for n in &names {
        let mut stmt = tx.prepare_cached(
            "SELECT source_block_id FROM page_link_unresolved WHERE workspace_id = ?1 AND target_norm = ?2",
        )?;
        for id in stmt.query_map(params![page.workspace_id, n], |r| r.get::<_, String>(0))? {
            let id = id?;
            if !blocks_to_fix.contains(&id) {
                blocks_to_fix.push(id);
            }
        }
    }
    let mut fixed = 0;
    for id in blocks_to_fix {
        let Some(row) = repo::block::get(tx, &id)? else {
            continue;
        };
        let mut b = Blk::from_row(&row.block_type, &row.data_json, row.schema_version);
        let before = b.data().to_string();
        let inline = std::mem::take(&mut b.inline);
        b.inline = link_inlines(tx, &page.workspace_id, inline)?;
        let after = b.data().to_string();
        if after == before {
            continue;
        }
        // Keep the block's other attributes: only its rich text changes.
        let mut data: serde_json::Value = serde_json::from_str(&row.data_json).unwrap_or_default();
        if let (Some(obj), Some(content)) = (data.as_object_mut(), b.data().get("content").cloned()) {
            obj.insert("content".into(), content);
        } else {
            continue;
        }
        let data_json = data.to_string();
        repo::block::update(
            tx,
            &Block {
                data_json: data_json.clone(),
                updated_at: crate::domain::now(),
                ..row.clone()
            },
        )?;
        crate::search::index::upsert_block(
            tx,
            &page.workspace_id,
            &row.page_id,
            &row.id,
            &row.block_type,
            row.schema_version,
            &data_json,
        )?;
        fixed += 1;
    }
    Ok(fixed)
}

/// Replaces a page's aliases.
pub fn set_aliases(tx: &Connection, page: &Page, aliases: &[String]) -> AppResult<()> {
    if aliases.len() > 20 {
        return Err(AppError::Validation("a page can have up to 20 aliases".into()));
    }
    tx.execute("DELETE FROM page_alias WHERE page_id = ?1", [&page.id])?;
    for a in aliases {
        let a = a.trim();
        if a.is_empty() || a.chars().count() > 200 {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO page_alias (page_id, workspace_id, alias, alias_norm) VALUES (?1, ?2, ?3, ?4)",
            params![page.id, page.workspace_id, a, norm(a)],
        )?;
    }
    resolve_pending(tx, page)?;
    Ok(())
}

pub fn aliases(conn: &Connection, page_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT alias FROM page_alias WHERE page_id = ?1 ORDER BY alias")?;
    let rows = stmt.query_map([page_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

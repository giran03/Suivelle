//! Shared memory: records in each workspace's Memory database. Memories are never edited in place
//! by agents: a new memory supersedes an old one, and forgetting marks it expired, so the history
//! of what was believed, by whom and why stays readable.

use super::hub::{self, Hub};
use super::ops::{apply_direct, Op};
use super::Agent;
use crate::databases::service::{load_properties, load_rows};
use crate::databases::Property;
use crate::errors::{AppError, AppResult};
use crate::search;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub page_id: String,
    pub workspace_id: String,
    pub title: String,
    pub values: Map<String, Value>,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recall {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Include superseded, expired and disputed memories.
    #[serde(default)]
    pub include_inactive: bool,
    /// Load each memory's text (default true); false lists titles and ids only.
    #[serde(default)]
    pub include_body: Option<bool>,
    #[serde(default)]
    pub limit: Option<usize>,
}

fn hubs(
    conn: &Connection,
    agent: &Agent,
    workspace: Option<&str>,
) -> AppResult<Vec<(String, Hub)>> {
    let mut out = Vec::new();
    for ws in &agent.workspace_ids {
        if workspace.is_some_and(|w| w != ws) {
            continue;
        }
        if let Some(h) = hub::get(conn, ws)? {
            out.push((ws.clone(), h));
        }
    }
    Ok(out)
}

fn text_of(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or_default().to_string()
}

/// A scope as stored: trimmed, inner whitespace collapsed.
pub(crate) fn clean_scope(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// How well a memory's scope fits the scope asked for: 0 when they are the same or one sits
/// inside the other at a word boundary ("suivelle" and "suivelle/mcp"), 1 for a memory with no
/// scope (it applies everywhere, after the scoped ones), `None` for another scope.
pub fn scope_fit(have: &str, want: &str) -> Option<u8> {
    let have = clean_scope(have).to_lowercase();
    let want = clean_scope(want).to_lowercase();
    if have.is_empty() {
        return Some(1);
    }
    let inside = |a: &str, b: &str| {
        a == b || (a.starts_with(b) && !a[b.len()..].starts_with(char::is_alphanumeric))
    };
    (inside(&have, &want) || inside(&want, &have)).then_some(0)
}

/// A BM25 rank (negative, lower is better) eased towards zero as a memory ages: by an eighth at
/// six months and never more than a quarter. Among memories matching the same words in the
/// same scope, a newer one wins close calls; it never outranks a memory matching more words.
fn aged(rank: f64, created_at: &str, now: chrono::DateTime<chrono::Utc>) -> f64 {
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(created_at) else {
        return rank;
    };
    let days = (now - at.with_timezone(&chrono::Utc)).num_days().max(0) as f64;
    rank * (1.0 - 0.25 * days / (days + 180.0))
}

/// Memories in the agent's workspaces, best match first. With a query, memories containing
/// more of its words come first (words may be spread over the title, the text and the scope),
/// then those in the asked scope, then by rank. Without a query, newest first. Memories with
/// no scope come after those in the asked scope.
pub fn recall(conn: &Connection, agent: &Agent, q: &Recall) -> AppResult<Vec<Memory>> {
    let limit = q.limit.unwrap_or(10).clamp(1, 50);
    let scope = q.scope.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let query = q.query.trim();
    // (words matched, scope fit, rank, memory), sorted once across workspaces.
    let mut found: Vec<(usize, u8, f64, Memory)> = Vec::new();
    for (ws, hub) in hubs(conn, agent, q.workspace_id.as_deref())? {
        let props = load_properties(conn, &hub.memory_database_id)?;
        // Candidates as (record id, page id, words matched, rank).
        let candidates: Vec<(String, String, usize, f64)> = if query.is_empty() {
            let mut stmt = conn.prepare_cached(
                "SELECT r.id, p.id FROM db_record r JOIN page p ON p.id = r.page_id
                 WHERE r.database_id = ?1 AND p.deleted_at IS NULL
                 ORDER BY p.created_at DESC, p.id DESC LIMIT 5000",
            )?;
            let rows = stmt.query_map([&hub.memory_database_id], |r| {
                Ok((r.get(0)?, r.get(1)?, 0, 0.0))
            })?;
            rows.collect::<Result<_, _>>()?
        } else {
            search::records_matching(conn, &ws, &hub.memory_database_id, query, 200)?
                .into_iter()
                .map(|h| (h.record_id, h.page_id, h.coverage, h.score))
                .collect()
        };
        // Without a query, candidates arrive newest first, so the scan stops once enough memories
        // fit the scope (memories with no scope never count). Search hits (at most 200) are all
        // ranked, since age and scope can reorder them.
        let mut fitting = 0;
        let now = chrono::Utc::now();
        'chunks: for chunk in candidates.chunks(64) {
            let ids: Vec<String> = chunk.iter().map(|c| c.0.clone()).collect();
            for row in load_rows(conn, &ids)? {
                let Some(c) = chunk.iter().find(|c| c.0 == row.id) else {
                    continue;
                };
                let values = hub::readable_without_relations(conn, &props, &row.values);
                let status = text_of(values.get("Status"));
                if !q.include_inactive && !status.is_empty() && status != "Active" {
                    continue;
                }
                if let Some(k) = &q.kind {
                    if !text_of(values.get("Kind")).eq_ignore_ascii_case(k) {
                        continue;
                    }
                }
                let fit = match scope {
                    None => 0,
                    Some(s) => match scope_fit(&text_of(values.get("Scope")), s) {
                        Some(f) => f,
                        None => continue,
                    },
                };
                found.push((
                    c.2,
                    fit,
                    aged(c.3, &row.created_at, now),
                    Memory {
                        page_id: row.page_id.clone(),
                        workspace_id: ws.clone(),
                        title: row.title.clone(),
                        values,
                        body: String::new(),
                        created_at: row.created_at.clone(),
                        updated_at: row.updated_at.clone(),
                    },
                ));
                if fit == 0 {
                    fitting += 1;
                }
                if fitting >= limit && query.is_empty() {
                    break 'chunks;
                }
            }
        }
    }
    found.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(a.1.cmp(&b.1))
            .then(a.2.total_cmp(&b.2))
            .then(b.3.created_at.cmp(&a.3.created_at))
    });
    found.truncate(limit);
    let with_body = q.include_body.unwrap_or(true);
    Ok(found
        .into_iter()
        .map(|(_, _, _, mut m)| {
            if with_body {
                m.body = super::content::body_markdown(conn, &m.page_id).unwrap_or_default();
            }
            m
        })
        .collect())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Write {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub confidence: Option<String>,
    /// A memory (page id) this one replaces; it is marked superseded.
    #[serde(default)]
    pub supersedes: Option<String>,
    /// "2026-12-31": after this day the janitor marks it expired.
    #[serde(default)]
    pub expires: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

fn ensure_hub(conn: &mut Connection, ws: &str) -> AppResult<Hub> {
    if let Some(h) = hub::get(conn, ws)? {
        return Ok(h);
    }
    let tx = conn.transaction()?;
    let h = hub::ensure(&tx, ws)?;
    tx.commit()?;
    Ok(h)
}

fn memory_record(
    conn: &Connection,
    agent: &Agent,
    page_id: &str,
) -> AppResult<(Hub, Vec<Property>)> {
    let page = agent.page(conn, page_id)?;
    let hub =
        hub::get(conn, &page.workspace_id)?.ok_or_else(|| AppError::NotFound("memory".into()))?;
    let in_memory: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM db_record WHERE page_id = ?1 AND database_id = ?2)",
        params![page_id, hub.memory_database_id],
        |r| r.get(0),
    )?;
    if !in_memory {
        return Err(AppError::Validation("That page is not a memory.".into()));
    }
    let props = load_properties(conn, &hub.memory_database_id)?;
    Ok((hub, props))
}

/// Longest memory text accepted, in characters. Longer notes belong on a page that a short
/// memory links to; long memories crowd every context pack they appear in.
pub const MAX_BODY_CHARS: usize = 2000;

/// What `write` did.
#[derive(Debug)]
pub struct Written {
    pub id: String,
    pub changed: Vec<String>,
    /// The same memory was already recorded, so nothing was written.
    pub existing: bool,
    /// An active memory in the same scope that looks like the same claim: (page id, title).
    pub similar: Option<(String, String)>,
}

fn words(s: &str) -> HashSet<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|w| w.chars().count() > 1 && !search::text::STOPWORDS.contains(&w.as_str()))
        .collect()
}

/// Share of words two titles have in common (Jaccard), 0–1.
pub(crate) fn overlap(a: &str, b: &str) -> f64 {
    let (a, b) = (words(a), words(b));
    let union = a.union(&b).count();
    if union == 0 {
        return 0.0;
    }
    a.intersection(&b).count() as f64 / union as f64
}

/// The newest live memory that directly supersedes `page_id`, if any.
fn superseded_by(conn: &Connection, page_id: &str) -> AppResult<Option<(String, String)>> {
    let mut stmt = conn.prepare_cached(
        "SELECT p.id, p.title, p.created_at FROM db_record o
             JOIN db_relation rel ON rel.to_record_id = o.id
             JOIN db_property pr ON pr.id = rel.property_id AND pr.name = 'Supersedes'
             JOIN db_record n ON n.id = rel.from_record_id
             JOIN page p ON p.id = n.page_id
         WHERE o.page_id = ?1 AND p.deleted_at IS NULL
         UNION
         SELECT p.id, p.title, p.created_at FROM db_record o
             JOIN db_relation rel ON rel.from_record_id = o.id
             JOIN db_property pr ON pr.id = rel.property_id AND pr.name = 'Superseded by'
             JOIN db_record n ON n.id = rel.to_record_id
             JOIN page p ON p.id = n.page_id
         WHERE o.page_id = ?1 AND p.deleted_at IS NULL
         ORDER BY 3 DESC LIMIT 1",
    )?;
    let mut rows = stmt.query_map([page_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.next().transpose()?)
}

/// The end of `page_id`'s supersede chain, when something replaced it.
fn current(conn: &Connection, page_id: &str) -> AppResult<Option<(String, String)>> {
    let mut at = None;
    let mut seen = HashSet::from([page_id.to_string()]);
    let mut id = page_id.to_string();
    while let Some(next) = superseded_by(conn, &id)? {
        if !seen.insert(next.0.clone()) || seen.len() > 50 {
            break;
        }
        id = next.0.clone();
        at = Some(next);
    }
    Ok(at)
}

fn status_of(conn: &Connection, props: &[Property], page_id: &str) -> AppResult<String> {
    let record: String = conn.query_row(
        "SELECT id FROM db_record WHERE page_id = ?1",
        [page_id],
        |r| r.get(0),
    )?;
    Ok(load_rows(conn, &[record])?
        .first()
        .map(|r| text_of(hub::readable_without_relations(conn, props, &r.values).get("Status")))
        .unwrap_or_default())
}

/// Records a memory. Recording exactly what an active memory in the same scope already says
/// writes nothing and returns that memory. A memory that was already replaced cannot be
/// superseded again: the error names the one that replaced it.
pub fn write(conn: &mut Connection, agent: &Agent, w: Write) -> AppResult<Written> {
    let title = w.title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Validation("A memory needs a title.".into()));
    }
    let body_chars = w.body.trim().chars().count();
    if body_chars > MAX_BODY_CHARS {
        return Err(AppError::Validation(format!(
            "The memory text is {body_chars} characters; keep it under {MAX_BODY_CHARS}. Put the details on a page and link it from a short memory with [[Page title]]."
        )));
    }
    let scope = w
        .scope
        .as_deref()
        .map(clean_scope)
        .filter(|s| !s.is_empty());
    let ws = match (&w.supersedes, &w.workspace_id) {
        (Some(old), _) => agent.page(conn, old)?.workspace_id,
        (None, asked) => agent.workspace(asked.as_deref())?,
    };
    let hub = ensure_hub(conn, &ws)?;
    let mut similar = None;
    if let Some(old) = &w.supersedes {
        let (_, props) = memory_record(conn, agent, old)?;
        if status_of(conn, &props, old)? == "Superseded" {
            if let Some((id, t)) = current(conn, old)? {
                return Err(AppError::Validation(format!(
                    "That memory was already replaced by {id} \"{t}\". Pass supersedes={id} if this replaces that one."
                )));
            }
        }
    } else {
        let near = recall(
            conn,
            agent,
            &Recall {
                query: title.clone(),
                scope: scope.clone(),
                workspace_id: Some(ws.clone()),
                limit: Some(5),
                ..Default::default()
            },
        )?;
        let want_scope = scope.clone().unwrap_or_default().to_lowercase();
        for m in near {
            if clean_scope(&text_of(m.values.get("Scope"))).to_lowercase() != want_scope {
                continue;
            }
            if super::content::norm(&m.title) == super::content::norm(&title)
                && super::content::norm(&m.body) == super::content::norm(&w.body)
            {
                return Ok(Written {
                    id: m.page_id,
                    changed: Vec::new(),
                    existing: true,
                    similar: None,
                });
            }
            if similar.is_none() && overlap(&m.title, &title) >= 0.6 {
                similar = Some((m.page_id.clone(), m.title.clone()));
            }
        }
    }
    let mut values = Map::new();
    values.insert(
        "Kind".into(),
        json!(w.kind.clone().unwrap_or_else(|| "Fact".into())),
    );
    values.insert("Status".into(), json!("Active"));
    values.insert(
        "Confidence".into(),
        json!(w.confidence.clone().unwrap_or_else(|| "Stated".into())),
    );
    values.insert("Source".into(), json!(agent.name));
    if let Some(s) = &scope {
        values.insert("Scope".into(), json!(s));
    }
    if let Some(e) = w.expires.as_ref().filter(|s| !s.trim().is_empty()) {
        values.insert("Expires".into(), json!(e.trim()));
    }
    if let Some(old) = &w.supersedes {
        values.insert("Supersedes".into(), json!([old]));
    }
    let mut ops = vec![Op::CreateRecord {
        key: Some("memory".into()),
        database: hub.memory_database_id.clone(),
        title: title.clone(),
        values,
        markdown: w.body,
    }];
    if let Some(old) = &w.supersedes {
        let mut v = Map::new();
        v.insert("Status".into(), json!("Superseded"));
        ops.push(Op::SetValues {
            page_id: old.clone(),
            values: v,
        });
    }
    let fx = apply_direct(conn, agent, &format!("Memory: {title}"), &ops)?;
    let id = fx
        .created
        .iter()
        .find(|(k, _)| k == "memory")
        .map(|(_, id)| id.clone())
        .ok_or_else(|| AppError::Internal("memory was not created".into()))?;
    Ok(Written {
        id,
        changed: fx.page_ids,
        existing: false,
        similar,
    })
}

/// Marks a memory expired, noting why.
pub fn forget(
    conn: &mut Connection,
    agent: &Agent,
    page_id: &str,
    reason: &str,
) -> AppResult<Vec<String>> {
    memory_record(conn, agent, page_id)?;
    let mut v = Map::new();
    v.insert("Status".into(), json!("Expired"));
    let mut ops = vec![Op::SetValues {
        page_id: page_id.into(),
        values: v,
    }];
    if !reason.trim().is_empty() {
        ops.push(Op::UpdateContent {
            page_id: page_id.into(),
            markdown: format!("> Forgotten by {}: {}", agent.name, reason.trim()),
            append: true,
            base_hash: None,
        });
    }
    Ok(apply_direct(conn, agent, "Forget a memory", &ops)?.page_ids)
}

/// How [`render`] shows memories.
#[derive(Debug, Default, Clone, Copy)]
pub struct Style<'a> {
    /// Characters of each memory's text to show; 0 shows titles only.
    pub body_chars: usize,
    /// The scope that was asked for; memories in it don't repeat it.
    pub scope: Option<&'a str>,
    /// The calling agent; its own memories don't name their source.
    pub agent: Option<&'a str>,
}

/// `s` cut to about `max` characters at a line or word break, and whether it was cut.
pub fn excerpt(s: &str, max: usize) -> (&str, bool) {
    let Some((end, _)) = s.char_indices().nth(max) else {
        return (s, false);
    };
    let head = &s[..end];
    let cut = head
        .rfind('\n')
        .filter(|&i| i > end / 2)
        .or_else(|| head.rfind(' ').filter(|&i| i > end / 2))
        .unwrap_or(end);
    (s[..cut].trim_end(), true)
}

/// Memories as compact Markdown, for tool results and context packs. Defaults are left out:
/// an Active status, Stated confidence, the asked scope and the caller as source.
pub fn render(list: &[Memory], style: Style) -> String {
    let mut out = String::new();
    for m in list {
        out.push_str(&render_one(m, style));
    }
    if out.is_empty() {
        out.push_str("No memories match.\n");
    }
    out
}

/// One memory as a Markdown bullet (see [`render`]).
pub fn render_one(m: &Memory, style: Style) -> String {
    let get = |k: &str| text_of(m.values.get(k));
    let mut tags = vec![get("Kind")];
    let confidence = get("Confidence");
    if confidence != "Stated" {
        tags.push(confidence);
    }
    let status = get("Status");
    if status != "Active" {
        tags.push(status);
    }
    tags.retain(|t| !t.is_empty());
    let mut meta = vec![format!("id {}", m.page_id)];
    let scope = get("Scope");
    if !scope.is_empty()
        && !style
            .scope
            .is_some_and(|s| clean_scope(s).eq_ignore_ascii_case(&scope))
    {
        meta.push(format!("scope {scope}"));
    }
    let source = get("Source");
    if !source.is_empty() && style.agent != Some(source.as_str()) {
        meta.push(format!("by {source}"));
    }
    meta.push(m.created_at[..m.created_at.len().min(10)].to_string());
    let expires = get("Expires");
    if !expires.is_empty() {
        meta.push(format!("expires {}", &expires[..expires.len().min(10)]));
    }
    let tags = if tags.is_empty() {
        String::new()
    } else {
        format!("[{}] ", tags.join(" · "))
    };
    let mut out = format!("- {tags}**{}** ({})\n", m.title, meta.join(" · "));
    let body = m.body.trim();
    if style.body_chars > 0 && !body.is_empty() {
        let (text, cut) = excerpt(body, style.body_chars);
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            out.push_str(&format!("  {}\n", line.trim_end()));
        }
        if cut {
            out.push_str(&format!("  … (page_read {} for the rest)\n", m.page_id));
        }
    }
    out
}

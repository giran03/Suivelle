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
    #[serde(default)]
    pub limit: Option<usize>,
}

fn hubs(conn: &Connection, agent: &Agent, workspace: Option<&str>) -> AppResult<Vec<(String, Hub)>> {
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

/// Memories in the agent's workspaces, best match first. Without a query, newest first.
pub fn recall(conn: &Connection, agent: &Agent, q: &Recall) -> AppResult<Vec<Memory>> {
    let limit = q.limit.unwrap_or(10).clamp(1, 50);
    let mut out = Vec::new();
    for (ws, hub) in hubs(conn, agent, q.workspace_id.as_deref())? {
        let props = load_properties(conn, &hub.memory_database_id)?;
        // Candidate record pages: search hits when there is a query, otherwise the newest.
        let mut ids: Vec<String> = Vec::new();
        if !q.query.trim().is_empty() {
            let hits = search::search(
                conn,
                &search::SearchInput {
                    workspace_id: ws.clone(),
                    query: q.query.chars().take(search::MAX_QUERY_CHARS).collect(),
                    titles_only: false,
                    modified_within_days: None,
                    limit: Some(search::MAX_LIMIT),
                    offset: None,
                },
            )
            .unwrap_or_default();
            let mut seen = HashSet::new();
            for h in hits {
                if seen.insert(h.page_id.clone()) {
                    ids.push(h.page_id);
                }
            }
        }
        let mut stmt = conn.prepare(
            "SELECT r.id, p.id FROM db_record r JOIN page p ON p.id = r.page_id
             WHERE r.database_id = ?1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 500",
        )?;
        let rows: Vec<(String, String)> = stmt
            .query_map([&hub.memory_database_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let record_of: std::collections::HashMap<&str, &str> = rows.iter().map(|(r, p)| (p.as_str(), r.as_str())).collect();
        let ordered: Vec<String> = if q.query.trim().is_empty() {
            rows.iter().map(|(_, p)| p.clone()).collect()
        } else {
            // Search hits first (in rank order), then title matches the index missed.
            let needle = q.query.to_lowercase();
            let mut v: Vec<String> = ids.into_iter().filter(|p| record_of.contains_key(p.as_str())).collect();
            for (_, p) in &rows {
                if !v.contains(p) {
                    let title: String = conn
                        .query_row("SELECT title FROM page WHERE id = ?1", [p], |r| r.get(0))
                        .unwrap_or_default();
                    if title.to_lowercase().contains(&needle) {
                        v.push(p.clone());
                    }
                }
            }
            v
        };
        let record_ids: Vec<String> = ordered.iter().filter_map(|p| record_of.get(p.as_str()).map(|r| r.to_string())).collect();
        let loaded = load_rows(conn, &record_ids)?;
        for page_id in &ordered {
            let Some(row) = loaded.iter().find(|r| &r.page_id == page_id) else { continue };
            let values = hub::readable(conn, &props, &row.values);
            let status = text_of(values.get("Status"));
            if !q.include_inactive && !status.is_empty() && status != "Active" {
                continue;
            }
            if let Some(k) = &q.kind {
                if !text_of(values.get("Kind")).eq_ignore_ascii_case(k) {
                    continue;
                }
            }
            if let Some(s) = &q.scope {
                let scope = text_of(values.get("Scope"));
                if !scope.is_empty() && !scope.to_lowercase().contains(&s.to_lowercase()) {
                    continue;
                }
            }
            out.push(Memory {
                page_id: row.page_id.clone(),
                workspace_id: ws.clone(),
                title: row.title.clone(),
                values,
                body: super::content::body_markdown(conn, &row.page_id).unwrap_or_default(),
                created_at: row.created_at.clone(),
                updated_at: row.updated_at.clone(),
            });
            if out.len() >= limit {
                return Ok(out);
            }
        }
    }
    Ok(out)
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

fn memory_record(conn: &Connection, agent: &Agent, page_id: &str) -> AppResult<(Hub, Vec<Property>)> {
    let page = agent.page(conn, page_id)?;
    let hub = hub::get(conn, &page.workspace_id)?.ok_or_else(|| AppError::NotFound("memory".into()))?;
    let in_memory: bool = conn
        .query_row(
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

/// Records a memory. Returns its page id and the pages changed.
pub fn write(conn: &mut Connection, agent: &Agent, w: Write) -> AppResult<(String, Vec<String>)> {
    let ws = match (&w.supersedes, &w.workspace_id) {
        (Some(old), _) => agent.page(conn, old)?.workspace_id,
        (None, asked) => agent.workspace(asked.as_deref())?,
    };
    let hub = ensure_hub(conn, &ws)?;
    if let Some(old) = &w.supersedes {
        memory_record(conn, agent, old)?;
    }
    let mut values = Map::new();
    values.insert("Kind".into(), json!(w.kind.clone().unwrap_or_else(|| "Fact".into())));
    values.insert("Status".into(), json!("Active"));
    values.insert("Confidence".into(), json!(w.confidence.clone().unwrap_or_else(|| "Stated".into())));
    values.insert("Source".into(), json!(agent.name));
    if let Some(s) = w.scope.as_ref().filter(|s| !s.trim().is_empty()) {
        values.insert("Scope".into(), json!(s.trim()));
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
        title: w.title.trim().to_string(),
        values,
        markdown: w.body,
    }];
    if let Some(old) = &w.supersedes {
        let mut v = Map::new();
        v.insert("Status".into(), json!("Superseded"));
        ops.push(Op::SetValues { page_id: old.clone(), values: v });
    }
    let fx = apply_direct(conn, agent, &format!("Memory: {}", w.title.trim()), &ops)?;
    let id = fx
        .created
        .iter()
        .find(|(k, _)| k == "memory")
        .map(|(_, id)| id.clone())
        .ok_or_else(|| AppError::Internal("memory was not created".into()))?;
    Ok((id, fx.page_ids))
}

/// Marks a memory expired, noting why.
pub fn forget(conn: &mut Connection, agent: &Agent, page_id: &str, reason: &str) -> AppResult<Vec<String>> {
    memory_record(conn, agent, page_id)?;
    let mut v = Map::new();
    v.insert("Status".into(), json!("Expired"));
    let mut ops = vec![Op::SetValues { page_id: page_id.into(), values: v }];
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

/// Memories as Markdown, for tool results and context packs.
pub fn render(list: &[Memory], with_body: bool) -> String {
    let mut out = String::new();
    for m in list {
        let meta: Vec<String> = ["Kind", "Status", "Confidence", "Scope", "Source", "Expires"]
            .iter()
            .filter_map(|k| m.values.get(*k).map(|v| format!("{k}: {}", v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))))
            .collect();
        out.push_str(&format!("- **{}** (id {}; {}; {})\n", m.title, m.page_id, meta.join(", "), &m.created_at[..m.created_at.len().min(10)]));
        if with_body && !m.body.trim().is_empty() {
            for line in m.body.lines().take(12) {
                out.push_str(&format!("  {line}\n"));
            }
        }
    }
    if out.is_empty() {
        out.push_str("No memories match.\n");
    }
    out
}

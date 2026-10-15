//! Graph traversal and context packs: what an agent needs to know about a page, its neighbours
//! and the shared memory, in one bounded Markdown document.

use super::{content, memory, tasks, Agent};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub page_id: String,
    pub title: String,
    /// "parent", "child", "links to", "linked from", or a relation property's name.
    pub via: String,
}

/// The pages directly connected to `page_id`, within the agent's workspaces.
pub fn adjacent(conn: &Connection, agent: &Agent, page_id: &str) -> AppResult<Vec<Link>> {
    let scope = serde_json::to_string(&agent.workspace_ids).unwrap_or_default();
    let mut stmt = conn.prepare_cached(
        "WITH n(id, via) AS (
             SELECT parent_page_id, 'parent' FROM page WHERE id = ?1 AND parent_page_id IS NOT NULL
             UNION ALL SELECT id, 'child' FROM page WHERE parent_page_id = ?1
             UNION ALL SELECT target_page_id, 'links to' FROM page_reference WHERE source_page_id = ?1
             UNION ALL SELECT source_page_id, 'linked from' FROM page_reference WHERE target_page_id = ?1
             UNION ALL SELECT tb.page_id, pr.name FROM db_record ra
                 JOIN db_relation r ON r.from_record_id = ra.id
                 JOIN db_record tb ON tb.id = r.to_record_id
                 JOIN db_property pr ON pr.id = r.property_id
                 WHERE ra.page_id = ?1
             UNION ALL SELECT ra.page_id, pr.name FROM db_record tb
                 JOIN db_relation r ON r.to_record_id = tb.id
                 JOIN db_record ra ON ra.id = r.from_record_id
                 JOIN db_property pr ON pr.id = r.property_id
                 WHERE tb.page_id = ?1
         )
         SELECT DISTINCT n.id, p.title, n.via FROM n JOIN page p ON p.id = n.id
         WHERE p.deleted_at IS NULL AND p.id <> ?1 AND p.workspace_id IN (SELECT value FROM json_each(?2))
         LIMIT 400",
    )?;
    let rows = stmt.query_map(params![page_id, scope], |r| {
        Ok(Link {
            page_id: r.get(0)?,
            title: r.get(1)?,
            via: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Neighborhood {
    pub center: String,
    /// Pages by distance: (page id, title, hops, how it was reached from the previous page).
    pub pages: Vec<(String, String, u8, String)>,
    pub truncated: bool,
}

/// Breadth-first walk up to `hops` (1–3) from `page_id`, at most `limit` pages.
pub fn neighbors(conn: &Connection, agent: &Agent, page_id: &str, hops: u8, limit: usize) -> AppResult<Neighborhood> {
    let center = agent.page(conn, page_id)?;
    let hops = hops.clamp(1, 3);
    let limit = limit.clamp(1, 500);
    let mut seen: HashSet<String> = HashSet::from([center.id.clone()]);
    let mut queue = VecDeque::from([(center.id.clone(), 0u8)]);
    let mut pages = Vec::new();
    let mut truncated = false;
    while let Some((id, d)) = queue.pop_front() {
        if d >= hops {
            continue;
        }
        for l in adjacent(conn, agent, &id)? {
            if seen.insert(l.page_id.clone()) {
                if pages.len() >= limit {
                    truncated = true;
                    break;
                }
                pages.push((l.page_id.clone(), l.title, d + 1, l.via));
                queue.push_back((l.page_id, d + 1));
            }
        }
        if truncated {
            break;
        }
    }
    Ok(Neighborhood {
        center: center.id,
        pages,
        truncated,
    })
}

/// The shortest chain of connections between two pages (up to `max_hops`), if any.
pub fn path(conn: &Connection, agent: &Agent, from: &str, to: &str, max_hops: u8) -> AppResult<Option<Vec<Link>>> {
    let a = agent.page(conn, from)?;
    let b = agent.page(conn, to)?;
    if a.id == b.id {
        return Ok(Some(vec![]));
    }
    let max_hops = max_hops.clamp(1, 6);
    let mut prev: HashMap<String, (String, Link)> = HashMap::new();
    let mut queue = VecDeque::from([(a.id.clone(), 0u8)]);
    let mut seen = HashSet::from([a.id.clone()]);
    while let Some((id, d)) = queue.pop_front() {
        if d >= max_hops || seen.len() > 5000 {
            break;
        }
        for l in adjacent(conn, agent, &id)? {
            if !seen.insert(l.page_id.clone()) {
                continue;
            }
            let next = l.page_id.clone();
            prev.insert(next.clone(), (id.clone(), l));
            if next == b.id {
                let mut chain = Vec::new();
                let mut cur = next;
                while let Some((p, link)) = prev.remove(&cur) {
                    chain.push(link);
                    cur = p;
                }
                chain.reverse();
                return Ok(Some(chain));
            }
            queue.push_back((next, d + 1));
        }
    }
    Ok(None)
}

fn first_line(conn: &Connection, page_id: &str) -> String {
    content::body_markdown(conn, page_id)
        .ok()
        .and_then(|b| {
            b.lines()
                .map(str::trim)
                .find(|l| !l.is_empty() && !l.starts_with("<!--") && !l.starts_with('#'))
                .map(|l| l.chars().take(160).collect())
        })
        .unwrap_or_default()
}

/// Cuts `s` to about `max` characters at a line break, saying so.
fn clip(s: &str, max: usize, note: &mut Vec<String>, what: &str) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut cut = 0;
    for (i, _) in s.match_indices('\n') {
        if i > max {
            break;
        }
        cut = i;
    }
    if cut == 0 {
        cut = s.char_indices().take_while(|(i, _)| *i <= max).last().map_or(0, |(i, _)| i);
    }
    note.push(format!("{what} was shortened ({} of {} characters).", cut, s.len()));
    format!("{}\n…", &s[..cut])
}

/// A bounded Markdown briefing: the page, what it connects to, matching memories and the
/// agent's open tasks. `budget_tokens` is approximate (four characters per token).
pub fn pack(conn: &Connection, agent: &Agent, page_id: Option<&str>, query: Option<&str>, budget_tokens: usize) -> AppResult<String> {
    if page_id.is_none() && query.is_none_or(|q| q.trim().is_empty()) {
        return Err(AppError::Validation("Give a page_id, a query, or both.".into()));
    }
    let budget = budget_tokens.clamp(500, 50_000) * 4;
    let mut notes = Vec::new();
    let mut out = format!("# Context for {}\n\n", agent.name);
    let mut topic = query.unwrap_or_default().to_string();
    if let Some(id) = page_id {
        let page = agent.page(conn, id)?;
        if topic.trim().is_empty() {
            topic = page.title.clone();
        }
        let body = content::body_markdown(conn, &page.id)?;
        let hash = content::content_hash(conn, &page.id)?;
        out.push_str(&format!(
            "## Page: {} \n\nid {} · updated {} · hash {}\n\n{}\n\n",
            page.title,
            page.id,
            page.updated_at,
            hash,
            clip(&body, budget * 45 / 100, &mut notes, "The page")
        ));
        let near = adjacent(conn, agent, &page.id)?;
        if !near.is_empty() {
            let mut section = String::from("## Connected pages\n\n");
            for l in near.iter().take(40) {
                let line = first_line(conn, &l.page_id);
                section.push_str(&format!(
                    "- {} — **{}** (id {}){}\n",
                    l.via,
                    l.title,
                    l.page_id,
                    if line.is_empty() { String::new() } else { format!(": {line}") }
                ));
            }
            if near.len() > 40 {
                notes.push(format!("Only 40 of {} connected pages are listed; use graph_neighbors for the rest.", near.len()));
            }
            out.push_str(&clip(&section, budget * 20 / 100, &mut notes, "The connected pages"));
            out.push('\n');
        }
    }
    let memories = memory::recall(
        conn,
        agent,
        &memory::Recall {
            query: topic.clone(),
            limit: Some(12),
            ..Default::default()
        },
    )?;
    let mut generic = Vec::new();
    if memories.len() < 5 {
        generic = memory::recall(conn, agent, &memory::Recall { limit: Some(5), ..Default::default() })?;
        generic.retain(|g| !memories.iter().any(|m| m.page_id == g.page_id));
    }
    if !memories.is_empty() || !generic.is_empty() {
        let mut section = String::from("## Memories\n\n");
        section.push_str(&memory::render(&memories, true));
        if !generic.is_empty() {
            section.push_str("\nRecent, not matched to the topic:\n\n");
            section.push_str(&memory::render(&generic, false));
        }
        out.push_str(&clip(&section, budget * 25 / 100, &mut notes, "The memories"));
        out.push('\n');
    }
    let open = tasks::list(conn, agent, &tasks::ListInput { mine: true, limit: Some(20), ..Default::default() })?
        .into_iter()
        .filter(|t| matches!(t.status().as_str(), "Queued" | "In progress" | "Review"))
        .collect::<Vec<_>>();
    if !open.is_empty() {
        out.push_str("## Your open tasks\n\n");
        out.push_str(&tasks::render(&open));
        out.push('\n');
    }
    if !notes.is_empty() {
        out.push_str("## Left out\n\n");
        for n in notes {
            out.push_str(&format!("- {n}\n"));
        }
    }
    if out.len() > budget {
        let mut cut = budget;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str("\n…(context budget reached)\n");
    }
    Ok(out)
}

/// The workspaces an agent can see, with their names.
pub fn workspaces(conn: &Connection, agent: &Agent) -> AppResult<Vec<(String, String)>> {
    let mut out = Vec::new();
    for w in &agent.workspace_ids {
        if let Some(ws) = repo::workspace::get(conn, w)? {
            out.push((ws.id, ws.name));
        }
    }
    Ok(out)
}

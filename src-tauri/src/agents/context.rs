//! Graph traversal and context packs: what an agent needs to know about a page, its neighbours
//! and the shared memory, in one bounded Markdown document.

use super::{content, memory, tasks, Agent};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
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
pub fn neighbors(
    conn: &Connection,
    agent: &Agent,
    page_id: &str,
    hops: u8,
    limit: usize,
) -> AppResult<Neighborhood> {
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
pub fn path(
    conn: &Connection,
    agent: &Agent,
    from: &str,
    to: &str,
    max_hops: u8,
) -> AppResult<Option<Vec<Link>>> {
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

/// The first text of a page outside headings, at most 160 characters. Reads a few top-level
/// blocks instead of rendering the page.
fn first_line(conn: &Connection, page_id: &str) -> String {
    let Ok(mut stmt) = conn.prepare_cached(
        "SELECT type, schema_version, data_json FROM block
         WHERE page_id = ?1 AND parent_block_id IS NULL AND type NOT LIKE 'heading%'
         ORDER BY position LIMIT 4",
    ) else {
        return String::new();
    };
    let title = |id: &str| {
        conn.query_row(
            "SELECT title FROM page WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| r.get::<_, String>(0),
        )
        .ok()
    };
    let rows = stmt.query_map([page_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
        ))
    });
    let Ok(rows) = rows else {
        return String::new();
    };
    let line = rows
        .flatten()
        .map(|(kind, version, data)| {
            crate::search::text::plain_text_with(&kind, version, &data, &title)
        })
        .find(|t| !t.trim().is_empty())
        .map(|t| t.trim().chars().take(160).collect())
        .unwrap_or_default();
    line
}

/// `title` without a trailing " project" (case-insensitive), when it has one.
fn project_name(title: &str) -> Option<&str> {
    let t = title.trim();
    let n = t.len().checked_sub(" project".len())?;
    (t.is_char_boundary(n) && t[n..].eq_ignore_ascii_case(" project"))
        .then(|| t[..n].trim())
        .filter(|p| !p.is_empty())
}

/// The project a page belongs to: the X of the nearest "X project" page at or above it.
fn project_of(conn: &Connection, page: &crate::domain::Page) -> AppResult<Option<String>> {
    let mut title = page.title.clone();
    let mut parent = page.parent_page_id.clone();
    for _ in 0..12 {
        if let Some(p) = project_name(&title) {
            return Ok(Some(p.to_string()));
        }
        let Some(id) = parent else { break };
        let Some(p) = repo::page::get(conn, &id)? else {
            break;
        };
        title = p.title;
        parent = p.parent_page_id;
    }
    Ok(None)
}

/// The "X project" pages in a workspace: (page id, title), by title.
pub fn project_hubs(conn: &Connection, workspace_id: &str) -> AppResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, title FROM page
         WHERE workspace_id = ?1 AND deleted_at IS NULL AND title LIKE '% project'
           AND NOT EXISTS (SELECT 1 FROM db_record r WHERE r.page_id = page.id)
         ORDER BY title COLLATE NOCASE LIMIT 30",
    )?;
    let rows = stmt.query_map([workspace_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Arguments of [`pack`].
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInput {
    #[serde(default)]
    pub page_id: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    /// A project name: its "X project" page when no page_id is given, and the memory scope.
    #[serde(default)]
    pub project: Option<String>,
    /// The memory scope; inferred from the page's project when not given.
    #[serde(default)]
    pub scope: Option<String>,
    /// The page's hash from an earlier read: when it still matches, the body is not resent.
    #[serde(default)]
    pub known_hash: Option<String>,
    #[serde(default)]
    pub budget_tokens: Option<usize>,
}

/// How connected pages are ordered in a pack: what the page points at first.
fn via_rank(via: &str) -> u8 {
    match via {
        "child" => 0,
        "links to" => 1,
        "parent" => 2,
        "linked from" => 4,
        _ => 3,
    }
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
        cut = s
            .char_indices()
            .take_while(|(i, _)| *i <= max)
            .last()
            .map_or(0, |(i, _)| i);
    }
    note.push(format!(
        "{what} was shortened ({} of {} characters).",
        cut,
        s.len()
    ));
    format!("{}\n…", &s[..cut])
}

/// A bounded Markdown briefing: the page, what it connects to, matching memories and the
/// agent's open tasks. `budget_tokens` is approximate (four characters per token). Items are
/// never cut in half: what does not fit is named under "Left out" with how to get it.
pub fn pack(conn: &Connection, agent: &Agent, input: &PackInput) -> AppResult<String> {
    let given = |s: &Option<String>| {
        s.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    let query = given(&input.query);
    let project = given(&input.project);
    let mut scope = given(&input.scope).or_else(|| project.clone());
    let mut page_id = given(&input.page_id);
    if page_id.is_none() {
        if let Some(p) = &project {
            page_id = super::commands::page_titled(conn, agent, &format!("{p} project"))?;
            if page_id.is_none() && query.is_none() {
                return Err(AppError::Validation(format!(
                    "There is no \"{p} project\" page. Give a query, or set the project up first."
                )));
            }
        }
    }
    if page_id.is_none() && query.is_none() {
        return Err(AppError::Validation(
            "Give a page_id, a project, a query, or a page with a query.".into(),
        ));
    }
    let budget = input.budget_tokens.unwrap_or(6000).clamp(500, 50_000) * 4;
    let mut notes = Vec::new();
    let mut out = format!("# Context for {}\n\n", agent.name);
    let mut topic = query.clone().unwrap_or_default();
    if let Some(id) = &page_id {
        let page = agent.page(conn, id)?;
        if scope.is_none() {
            scope = project_of(conn, &page)?;
        }
        if topic.is_empty() {
            // "X project" as a topic would only find memories that say "project".
            topic = project_name(&page.title).unwrap_or(&page.title).to_string();
        }
        let hash = content::content_hash(conn, &page.id)?;
        let page_share = budget * 45 / 100;
        let head = format!(
            "## Page: {}\n\nid {} · updated {} · hash {}\n\n",
            page.title, page.id, page.updated_at, hash
        );
        let start = out.len();
        out.push_str(&head);
        if input.known_hash.as_deref() == Some(hash.as_str()) {
            out.push_str("Unchanged since you read it (same hash), so the text is left out.\n\n");
        } else {
            let body = content::body_markdown(conn, &page.id)?;
            out.push_str(&clip(
                &body,
                page_share.saturating_sub(head.len()),
                &mut notes,
                "The page",
            ));
            out.push_str("\n\n");
        }
        // Budget the page did not use goes to the connected pages.
        let spare = page_share.saturating_sub(out.len() - start);
        let mut near = adjacent(conn, agent, &page.id)?;
        // Memories and tasks have their own sections; the hub's records would only repeat them.
        let records: HashSet<String> = match super::hub::get(conn, &page.workspace_id)? {
            Some(h) => {
                let ids =
                    serde_json::to_string(&near.iter().map(|l| &l.page_id).collect::<Vec<_>>())
                        .unwrap_or_default();
                let mut stmt = conn.prepare_cached(
                    "SELECT page_id FROM db_record WHERE database_id IN (?1, ?2)
                       AND page_id IN (SELECT value FROM json_each(?3))",
                )?;
                let rows = stmt.query_map(
                    params![h.memory_database_id, h.tasks_database_id, ids],
                    |r| r.get::<_, String>(0),
                )?;
                rows.collect::<Result<_, _>>()?
            }
            None => HashSet::new(),
        };
        near.retain(|l| {
            !records.contains(&l.page_id) && Some(&l.page_id) != agent.instructions_page_id.as_ref()
        });
        near.sort_by_key(|l| via_rank(&l.via));
        if !near.is_empty() {
            let cap = budget * 20 / 100 + spare;
            let mut section = String::from("## Connected pages\n\n");
            let mut listed = 0;
            for l in near.iter().take(40) {
                let line = first_line(conn, &l.page_id);
                let item = format!(
                    "- {} — **{}** (id {}){}\n",
                    l.via,
                    l.title,
                    l.page_id,
                    if line.is_empty() {
                        String::new()
                    } else {
                        format!(": {line}")
                    }
                );
                if section.len() + item.len() > cap {
                    break;
                }
                section.push_str(&item);
                listed += 1;
            }
            if listed < near.len() {
                notes.push(format!(
                    "{listed} of {} connected pages are listed; graph_neighbors(page_id=\"{}\") lists them all.",
                    near.len(),
                    page.id
                ));
            }
            out.push_str(&section);
            out.push('\n');
        }
    }
    let open = tasks::list(
        conn,
        agent,
        &tasks::ListInput {
            mine: true,
            limit: Some(20),
            ..Default::default()
        },
    )?
    .into_iter()
    .filter(|t| matches!(t.status().as_str(), "Queued" | "In progress" | "Review"))
    .collect::<Vec<_>>();
    let tasks_text = if open.is_empty() {
        String::new()
    } else {
        format!("## Your open tasks\n\n{}\n", tasks::render(&open))
    };
    let memories = memory::recall(
        conn,
        agent,
        &memory::Recall {
            query: topic.clone(),
            scope: scope.clone(),
            limit: Some(12),
            ..Default::default()
        },
    )?;
    let mut generic = Vec::new();
    if memories.len() < 5 {
        generic = memory::recall(
            conn,
            agent,
            &memory::Recall {
                scope: scope.clone(),
                include_body: Some(false),
                limit: Some(5),
                ..Default::default()
            },
        )?;
        generic.retain(|g| !memories.iter().any(|m| m.page_id == g.page_id));
    }
    if !memories.is_empty() || !generic.is_empty() {
        // Memories get everything the page and the tasks leave, less room for the notes.
        let cap = budget.saturating_sub(out.len() + tasks_text.len() + 400);
        let style = memory::Style {
            body_chars: 400,
            scope: scope.as_deref(),
            agent: Some(&agent.name),
        };
        let mut section = match &scope {
            Some(s) => format!("## Memories (scope {s})\n\n"),
            None => String::from("## Memories\n\n"),
        };
        let mut skipped = 0;
        for m in &memories {
            let item = memory::render_one(m, style);
            if section.len() + item.len() > cap {
                skipped += 1;
                continue;
            }
            section.push_str(&item);
        }
        if !generic.is_empty() {
            let mut recent = String::from("\nRecent, not matched to the topic:\n\n");
            for m in &generic {
                let item = memory::render_one(
                    m,
                    memory::Style {
                        body_chars: 0,
                        ..style
                    },
                );
                if section.len() + recent.len() + item.len() <= cap {
                    recent.push_str(&item);
                }
            }
            if recent.contains("- ") {
                section.push_str(&recent);
            }
        }
        if skipped > 0 {
            notes.push(format!(
                "{skipped} more matching memories did not fit; memory_recall(query=\"{}\"{}) lists them.",
                topic.replace('"', "'"),
                scope
                    .as_deref()
                    .map(|s| format!(", scope=\"{}\"", s.replace('"', "'")))
                    .unwrap_or_default()
            ));
        }
        out.push_str(&section);
        out.push('\n');
    }
    out.push_str(&tasks_text);
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

// The workspaces an agent can see, with their names.
pub fn workspaces(conn: &Connection, agent: &Agent) -> AppResult<Vec<(String, String)>> {
    let mut out = Vec::new();
    for w in &agent.workspace_ids {
        if let Some(ws) = repo::workspace::get(conn, w)? {
            out.push((ws.id, ws.name));
        }
    }
    Ok(out)
}

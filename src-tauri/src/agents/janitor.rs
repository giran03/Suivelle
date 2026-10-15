//! Vault upkeep: read-only checks for broken links, stray pages, duplicates, tag variants and
//! stale agent memory and tasks. Findings that have an obvious fix carry it as an operation, so
//! fixes go through the same reviewed, revertable path as any other change. Only two fixes run
//! on their own: requeueing tasks whose lease ran out and expiring memories past their date.

use super::content::norm;
use super::hub;
use super::ops::{apply_as, Actor, Op};
use super::tasks;
use crate::databases::service::{load_properties, load_rows};
use crate::errors::AppResult;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub const CHECKS: &[(&str, &str)] = &[
    ("broken_links", "Links and mentions to pages that are in the trash or gone"),
    ("unresolved_links", "[[Wikilinks]] no page answers to, with likely matches"),
    ("duplicate_titles", "Pages in one workspace that share a title"),
    ("empty_pages", "Pages with no content and no subpages, older than a week"),
    ("isolated_pages", "Top-level pages with no subpages and no links in or out"),
    ("tag_variants", "Tags that differ only in case or punctuation"),
    ("memory", "Memories past their expiry date, or superseded but still active"),
    ("tasks", "Agent tasks with an expired lease, stuck in review, or failed"),
    ("proposals", "Proposals waiting for review for more than a week"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub check: String,
    /// "info", "warning" or "problem".
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub page_id: Option<String>,
    /// The suggested fix, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<Op>,
}

fn finding(check: &str, severity: &str, title: String, detail: String, page_id: Option<String>, fix: Option<Op>) -> Finding {
    Finding {
        check: check.into(),
        severity: severity.into(),
        title,
        detail,
        page_id,
        fix,
    }
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != cb)).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Runs `checks` (all of them when empty) over one workspace. At most `limit` findings per check.
pub fn report(conn: &Connection, workspace_id: &str, checks: &[String], limit: usize) -> AppResult<Vec<Finding>> {
    let want = |c: &str| checks.is_empty() || checks.iter().any(|x| x == c);
    let limit = limit.clamp(1, 200) as i64;
    let mut out = Vec::new();

    if want("broken_links") {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT r.source_page_id, s.title, r.target_page_id, t.title, t.deleted_at IS NOT NULL
             FROM page_reference r JOIN page s ON s.id = r.source_page_id AND s.deleted_at IS NULL
             LEFT JOIN page t ON t.id = r.target_page_id
             WHERE s.workspace_id = ?1 AND (t.id IS NULL OR t.deleted_at IS NOT NULL) LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![workspace_id, limit], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, bool>(4)?))
        })?;
        for row in rows {
            let (src, src_title, _target, target_title, trashed) = row?;
            out.push(finding(
                "broken_links",
                "warning",
                format!("“{}” links to a missing page", src_title),
                match (target_title, trashed) {
                    (Some(t), true) => format!("“{t}” is in the trash. Restore it or remove the link."),
                    _ => "The linked page was deleted. Remove the link.".into(),
                },
                Some(src),
                None,
            ));
        }
    }

    if want("unresolved_links") {
        let mut stmt = conn.prepare(
            "SELECT u.target_text, COUNT(*), MIN(u.source_page_id) FROM page_link_unresolved u
             JOIN page p ON p.id = u.source_page_id AND p.deleted_at IS NULL
             WHERE u.workspace_id = ?1 GROUP BY u.target_norm ORDER BY COUNT(*) DESC LIMIT ?2",
        )?;
        let rows: Vec<(String, i64, String)> = stmt
            .query_map(params![workspace_id, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        let titles: Vec<(String, String)> = if rows.is_empty() {
            vec![]
        } else {
            let mut t = conn.prepare("SELECT id, title FROM page WHERE workspace_id = ?1 AND deleted_at IS NULL AND kind = 'page' LIMIT 5000")?;
            let v = t.query_map([workspace_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
            v
        };
        for (text, count, source) in rows {
            let key = norm(&text);
            let close = titles
                .iter()
                .map(|(id, t)| (levenshtein(&key, &norm(t)), id, t))
                .filter(|(d, _, t)| *d <= (key.chars().count() / 4).max(2) && !t.is_empty())
                .min_by_key(|(d, _, _)| *d);
            let (detail, fix) = match close {
                Some((_, id, t)) => (
                    format!("Did you mean “{t}”? Adding “{text}” as its alias links all {count} mention(s)."),
                    Some(Op::SetAliases {
                        page_id: id.clone(),
                        aliases: {
                            let mut a = super::content::aliases(conn, id).unwrap_or_default();
                            a.push(text.clone());
                            a
                        },
                    }),
                ),
                None => (
                    format!("{count} mention(s). Creating a page called “{text}” links them."),
                    Some(Op::CreatePage {
                        key: None,
                        workspace_id: Some(workspace_id.into()),
                        parent: None,
                        title: text.clone(),
                        markdown: String::new(),
                        aliases: vec![],
                    }),
                ),
            };
            out.push(finding("unresolved_links", "info", format!("[[{text}]] has no page"), detail, Some(source), fix));
        }
    }

    if want("duplicate_titles") {
        let mut stmt = conn.prepare(
            "SELECT lower(trim(title)), COUNT(*), group_concat(id) FROM page
             WHERE workspace_id = ?1 AND deleted_at IS NULL AND kind = 'page' AND trim(title) <> ''
             GROUP BY lower(trim(title)) HAVING COUNT(*) > 1 LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![workspace_id, limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))?;
        for row in rows {
            let (title, n, ids) = row?;
            out.push(finding(
                "duplicate_titles",
                "info",
                format!("{n} pages are called “{title}”"),
                "Wikilinks to this title go to the oldest. Merge them, or rename one.".into(),
                ids.split(',').next().map(String::from),
                None,
            ));
        }
    }

    if want("empty_pages") {
        let mut stmt = conn.prepare(
            "SELECT p.id, p.title FROM page p
             WHERE p.workspace_id = ?1 AND p.deleted_at IS NULL AND p.kind = 'page'
               AND p.created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
               AND NOT EXISTS (SELECT 1 FROM block b WHERE b.page_id = p.id)
               AND NOT EXISTS (SELECT 1 FROM page c WHERE c.parent_page_id = p.id AND c.deleted_at IS NULL)
             ORDER BY p.updated_at LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![workspace_id, limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, title) = row?;
            out.push(finding(
                "empty_pages",
                "info",
                format!("“{}” is empty", if title.is_empty() { "Untitled" } else { &title }),
                "Nothing has been written here for a week. Fill it in or move it to the trash.".into(),
                Some(id.clone()),
                Some(Op::TrashPage { page_id: id }),
            ));
        }
    }

    if want("isolated_pages") {
        let mut stmt = conn.prepare(
            "SELECT p.id, p.title FROM page p
             WHERE p.workspace_id = ?1 AND p.deleted_at IS NULL AND p.kind = 'page' AND p.parent_page_id IS NULL
               AND EXISTS (SELECT 1 FROM block b WHERE b.page_id = p.id)
               AND NOT EXISTS (SELECT 1 FROM page c WHERE c.parent_page_id = p.id AND c.deleted_at IS NULL)
               AND NOT EXISTS (SELECT 1 FROM page_reference r WHERE r.source_page_id = p.id OR r.target_page_id = p.id)
             ORDER BY p.updated_at LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![workspace_id, limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, title) = row?;
            out.push(finding(
                "isolated_pages",
                "info",
                format!("“{}” stands alone", if title.is_empty() { "Untitled" } else { &title }),
                "No subpages and no links in or out. Link it from a related page so it can be found.".into(),
                Some(id),
                None,
            ));
        }
    }

    if want("tag_variants") {
        let mut stmt = conn.prepare("SELECT tag, COUNT(*) FROM block_tag WHERE workspace_id = ?1 GROUP BY tag")?;
        let tags: Vec<(String, i64)> = stmt.query_map([workspace_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        let mut groups: HashMap<String, Vec<(String, i64)>> = HashMap::new();
        for (t, n) in tags {
            let key: String = t.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
            groups.entry(key).or_default().push((t, n));
        }
        let mut variants: Vec<Vec<(String, i64)>> = groups.into_values().filter(|g| g.len() > 1).collect();
        variants.sort_by_key(|g| std::cmp::Reverse(g.iter().map(|x| x.1).sum::<i64>()));
        for mut g in variants.into_iter().take(limit as usize) {
            g.sort_by_key(|x| std::cmp::Reverse(x.1));
            let names: Vec<String> = g.iter().map(|(t, n)| format!("#{t} ({n})")).collect();
            out.push(finding(
                "tag_variants",
                "info",
                format!("{} spellings of #{}", g.len(), g[0].0),
                format!("{}. Pick one spelling so tag pages collect everything.", names.join(", ")),
                None,
                None,
            ));
        }
    }

    if want("memory") {
        if let Some(h) = hub::get(conn, workspace_id)? {
            let props = load_properties(conn, &h.memory_database_id)?;
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            let mut stmt = conn.prepare(
                "SELECT r.id FROM db_record r JOIN page p ON p.id = r.page_id WHERE r.database_id = ?1 AND p.deleted_at IS NULL LIMIT 2000",
            )?;
            let ids: Vec<String> = stmt.query_map([&h.memory_database_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
            for row in load_rows(conn, &ids)? {
                let v = hub::readable(conn, &props, &row.values);
                if v.get("Status").and_then(Value::as_str) != Some("Active") {
                    continue;
                }
                let expires = v.get("Expires").and_then(Value::as_str).unwrap_or_default();
                let superseded = v.get("Superseded by").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
                let status = if superseded {
                    Some(("Superseded", "A newer memory replaces it, but it is still marked active."))
                } else if !expires.is_empty() && &expires[..expires.len().min(10)] < today.as_str() {
                    Some(("Expired", "Its expiry date has passed."))
                } else {
                    None
                };
                if let Some((s, why)) = status {
                    let mut values = Map::new();
                    values.insert("Status".into(), json!(s));
                    out.push(finding(
                        "memory",
                        "warning",
                        format!("Memory “{}” is out of date", row.title),
                        why.into(),
                        Some(row.page_id.clone()),
                        Some(Op::SetValues { page_id: row.page_id, values }),
                    ));
                }
            }
        }
    }

    if want("tasks") {
        let at = chrono::Utc::now();
        for t in tasks::all(conn, workspace_id, false)? {
            let status = t.status();
            let updated: String = conn
                .query_row("SELECT updated_at FROM page WHERE id = ?1", [&t.page_id], |r| r.get(0))
                .unwrap_or_default();
            let old = chrono::DateTime::parse_from_rfc3339(&updated)
                .map(|u| at - u.with_timezone(&chrono::Utc) > chrono::Duration::days(7))
                .unwrap_or(false);
            let lease = t.values.get("Lease until").and_then(Value::as_str).unwrap_or_default().to_string();
            let expired = status == "In progress"
                && chrono::DateTime::parse_from_rfc3339(&lease).map(|l| l.with_timezone(&chrono::Utc) < at).unwrap_or(true);
            let (severity, detail) = if expired {
                ("warning", "Its lease ran out; the agent stopped reporting. It goes back to the queue.")
            } else if status == "Review" && old {
                ("info", "Waiting for review for over a week.")
            } else if status == "Failed" {
                ("warning", "Agents gave up on it. Rewrite it or take it on yourself.")
            } else {
                continue;
            };
            out.push(finding("tasks", severity, format!("Task “{}”", t.title), detail.into(), Some(t.page_id), None));
        }
    }

    if want("proposals") {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM proposal WHERE workspace_id = ?1 AND status = 'pending' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')",
            [workspace_id],
            |r| r.get(0),
        )?;
        if n > 0 {
            out.push(finding(
                "proposals",
                "info",
                format!("{n} proposal(s) waiting over a week"),
                "Open the Review inbox to approve or reject them.".into(),
                None,
                None,
            ));
        }
    }
    Ok(out)
}

/// The fixes that need no review: expired leases go back to the queue and memories past their
/// date are marked expired. Returns how many items changed.
pub fn upkeep(conn: &mut Connection, workspace_id: &str) -> AppResult<usize> {
    let mut changed = tasks::requeue_expired(conn, workspace_id)?;
    let ops: Vec<Op> = report(conn, workspace_id, &["memory".into()], 200)?
        .into_iter()
        .filter_map(|f| f.fix)
        .collect();
    if !ops.is_empty() {
        changed += ops.len();
        apply_as(conn, &Actor::janitor(workspace_id), "Mark out-of-date memories", None, &ops)?;
    }
    Ok(changed)
}

/// Findings as Markdown, for tool results.
pub fn render(list: &[Finding]) -> String {
    if list.is_empty() {
        return "No problems found.\n".into();
    }
    list.iter()
        .map(|f| {
            format!(
                "- [{}] {} — {}{}\n",
                f.check,
                f.title,
                f.detail,
                f.page_id.as_ref().map(|p| format!(" (page {p})")).unwrap_or_default()
            )
        })
        .collect()
}

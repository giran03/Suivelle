//! The agent task queue: records in each workspace's Agent tasks database. Agents pull work with
//! `next`, which claims the oldest eligible task for a limited time (a lease). A lease that runs
//! out puts the task back in the queue, so a stalled agent never holds work forever. The app
//! never starts an agent; it only answers when one asks.

use super::hub::{self, Hub};
use super::ops::{apply_as, apply_direct, Actor, Op};
use super::Agent;
use crate::databases::service::{load_properties, load_rows};
use crate::domain::{now, validate_id};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use crate::transfer::blocks::{plain_of, Blk};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const LEASE_MINUTES: i64 = 30;
pub const MAX_ATTEMPTS: f64 = 3.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub page_id: String,
    pub workspace_id: String,
    pub title: String,
    pub values: Map<String, Value>,
    pub body: String,
    pub created_at: String,
}

impl Task {
    fn get(&self, k: &str) -> String {
        self.values.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
    }
    pub fn status(&self) -> String {
        self.get("Status")
    }
    fn attempts(&self) -> f64 {
        self.values.get("Attempts").and_then(Value::as_f64).unwrap_or(0.0)
    }
    fn lease_expired(&self, at: DateTime<Utc>) -> bool {
        DateTime::parse_from_rfc3339(&self.get("Lease until"))
            .map(|t| t.with_timezone(&Utc) < at)
            .unwrap_or(true)
    }
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

/// Every live task in the workspace's hub, oldest first.
pub fn all(conn: &Connection, ws: &str, with_body: bool) -> AppResult<Vec<Task>> {
    let Some(hub) = hub::get(conn, ws)? else {
        return Ok(vec![]);
    };
    let props = load_properties(conn, &hub.tasks_database_id)?;
    let mut stmt = conn.prepare(
        "SELECT r.id FROM db_record r JOIN page p ON p.id = r.page_id
         WHERE r.database_id = ?1 AND p.deleted_at IS NULL ORDER BY p.created_at, p.id LIMIT 2000",
    )?;
    let ids: Vec<String> = stmt
        .query_map([&hub.tasks_database_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut rows = load_rows(conn, &ids)?;
    rows.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    Ok(rows
        .into_iter()
        .map(|r| Task {
            body: if with_body {
                super::content::body_markdown(conn, &r.page_id).unwrap_or_default()
            } else {
                String::new()
            },
            values: hub::readable(conn, &props, &r.values),
            page_id: r.page_id,
            workspace_id: ws.into(),
            title: r.title,
            created_at: r.created_at,
        })
        .collect())
}

fn for_agent(t: &Task, agent: &Agent) -> bool {
    let a = t.get("Agent");
    a.is_empty() || a.eq_ignore_ascii_case(&agent.name)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListInput {
    #[serde(default)]
    pub status: Option<String>,
    /// Only tasks assigned to (or claimed by) this agent.
    #[serde(default)]
    pub mine: bool,
    #[serde(default)]
    pub limit: Option<usize>,
}

pub fn list(conn: &Connection, agent: &Agent, input: &ListInput) -> AppResult<Vec<Task>> {
    let mut out = Vec::new();
    for ws in &agent.workspace_ids {
        for t in all(conn, ws, false)? {
            if input.status.as_ref().is_some_and(|s| !t.status().eq_ignore_ascii_case(s)) {
                continue;
            }
            if input.mine && !(t.get("Agent").eq_ignore_ascii_case(&agent.name) || t.get("Claimed by").eq_ignore_ascii_case(&agent.name)) {
                continue;
            }
            out.push(t);
        }
    }
    out.truncate(input.limit.unwrap_or(50).clamp(1, 200));
    Ok(out)
}

/// Claims the next task for `agent`: its own or unassigned queued work, then tasks whose lease
/// ran out, earliest due first. Returns the task with its body.
pub fn next(conn: &mut Connection, agent: &Agent) -> AppResult<Option<(Task, Vec<String>)>> {
    let at = Utc::now();
    let mut candidates: Vec<Task> = Vec::new();
    for ws in &agent.workspace_ids {
        for t in all(conn, ws, false)? {
            let status = t.status();
            let eligible = (status == "Queued" && for_agent(&t, agent))
                || (status == "In progress" && t.lease_expired(at) && for_agent(&t, agent));
            if eligible && t.attempts() < MAX_ATTEMPTS {
                candidates.push(t);
            }
        }
    }
    candidates.sort_by(|a, b| {
        let due = |t: &Task| t.get("Due");
        match (due(a).is_empty(), due(b).is_empty()) {
            (false, true) => std::cmp::Ordering::Less,
            (true, false) => std::cmp::Ordering::Greater,
            _ => due(a).cmp(&due(b)),
        }
        .then(a.created_at.cmp(&b.created_at))
    });
    let Some(task) = candidates.into_iter().next() else {
        return Ok(None);
    };
    let mut v = Map::new();
    v.insert("Status".into(), json!("In progress"));
    v.insert("Claimed by".into(), json!(agent.name));
    v.insert("Lease until".into(), json!((at + Duration::minutes(LEASE_MINUTES)).to_rfc3339()));
    v.insert("Attempts".into(), json!(task.attempts() + 1.0));
    let fx = apply_direct(conn, agent, &format!("Claim task: {}", task.title), &[Op::SetValues { page_id: task.page_id.clone(), values: v }])?;
    let fresh = all(conn, &task.workspace_id, true)?
        .into_iter()
        .find(|t| t.page_id == task.page_id)
        .ok_or_else(|| AppError::NotFound("task".into()))?;
    Ok(Some((fresh, fx.page_ids)))
}

fn owned_task(conn: &Connection, agent: &Agent, page_id: &str) -> AppResult<Task> {
    let page = agent.page(conn, page_id)?;
    let task = all(conn, &page.workspace_id, false)?
        .into_iter()
        .find(|t| t.page_id == page_id)
        .ok_or_else(|| AppError::Validation("That page is not an agent task.".into()))?;
    let claimed = task.get("Claimed by");
    if !claimed.is_empty() && !claimed.eq_ignore_ascii_case(&agent.name) {
        return Err(AppError::Validation(format!("{claimed} is working on this task.")));
    }
    Ok(task)
}

pub fn heartbeat(conn: &mut Connection, agent: &Agent, page_id: &str) -> AppResult<String> {
    let task = owned_task(conn, agent, page_id)?;
    if task.status() != "In progress" {
        return Err(AppError::Validation("Only a task in progress has a lease.".into()));
    }
    let until = (Utc::now() + Duration::minutes(LEASE_MINUTES)).to_rfc3339();
    let mut v = Map::new();
    v.insert("Lease until".into(), json!(until));
    v.insert("Claimed by".into(), json!(agent.name));
    apply_direct(conn, agent, "Extend task lease", &[Op::SetValues { page_id: page_id.into(), values: v }])?;
    Ok(until)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Complete {
    pub task_id: String,
    #[serde(default)]
    pub result: String,
    /// Leave the task in Review for a person to check instead of marking it done.
    #[serde(default)]
    pub needs_review: bool,
}

pub fn complete(conn: &mut Connection, agent: &Agent, input: Complete) -> AppResult<Vec<String>> {
    let task = owned_task(conn, agent, &input.task_id)?;
    let mut v = Map::new();
    v.insert("Status".into(), json!(if input.needs_review { "Review" } else { "Done" }));
    v.insert("Lease until".into(), Value::Null);
    let mut ops = vec![Op::SetValues { page_id: task.page_id.clone(), values: v }];
    if !input.result.trim().is_empty() {
        ops.push(Op::UpdateContent {
            page_id: task.page_id.clone(),
            markdown: format!("## Result ({}, {})\n\n{}", agent.name, &now()[..10], input.result.trim()),
            append: true,
            base_hash: None,
        });
    }
    let mut pages = apply_direct(conn, agent, &format!("Finish task: {}", task.title), &ops)?.page_ids;
    if !input.needs_review {
        if let Some(block) = task.get("Origin").strip_prefix("block:") {
            if let Some(p) = check_todo(conn, &Actor::agent(agent), block)? {
                pages.push(p);
            }
        }
    }
    Ok(pages)
}

pub fn fail(conn: &mut Connection, agent: &Agent, page_id: &str, reason: &str) -> AppResult<(String, Vec<String>)> {
    let task = owned_task(conn, agent, page_id)?;
    let status = if task.attempts() >= MAX_ATTEMPTS { "Failed" } else { "Queued" };
    let mut v = Map::new();
    v.insert("Status".into(), json!(status));
    v.insert("Claimed by".into(), Value::Null);
    v.insert("Lease until".into(), Value::Null);
    let ops = vec![
        Op::SetValues { page_id: page_id.into(), values: v },
        Op::UpdateContent {
            page_id: page_id.into(),
            markdown: format!("> Attempt {} by {} did not finish: {}", task.attempts() as i64, agent.name, reason.trim()),
            append: true,
            base_hash: None,
        },
    ];
    let fx = apply_direct(conn, agent, &format!("Give up task: {}", task.title), &ops)?;
    Ok((status.into(), fx.page_ids))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Create {
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// The agent to do it (by name); any agent when absent.
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

pub fn create(conn: &mut Connection, agent: &Agent, input: Create) -> AppResult<(String, Vec<String>)> {
    let ws = agent.workspace(input.workspace_id.as_deref())?;
    let hub = ensure_hub(conn, &ws)?;
    let mut v = Map::new();
    v.insert("Status".into(), json!("Queued"));
    v.insert("Source".into(), json!(agent.name));
    v.insert("Attempts".into(), json!(0));
    if let Some(a) = input.agent.as_ref().filter(|a| !a.trim().is_empty()) {
        v.insert("Agent".into(), json!(a.trim()));
    }
    if let Some(d) = input.due.as_ref().filter(|d| !d.trim().is_empty()) {
        v.insert("Due".into(), json!(d.trim()));
    }
    let fx = apply_direct(
        conn,
        agent,
        &format!("New task: {}", input.title.trim()),
        &[Op::CreateRecord {
            key: Some("task".into()),
            database: hub.tasks_database_id,
            title: input.title.trim().into(),
            values: v,
            markdown: input.description,
        }],
    )?;
    let id = fx.created.iter().find(|(k, _)| k == "task").map(|(_, id)| id.clone()).unwrap_or_default();
    Ok((id, fx.page_ids))
}

/// Queues a task for a named agent on the user's behalf (follow-ups after a review), in the
/// workspace's hub. Returns the task's page id.
pub fn queue_for(conn: &mut Connection, ws: &str, agent_name: &str, title: &str, body: &str) -> AppResult<String> {
    let hub = ensure_hub(conn, ws)?;
    let mut v = Map::new();
    v.insert("Status".into(), json!("Queued"));
    v.insert("Source".into(), json!("Review inbox"));
    v.insert("Attempts".into(), json!(0));
    v.insert("Agent".into(), json!(agent_name));
    let (_, fx) = apply_as(
        conn,
        &Actor::user(vec![ws.to_string()]),
        &format!("New task: {title}"),
        None,
        &[Op::CreateRecord { key: Some("task".into()), database: hub.tasks_database_id, title: title.into(), values: v, markdown: body.into() }],
    )?;
    Ok(fx.created.iter().find(|(k, _)| k == "task").map(|(_, id)| id.clone()).unwrap_or_default())
}

// ---------------------------------------------------------------------------------------------
// to-dos
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub block_id: String,
    pub page_id: String,
    pub page_title: String,
    pub text: String,
}

/// Unchecked to-dos across a workspace, newest pages first.
pub fn todos(conn: &Connection, workspace_id: &str, limit: i64) -> AppResult<Vec<Todo>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.page_id, p.title, b.type, b.data_json, b.schema_version FROM block b
         JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
         WHERE p.workspace_id = ?1 AND b.type = 'todo'
           AND COALESCE(json_extract(b.data_json, '$.checked'), 0) IN (0, 'false')
         ORDER BY p.updated_at DESC, b.position LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![workspace_id, limit.clamp(1, 500)], |r| {
        let kind: String = r.get(3)?;
        let data: String = r.get(4)?;
        let version: i64 = r.get(5)?;
        Ok(Todo {
            block_id: r.get(0)?,
            page_id: r.get(1)?,
            page_title: r.get(2)?,
            text: plain_of(&Blk::from_row(&kind, &data, version).inline),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?.into_iter().filter(|t| !t.text.trim().is_empty()).collect())
}

/// Turns a to-do into an agent task linked back to it; finishing the task checks the to-do.
pub fn promote(conn: &mut Connection, actor: &Actor, block_id: &str, assign_to: Option<&str>) -> AppResult<(String, Vec<String>)> {
    validate_id(block_id, "block")?;
    let row = repo::block::get(conn, block_id)?.ok_or_else(|| AppError::NotFound("to-do".into()))?;
    if row.block_type != "todo" {
        return Err(AppError::Validation("Only to-dos can become tasks.".into()));
    }
    let page = repo::page::get(conn, &row.page_id)?
        .filter(|p| p.deleted_at.is_none() && actor.workspace_ids.contains(&p.workspace_id))
        .ok_or_else(|| AppError::NotFound("page".into()))?;
    let text = plain_of(&Blk::from_row(&row.block_type, &row.data_json, row.schema_version).inline);
    let title: String = if text.trim().is_empty() { "Untitled to-do".into() } else { text.trim().chars().take(200).collect() };
    let hub = ensure_hub(conn, &page.workspace_id)?;
    let mut v = Map::new();
    v.insert("Status".into(), json!("Queued"));
    v.insert("Source".into(), json!(actor.name));
    v.insert("Origin".into(), json!(format!("block:{block_id}")));
    v.insert("Attempts".into(), json!(0));
    if let Some(a) = assign_to.filter(|a| !a.trim().is_empty()) {
        v.insert("Agent".into(), json!(a.trim()));
    }
    let ops = [Op::CreateRecord {
        key: Some("task".into()),
        database: hub.tasks_database_id,
        title,
        values: v,
        markdown: format!(
            "From [{}](suivelle://page/{}).",
            page.title.replace(['[', ']'], ""),
            page.id
        ),
    }];
    let (_, fx) = apply_as(conn, actor, "Promote a to-do to a task", None, &ops)?;
    let id = fx.created.iter().find(|(k, _)| k == "task").map(|(_, id)| id.clone()).unwrap_or_default();
    Ok((id, fx.page_ids))
}

/// Checks a to-do (when it is still on a page the actor may change). Returns its page.
fn check_todo(conn: &mut Connection, actor: &Actor, block_id: &str) -> AppResult<Option<String>> {
    if validate_id(block_id, "block").is_err() {
        return Ok(None);
    }
    let Some(row) = repo::block::get(conn, block_id)? else {
        return Ok(None);
    };
    let page = repo::page::get(conn, &row.page_id)?;
    if row.block_type != "todo" || !page.is_some_and(|p| p.deleted_at.is_none() && actor.workspace_ids.contains(&p.workspace_id)) {
        return Ok(None);
    }
    let mut data: Value = serde_json::from_str(&row.data_json).unwrap_or_default();
    if data["checked"] == json!(true) {
        return Ok(None);
    }
    data["checked"] = json!(true);
    let tx = conn.transaction()?;
    let mut rec = super::changeset::Recorder::begin(&tx, actor.kind, actor.agent_id.as_deref(), None, "Check the to-do a task came from")?;
    rec.touch(&tx, &row.page_id, "updated")?;
    crate::services::block::apply_batch_in(
        &tx,
        &crate::domain::BlockBatch {
            page_id: row.page_id.clone(),
            upserts: vec![crate::domain::BlockUpsert {
                id: row.id.clone(),
                parent_block_id: row.parent_block_id.clone(),
                block_type: row.block_type.clone(),
                position: row.position,
                data_json: data.to_string(),
                schema_version: row.schema_version,
            }],
            delete_ids: vec![],
        },
    )?;
    tx.commit()?;
    Ok(Some(row.page_id))
}

/// Puts tasks whose lease ran out back in the queue. Returns how many.
pub fn requeue_expired(conn: &mut Connection, workspace_id: &str) -> AppResult<usize> {
    let at = Utc::now();
    let expired: Vec<Task> = all(conn, workspace_id, false)?
        .into_iter()
        .filter(|t| t.status() == "In progress" && t.lease_expired(at))
        .collect();
    if expired.is_empty() {
        return Ok(0);
    }
    let ops: Vec<Op> = expired
        .iter()
        .map(|t| {
            let mut v = Map::new();
            v.insert("Status".into(), json!(if t.attempts() >= MAX_ATTEMPTS { "Failed" } else { "Queued" }));
            v.insert("Claimed by".into(), Value::Null);
            v.insert("Lease until".into(), Value::Null);
            Op::SetValues { page_id: t.page_id.clone(), values: v }
        })
        .collect();
    apply_as(conn, &Actor::janitor(workspace_id), "Requeue tasks whose lease ran out", None, &ops)?;
    Ok(expired.len())
}

/// Tasks as Markdown, for tool results.
pub fn render(list: &[Task]) -> String {
    if list.is_empty() {
        return "No tasks.\n".into();
    }
    let mut out = String::new();
    for t in list {
        let meta: Vec<String> = ["Status", "Agent", "Claimed by", "Due", "Attempts"]
            .iter()
            .filter_map(|k| t.values.get(*k).map(|v| format!("{k}: {}", v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))))
            .collect();
        out.push_str(&format!("- **{}** (id {}; {})\n", t.title, t.page_id, meta.join(", ")));
    }
    out
}

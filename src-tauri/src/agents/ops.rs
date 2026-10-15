//! Changes agents (and the mirror) ask to make, as a list of operations applied in one
//! transaction. A proposal is checked by applying it and rolling back, so a broken one is
//! refused at once with the reason. Depending on the agent's mode it is applied immediately or
//! waits in the Review inbox; either way it is recorded as a changeset that can be reverted.

use super::changeset::Recorder;
use super::content::{self, WriteMode};
use super::hub;
use super::Agent;
use crate::automation::engine::{change_events, Event};
use crate::databases::service::{create_record_in, load_database, load_rows, set_value_in};
use crate::databases::{Database, RecordCreate, SetValue};
use crate::domain::{new_id, now, validate_id, validate_title, Page};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use crate::search;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;

pub const MAX_OPS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Op {
    /// A new page. `parent` is a page id, `key:<name>` for a page created earlier in the same
    /// proposal, or absent (the Agent Hub for agents, the top level for the mirror).
    CreatePage {
        #[serde(default)]
        key: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        parent: Option<String>,
        title: String,
        #[serde(default)]
        markdown: String,
        #[serde(default)]
        aliases: Vec<String>,
    },
    /// Replaces (or with `append`, adds to) a page's body. With `base_hash` (from page_read),
    /// the change is refused when the page changed since it was read.
    UpdateContent {
        page_id: String,
        markdown: String,
        #[serde(default)]
        append: bool,
        #[serde(default)]
        base_hash: Option<String>,
    },
    RenamePage {
        page_id: String,
        title: String,
    },
    /// Moves a page under `parent` (a page id or `key:<name>`), or to the top level.
    MovePage {
        page_id: String,
        #[serde(default)]
        parent: Option<String>,
    },
    TrashPage {
        page_id: String,
    },
    /// A new record. `database` is a database id, its page id, or its title. Values are by
    /// property name, written as people would ("In progress", "2026-10-20").
    CreateRecord {
        #[serde(default)]
        key: Option<String>,
        database: String,
        title: String,
        #[serde(default)]
        values: Map<String, Value>,
        #[serde(default)]
        markdown: String,
    },
    /// Sets values on the record whose page is `page_id`.
    SetValues {
        page_id: String,
        values: Map<String, Value>,
    },
    SetAliases {
        page_id: String,
        aliases: Vec<String>,
    },
}

/// Who is applying the change.
#[derive(Debug, Clone)]
pub struct Actor {
    /// "agent" or "mirror".
    pub kind: &'static str,
    pub agent_id: Option<String>,
    pub name: String,
    pub workspace_ids: Vec<String>,
}

impl Actor {
    pub fn agent(a: &Agent) -> Actor {
        Actor {
            kind: "agent",
            agent_id: Some(a.id.clone()),
            name: a.name.clone(),
            workspace_ids: a.workspace_ids.clone(),
        }
    }

    pub fn mirror(workspace_id: &str) -> Actor {
        Actor {
            kind: "mirror",
            agent_id: None,
            name: "Mirror folder".into(),
            workspace_ids: vec![workspace_id.to_string()],
        }
    }

    /// Upkeep the app does by itself (requeueing expired tasks, expiring memories).
    pub fn janitor(workspace_id: &str) -> Actor {
        Actor {
            kind: "janitor",
            agent_id: None,
            name: "Vault upkeep".into(),
            workspace_ids: vec![workspace_id.to_string()],
        }
    }

    /// The person using the app, for actions taken from its interface.
    pub fn user(workspace_ids: Vec<String>) -> Actor {
        Actor {
            kind: "user",
            agent_id: None,
            name: "You".into(),
            workspace_ids,
        }
    }

    fn page(&self, conn: &Connection, id: &str) -> AppResult<Page> {
        validate_id(id, "page")?;
        repo::page::get(conn, id)?
            .filter(|p| p.deleted_at.is_none() && self.workspace_ids.contains(&p.workspace_id))
            .ok_or_else(|| AppError::NotFound(format!("page {id}")))
    }

    fn workspace(&self, asked: Option<&str>) -> AppResult<String> {
        match asked {
            Some(w) if self.workspace_ids.iter().any(|x| x == w) => Ok(w.into()),
            Some(_) => Err(AppError::NotFound("workspace".into())),
            None => self
                .workspace_ids
                .first()
                .cloned()
                .ok_or_else(|| AppError::Validation("No workspace is in scope.".into())),
        }
    }
}

/// What applying a list of operations did.
#[derive(Debug, Default)]
pub struct Effects {
    pub page_ids: Vec<String>,
    /// Pages created for `key:` names.
    pub created: Vec<(String, String)>,
    pub events: Vec<Event>,
}

/// Finds a database by id, page id or title, within the actor's workspaces.
pub fn find_database(conn: &Connection, workspaces: &[String], s: &str) -> AppResult<Database> {
    let id: Option<String> = conn
        .query_row(
            "SELECT d.id FROM db_database d JOIN page p ON p.id = d.page_id
             WHERE p.deleted_at IS NULL AND (d.id = ?1 OR d.page_id = ?1 OR lower(trim(p.title)) = lower(trim(?1)))
               AND p.workspace_id IN (SELECT value FROM json_each(?2))
             ORDER BY (d.id = ?1 OR d.page_id = ?1) DESC LIMIT 1",
            params![s, serde_json::to_string(workspaces).unwrap_or_default()],
            |r| r.get(0),
        )
        .optional()?;
    load_database(
        conn,
        &id.ok_or_else(|| AppError::NotFound(format!("database '{s}'")))?,
    )
}

fn resolve(keys: &HashMap<String, String>, s: &str) -> AppResult<String> {
    match s.strip_prefix("key:") {
        Some(k) => keys.get(k).cloned().ok_or_else(|| {
            AppError::Validation(format!("No page created earlier with key '{k}'."))
        }),
        None => Ok(s.to_string()),
    }
}

fn record_of(conn: &Connection, page_id: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT id FROM db_record WHERE page_id = ?1",
        [page_id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::Validation("That page is not a database record.".into()))
}

fn mark_created(tx: &Connection, actor: &Actor, page_id: &str) -> AppResult<()> {
    if let Some(a) = &actor.agent_id {
        tx.execute(
            "UPDATE page SET created_by = ?2 WHERE id = ?1",
            params![page_id, a],
        )?;
    }
    Ok(())
}

/// Applies `ops` inside the caller's transaction, recording each touched page.
pub fn apply_ops(
    tx: &Connection,
    actor: &Actor,
    ops: &[Op],
    rec: &mut Recorder,
) -> AppResult<Effects> {
    let mut fx = Effects::default();
    let mut keys: HashMap<String, String> = HashMap::new();
    for (i, op) in ops.iter().enumerate() {
        apply_one(tx, actor, op, rec, &mut keys, &mut fx)
            .map_err(|e| prefix(e, &format!("Change {} ({})", i + 1, op_name(op))))?;
    }
    fx.page_ids = rec.page_ids.clone();
    fx.created = keys.into_iter().collect();
    Ok(fx)
}

fn prefix(e: AppError, at: &str) -> AppError {
    match e {
        AppError::Validation(m) => AppError::Validation(format!("{at}: {m}")),
        AppError::NotFound(m) => AppError::NotFound(format!("{m} ({at})")),
        other => other,
    }
}

pub fn op_name(op: &Op) -> &'static str {
    match op {
        Op::CreatePage { .. } => "create_page",
        Op::UpdateContent { .. } => "update_content",
        Op::RenamePage { .. } => "rename_page",
        Op::MovePage { .. } => "move_page",
        Op::TrashPage { .. } => "trash_page",
        Op::CreateRecord { .. } => "create_record",
        Op::SetValues { .. } => "set_values",
        Op::SetAliases { .. } => "set_aliases",
    }
}

fn apply_one(
    tx: &Connection,
    actor: &Actor,
    op: &Op,
    rec: &mut Recorder,
    keys: &mut HashMap<String, String>,
    fx: &mut Effects,
) -> AppResult<()> {
    match op {
        Op::CreatePage {
            key,
            workspace_id,
            parent,
            title,
            markdown,
            aliases,
        } => {
            validate_title(title)?;
            let parent = match parent {
                Some(p) => Some(actor.page(tx, &resolve(keys, p)?)?),
                None => None,
            };
            let ws = match &parent {
                Some(p) => p.workspace_id.clone(),
                None => actor.workspace(workspace_id.as_deref())?,
            };
            if let Some(p) = &parent {
                if p.kind != "page" {
                    return Err(AppError::Validation(
                        "Pages can only be created inside pages.".into(),
                    ));
                }
            }
            let parent_id = match (&parent, actor.kind) {
                (Some(p), _) => Some(p.id.clone()),
                (None, "agent") => Some(hub::ensure(tx, &ws)?.page_id),
                (None, _) => None,
            };
            let page = crate::transfer::insert_page(
                tx,
                None,
                &ws,
                parent_id.as_deref(),
                title.trim(),
                None,
                "page",
                false,
            )?;
            mark_created(tx, actor, &page.id)?;
            rec.touch(tx, &page.id, "created")?;
            if !markdown.trim().is_empty() {
                content::write_markdown(tx, &page, markdown, WriteMode::Replace)?;
            }
            if !aliases.is_empty() {
                content::set_aliases(tx, &page, aliases)?;
            }
            if let Some(k) = key {
                keys.insert(k.clone(), page.id.clone());
            }
        }
        Op::UpdateContent {
            page_id,
            markdown,
            append,
            base_hash,
        } => {
            let page = actor.page(tx, &resolve(keys, page_id)?)?;
            if page.kind == "database" {
                return Err(AppError::Validation(
                    "A database's page holds its table; change its records instead.".into(),
                ));
            }
            if let Some(h) = base_hash {
                if *h != content::content_hash(tx, &page.id)? {
                    return Err(AppError::Validation(
                        "The page changed since it was read. Read it again and redo the change."
                            .into(),
                    ));
                }
            }
            rec.touch(tx, &page.id, "updated")?;
            let mode = if *append {
                WriteMode::Append
            } else {
                WriteMode::Replace
            };
            content::write_markdown(tx, &page, markdown, mode)?;
        }
        Op::RenamePage { page_id, title } => {
            validate_title(title)?;
            let mut page = actor.page(tx, &resolve(keys, page_id)?)?;
            if page.title != title.trim() {
                rec.touch(tx, &page.id, "renamed")?;
                page.title = title.trim().to_string();
                page.updated_at = now();
                repo::page::update(tx, &page)?;
                search::index::upsert_page(tx, &page)?;
            }
        }
        Op::MovePage { page_id, parent } => {
            let page = actor.page(tx, &resolve(keys, page_id)?)?;
            if page.kind == "record" {
                return Err(AppError::Validation(
                    "Records stay inside their database.".into(),
                ));
            }
            let parent = match parent {
                Some(p) => {
                    let p = actor.page(tx, &resolve(keys, p)?)?;
                    if p.workspace_id != page.workspace_id {
                        return Err(AppError::Validation(
                            "Pages move only within their workspace.".into(),
                        ));
                    }
                    if p.kind != "page" {
                        return Err(AppError::Validation(
                            "Pages can only be moved into pages.".into(),
                        ));
                    }
                    if repo::page::in_subtree(tx, &page.id, &p.id)? {
                        return Err(AppError::Validation(
                            "A page cannot move into itself.".into(),
                        ));
                    }
                    Some(p.id)
                }
                None => None,
            };
            if page.parent_page_id != parent {
                rec.touch(tx, &page.id, "moved")?;
                let position =
                    repo::page::next_position(tx, &page.workspace_id, parent.as_deref())?;
                repo::page::set_parent_position(tx, &page.id, parent.as_deref(), position, &now())?;
            }
        }
        Op::TrashPage { page_id } => {
            let page = actor.page(tx, &resolve(keys, page_id)?)?;
            rec.touch(tx, &page.id, "trashed")?;
            repo::page::soft_delete_tree(tx, &page.id, &now())?;
        }
        Op::CreateRecord {
            key,
            database,
            title,
            values,
            markdown,
        } => {
            validate_title(title)?;
            let db = find_database(tx, &actor.workspace_ids, database)?;
            let mut stored = hub::stored_map(tx, &db.id, values)?;
            // Relations are linked once the record exists.
            let props = crate::databases::service::load_properties(tx, &db.id)?;
            let relations: Vec<(String, Value)> = props
                .iter()
                .filter(|p| p.property_type == "relation")
                .filter_map(|p| stored.remove(&p.id).map(|v| (p.id.clone(), v)))
                .collect();
            let row = create_record_in(
                tx,
                RecordCreate {
                    database_id: db.id.clone(),
                    title: Some(title.trim().to_string()),
                    values: stored,
                    template_id: None,
                },
            )?;
            for (property_id, value) in relations {
                set_value_in(
                    tx,
                    SetValue {
                        record_id: row.id.clone(),
                        property_id,
                        value,
                    },
                )?;
            }
            mark_created(tx, actor, &row.page_id)?;
            rec.touch(tx, &row.page_id, "created")?;
            if !markdown.trim().is_empty() {
                let page = repo::page::get(tx, &row.page_id)?
                    .ok_or_else(|| AppError::NotFound("record page".into()))?;
                content::write_markdown(tx, &page, markdown, WriteMode::Replace)?;
            }
            fx.events.push(Event::RecordCreated {
                record_id: row.id.clone(),
            });
            if let Some(k) = key {
                keys.insert(k.clone(), row.page_id.clone());
            }
        }
        Op::SetValues { page_id, values } => {
            let page = actor.page(tx, &resolve(keys, page_id)?)?;
            let record_id = record_of(tx, &page.id)?;
            let before = load_rows(tx, std::slice::from_ref(&record_id))?
                .into_iter()
                .next()
                .ok_or_else(|| AppError::NotFound("record".into()))?;
            let db_id = before.database_id.clone();
            let stored = hub::stored_map(tx, &db_id, values)?;
            let previous: Map<String, Value> = stored
                .keys()
                .map(|k| {
                    (
                        k.clone(),
                        before.values.get(k).cloned().unwrap_or(Value::Null),
                    )
                })
                .collect();
            rec.touch_with(
                tx,
                &page.id,
                "values",
                Some(Value::Object(previous).to_string()),
            )?;
            for (property_id, value) in stored {
                let old = before.values.get(&property_id).cloned();
                let row = set_value_in(
                    tx,
                    SetValue {
                        record_id: record_id.clone(),
                        property_id: property_id.clone(),
                        value,
                    },
                )?;
                fx.events
                    .extend(change_events(old.as_ref(), &row, &property_id));
            }
        }
        Op::SetAliases { page_id, aliases } => {
            let page = actor.page(tx, &resolve(keys, page_id)?)?;
            rec.touch(tx, &page.id, "aliases")?;
            content::set_aliases(tx, &page, aliases)?;
        }
    }
    Ok(())
}

/// Additive changes "auto" mode applies without review: creating pages and records, appending,
/// aliases, and any change to pages this agent created itself.
pub fn additive(conn: &Connection, agent_id: &str, ops: &[Op]) -> bool {
    let own = |page_id: &str| {
        page_id.starts_with("key:")
            || conn
                .query_row(
                    "SELECT created_by FROM page WHERE id = ?1",
                    [page_id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .ok()
                .flatten()
                .as_deref()
                == Some(agent_id)
    };
    ops.iter().all(|op| match op {
        Op::CreatePage { .. } | Op::CreateRecord { .. } | Op::SetAliases { .. } => true,
        Op::UpdateContent { append: true, .. } => true,
        Op::UpdateContent { page_id, .. }
        | Op::RenamePage { page_id, .. }
        | Op::SetValues { page_id, .. } => own(page_id),
        Op::MovePage { .. } | Op::TrashPage { .. } => false,
    })
}

/// The shared page every agent's instructions can point to; agents change it only through review.
pub const PROTOCOL_TITLE: &str = "Agent protocol";

/// "Agent protocol" and "Agent command: …" pages, which agents are handed as steps to follow.
fn is_protocol_title(title: &str) -> bool {
    let t = title.trim();
    let prefix = super::commands::OVERRIDE_PREFIX;
    t.eq_ignore_ascii_case(PROTOCOL_TITLE)
        || t.get(..prefix.len())
            .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
}

/// Changes that always wait for review, whatever the agent's mode: anything touching an agent's
/// instructions page, the "Agent protocol" page or an "Agent command: …" page, since those steer
/// every agent that reads them.
pub fn guarded(conn: &Connection, ops: &[Op]) -> bool {
    let steering = |page_id: &str| {
        !page_id.starts_with("key:")
            && (conn
                .query_row(
                    "SELECT 1 FROM agent WHERE instructions_page_id = ?1 LIMIT 1",
                    [page_id],
                    |_| Ok(()),
                )
                .is_ok()
                || conn
                    .query_row("SELECT title FROM page WHERE id = ?1", [page_id], |r| {
                        r.get::<_, String>(0)
                    })
                    .is_ok_and(|t| is_protocol_title(&t)))
    };
    ops.iter().any(|op| match op {
        Op::CreatePage { title, .. } => is_protocol_title(title),
        Op::RenamePage { page_id, title } => is_protocol_title(title) || steering(page_id),
        Op::UpdateContent { page_id, .. }
        | Op::MovePage { page_id, .. }
        | Op::TrashPage { page_id }
        | Op::SetValues { page_id, .. }
        | Op::SetAliases { page_id, .. } => steering(page_id),
        Op::CreateRecord { .. } => false,
    })
}

// ---------------------------------------------------------------------------------------------
// proposals
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub proposal_id: String,
    /// "applied" or "pending".
    pub status: String,
    pub changeset_id: Option<String>,
    pub page_ids: Vec<String>,
    /// Pages created for `key:` names, as [key, page id].
    pub created: Vec<(String, String)>,
    #[serde(skip)]
    pub events: Vec<Event>,
}

fn check_ops(title: &str, ops: &[Op]) -> AppResult<()> {
    if ops.is_empty() {
        return Err(AppError::Validation(
            "A proposal needs at least one change.".into(),
        ));
    }
    if ops.len() > MAX_OPS {
        return Err(AppError::Validation(format!(
            "A proposal can hold up to {MAX_OPS} changes."
        )));
    }
    if title.trim().is_empty() || title.chars().count() > 200 {
        return Err(AppError::Validation(
            "Give the proposal a title of up to 200 characters.".into(),
        ));
    }
    Ok(())
}

/// Applies in a transaction that is always rolled back: proves the changes would work.
pub fn dry_run(conn: &mut Connection, actor: &Actor, ops: &[Op]) -> AppResult<Effects> {
    let tx = conn.transaction()?;
    let mut rec = Recorder::begin(&tx, actor.kind, actor.agent_id.as_deref(), None, "dry run")?;
    let fx = apply_ops(&tx, actor, ops, &mut rec)?;
    tx.rollback()?;
    Ok(fx)
}

fn workspace_of(conn: &Connection, actor: &Actor, ops: &[Op]) -> String {
    for op in ops {
        let page = match op {
            Op::UpdateContent { page_id, .. }
            | Op::RenamePage { page_id, .. }
            | Op::MovePage { page_id, .. }
            | Op::TrashPage { page_id }
            | Op::SetValues { page_id, .. }
            | Op::SetAliases { page_id, .. } => Some(page_id),
            Op::CreatePage {
                workspace_id: Some(w),
                ..
            } => return w.clone(),
            Op::CreatePage {
                parent: Some(p), ..
            } => Some(p),
            _ => None,
        };
        if let Some(Ok(Some(p))) = page.map(|id| repo::page::get(conn, id)) {
            return p.workspace_id;
        }
    }
    actor.workspace_ids.first().cloned().unwrap_or_default()
}

/// Submits a proposal from an agent. It is applied now when the agent's mode allows it, and
/// otherwise waits for review.
pub fn submit(
    conn: &mut Connection,
    agent: &Agent,
    title: &str,
    rationale: &str,
    ops: Vec<Op>,
) -> AppResult<Outcome> {
    check_ops(title, &ops)?;
    let actor = Actor::agent(agent);
    dry_run(conn, &actor, &ops)?;
    let apply_now = !guarded(conn, &ops)
        && match agent.mode.as_str() {
            "write" => true,
            "auto" => additive(conn, &agent.id, &ops),
            _ => false,
        };
    let id = new_id();
    let workspace_id = workspace_of(conn, &actor, &ops);
    let ops_json = serde_json::to_string(&ops).map_err(|e| AppError::Internal(e.to_string()))?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO proposal (id, actor_kind, agent_id, workspace_id, title, rationale, ops_json, status, created_at)
         VALUES (?1, 'agent', ?2, ?3, ?4, ?5, ?6, 'pending', ?7)",
        params![id, agent.id, workspace_id, title.trim(), rationale.chars().take(4000).collect::<String>(), ops_json, now()],
    )?;
    if !apply_now {
        tx.commit()?;
        return Ok(Outcome {
            proposal_id: id,
            status: "pending".into(),
            changeset_id: None,
            page_ids: vec![],
            created: vec![],
            events: vec![],
        });
    }
    let mut rec = Recorder::begin(&tx, "agent", Some(&agent.id), Some(&id), title)?;
    let fx = apply_ops(&tx, &actor, &ops, &mut rec)?;
    tx.execute(
        "UPDATE proposal SET status = 'applied', changeset_id = ?2, decided_at = ?3, decision_note = ?4 WHERE id = ?1",
        params![id, rec.id, now(), format!("Applied automatically ({} mode).", agent.mode)],
    )?;
    tx.commit()?;
    Ok(Outcome {
        proposal_id: id,
        status: "applied".into(),
        changeset_id: Some(rec.id),
        page_ids: fx.page_ids,
        created: fx.created,
        events: fx.events,
    })
}

/// Applies changes the agent keeps for its own bookkeeping (memories, task state) without
/// review. They are still recorded and revertable.
pub fn apply_direct(
    conn: &mut Connection,
    agent: &Agent,
    summary: &str,
    ops: &[Op],
) -> AppResult<Effects> {
    let actor = Actor::agent(agent);
    let tx = conn.transaction()?;
    let mut rec = Recorder::begin(&tx, "agent", Some(&agent.id), None, summary)?;
    let fx = apply_ops(&tx, &actor, ops, &mut rec)?;
    tx.commit()?;
    Ok(fx)
}

/// Applies changes on behalf of `actor` (the mirror), recorded as one changeset.
pub fn apply_as(
    conn: &mut Connection,
    actor: &Actor,
    summary: &str,
    proposal_id: Option<&str>,
    ops: &[Op],
) -> AppResult<(String, Effects)> {
    let tx = conn.transaction()?;
    let mut rec = Recorder::begin(
        &tx,
        actor.kind,
        actor.agent_id.as_deref(),
        proposal_id,
        summary,
    )?;
    let fx = apply_ops(&tx, actor, ops, &mut rec)?;
    tx.commit()?;
    Ok((rec.id, fx))
}

/// A proposal the mirror makes when an edit to a file needs review.
pub fn submit_from_mirror(
    conn: &Connection,
    workspace_id: &str,
    title: &str,
    rationale: &str,
    ops: &[Op],
) -> AppResult<String> {
    let id = new_id();
    conn.execute(
        "INSERT INTO proposal (id, actor_kind, agent_id, workspace_id, title, rationale, ops_json, status, created_at)
         VALUES (?1, 'mirror', NULL, ?2, ?3, ?4, ?5, 'pending', ?6)",
        params![id, workspace_id, title, rationale, serde_json::to_string(ops).unwrap_or_default(), now()],
    )?;
    Ok(id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpPreview {
    pub op: String,
    pub summary: String,
    pub page_id: Option<String>,
    pub page_title: Option<String>,
    /// For content changes: the page body now and after the change.
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalInfo {
    pub id: String,
    pub actor_kind: String,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub workspace_id: String,
    pub title: String,
    pub rationale: String,
    pub status: String,
    pub error: Option<String>,
    pub decision_note: Option<String>,
    pub changeset_id: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
    pub op_count: usize,
    pub ops: Vec<OpPreview>,
    /// The agent asked to hear the decision (`proposal_wait`).
    pub resume: bool,
    /// The agent's session is waiting for the decision right now.
    pub agent_waiting: bool,
}

struct Row {
    info: ProposalInfo,
    ops: Vec<Op>,
}

fn load(conn: &Connection, where_sql: &str, args: &[&dyn rusqlite::ToSql]) -> AppResult<Vec<Row>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT p.id, p.actor_kind, p.agent_id, a.name, p.workspace_id, p.title, p.rationale, p.status, p.error,
                p.decision_note, p.changeset_id, p.created_at, p.decided_at, p.ops_json,
                p.resume, COALESCE(p.waiting_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0)
         FROM proposal p LEFT JOIN agent a ON a.id = p.agent_id WHERE {where_sql}"
    ))?;
    let rows = stmt.query_map(args, |r| {
        let ops_json: String = r.get(13)?;
        let ops: Vec<Op> = serde_json::from_str(&ops_json).unwrap_or_default();
        Ok(Row {
            info: ProposalInfo {
                id: r.get(0)?,
                actor_kind: r.get(1)?,
                agent_id: r.get(2)?,
                agent_name: r.get(3)?,
                workspace_id: r.get(4)?,
                title: r.get(5)?,
                rationale: r.get(6)?,
                status: r.get(7)?,
                error: r.get(8)?,
                decision_note: r.get(9)?,
                changeset_id: r.get(10)?,
                created_at: r.get(11)?,
                decided_at: r.get(12)?,
                op_count: ops.len(),
                ops: vec![],
                resume: r.get::<_, i64>(14)? > 0,
                agent_waiting: r.get(15)?,
            },
            ops,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn preview(conn: &Connection, op: &Op, detail: bool) -> OpPreview {
    let title = |id: &str| repo::page::get(conn, id).ok().flatten().map(|p| p.title);
    let (summary, page_id, before, after) = match op {
        Op::CreatePage {
            title: t, markdown, ..
        } => (
            format!("Create page “{t}”"),
            None,
            None,
            detail.then(|| markdown.clone()),
        ),
        Op::UpdateContent {
            page_id,
            markdown,
            append,
            ..
        } => {
            let now_md = if detail {
                content::body_markdown(conn, page_id).ok()
            } else {
                None
            };
            let after = detail.then(|| match (&now_md, append) {
                (Some(b), true) if !b.trim().is_empty() => format!("{b}\n\n{markdown}"),
                _ => markdown.clone(),
            });
            (
                if *append {
                    "Add to the page".into()
                } else {
                    "Rewrite the page".into()
                },
                Some(page_id.clone()),
                now_md,
                after,
            )
        }
        Op::RenamePage { page_id, title: t } => (
            format!("Rename to “{t}”"),
            Some(page_id.clone()),
            None,
            None,
        ),
        Op::MovePage { page_id, parent } => (
            match parent.as_deref().and_then(title) {
                Some(p) => format!("Move into “{p}”"),
                None => "Move to the top level".into(),
            },
            Some(page_id.clone()),
            None,
            None,
        ),
        Op::TrashPage { page_id } => ("Move to trash".into(), Some(page_id.clone()), None, None),
        Op::CreateRecord {
            title: t,
            database,
            values,
            markdown,
            ..
        } => (
            format!(
                "Add “{t}” to {database}{}",
                if values.is_empty() {
                    String::new()
                } else {
                    format!(
                        " ({})",
                        values.keys().cloned().collect::<Vec<_>>().join(", ")
                    )
                }
            ),
            None,
            None,
            detail.then(|| markdown.clone()).filter(|m| !m.is_empty()),
        ),
        Op::SetValues { page_id, values } => (
            format!(
                "Set {}",
                values
                    .iter()
                    .map(|(k, v)| format!(
                        "{k} = {}",
                        v.as_str()
                            .map(String::from)
                            .unwrap_or_else(|| v.to_string())
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Some(page_id.clone()),
            None,
            None,
        ),
        Op::SetAliases { page_id, aliases } => (
            format!("Aliases: {}", aliases.join(", ")),
            Some(page_id.clone()),
            None,
            None,
        ),
    };
    OpPreview {
        op: op_name(op).into(),
        summary,
        page_title: page_id.as_deref().and_then(title),
        page_id,
        before,
        after,
    }
}

/// Proposals by status ("pending", "applied", "rejected", "failed" or "all"), newest first.
pub fn list(
    conn: &Connection,
    status: &str,
    agent_id: Option<&str>,
    limit: i64,
) -> AppResult<Vec<ProposalInfo>> {
    let rows = load(
        conn,
        "(?1 = 'all' OR p.status = ?1) AND (?2 IS NULL OR p.agent_id = ?2) ORDER BY p.created_at DESC LIMIT ?3",
        &[&status, &agent_id, &limit.clamp(1, 200)],
    )?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let mut info = r.info;
            info.ops = r.ops.iter().map(|o| preview(conn, o, false)).collect();
            info
        })
        .collect())
}

pub fn detail(conn: &Connection, id: &str) -> AppResult<ProposalInfo> {
    validate_id(id, "proposal")?;
    let row = load(conn, "p.id = ?1", &[&id])?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound("proposal".into()))?;
    let mut info = row.info;
    let pending = info.status == "pending";
    info.ops = row.ops.iter().map(|o| preview(conn, o, pending)).collect();
    Ok(info)
}

pub fn pending_count(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM proposal WHERE status = 'pending'",
        [],
        |r| r.get(0),
    )?)
}

/// Applies a pending proposal on the user's say-so. `only` picks which of its changes to apply
/// (by position); all of them when absent. A proposal that no longer applies (the page changed,
/// or the agent lost access) is marked failed with the reason.
pub fn approve(
    conn: &mut Connection,
    id: &str,
    only: Option<Vec<usize>>,
    note: Option<String>,
) -> AppResult<Outcome> {
    validate_id(id, "proposal")?;
    let row = load(conn, "p.id = ?1", &[&id])?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound("proposal".into()))?;
    if row.info.status != "pending" {
        return Err(AppError::Validation(
            "This proposal was already decided.".into(),
        ));
    }
    let ops: Vec<Op> = match &only {
        Some(pick) => row
            .ops
            .iter()
            .enumerate()
            .filter(|(i, _)| pick.contains(i))
            .map(|(_, o)| o.clone())
            .collect(),
        None => row.ops.clone(),
    };
    if ops.is_empty() {
        return Err(AppError::Validation(
            "Choose at least one change to apply.".into(),
        ));
    }
    let actor = match (row.info.actor_kind.as_str(), &row.info.agent_id) {
        ("agent", Some(agent_id)) => Actor::agent(&super::get(conn, agent_id)?),
        _ => Actor::mirror(&row.info.workspace_id),
    };
    let tx = conn.transaction()?;
    let mut rec = Recorder::begin(
        &tx,
        actor.kind,
        actor.agent_id.as_deref(),
        Some(id),
        &row.info.title,
    )?;
    match apply_ops(&tx, &actor, &ops, &mut rec) {
        Ok(fx) => {
            let note = note.unwrap_or_else(|| match &only {
                Some(_) => format!("Applied {} of {} changes.", ops.len(), row.ops.len()),
                None => "Approved.".into(),
            });
            tx.execute(
                "UPDATE proposal SET status = 'applied', changeset_id = ?2, decided_at = ?3, decision_note = ?4 WHERE id = ?1",
                params![id, rec.id, now(), note],
            )?;
            tx.commit()?;
            Ok(Outcome {
                proposal_id: id.into(),
                status: "applied".into(),
                changeset_id: Some(rec.id),
                page_ids: fx.page_ids,
                created: fx.created,
                events: fx.events,
            })
        }
        Err(e) => {
            drop(tx);
            conn.execute(
                "UPDATE proposal SET status = 'failed', error = ?2, decided_at = ?3 WHERE id = ?1",
                params![id, e.to_string(), now()],
            )?;
            Err(e)
        }
    }
}

pub fn reject(conn: &Connection, id: &str, note: Option<String>) -> AppResult<()> {
    validate_id(id, "proposal")?;
    let n = conn.execute(
        "UPDATE proposal SET status = 'rejected', decision_note = ?2, decided_at = ?3 WHERE id = ?1 AND status = 'pending'",
        params![id, note.unwrap_or_default().chars().take(2000).collect::<String>(), now()],
    )?;
    if n == 0 {
        return Err(AppError::Validation(
            "This proposal was already decided.".into(),
        ));
    }
    // A rejected edit from the mirror folder: write the page's file again so the folder matches.
    if let Some(row) = load(conn, "p.id = ?1 AND p.actor_kind = 'mirror'", &[&id])?
        .into_iter()
        .next()
    {
        for op in &row.ops {
            if let Some(page_id) = page_of(op) {
                conn.execute(
                    "UPDATE mirror_file SET page_updated = '' WHERE page_id = ?1",
                    [page_id],
                )?;
            }
        }
    }
    Ok(())
}

fn page_of(op: &Op) -> Option<&String> {
    match op {
        Op::UpdateContent { page_id, .. }
        | Op::RenamePage { page_id, .. }
        | Op::MovePage { page_id, .. }
        | Op::TrashPage { page_id }
        | Op::SetValues { page_id, .. }
        | Op::SetAliases { page_id, .. } => Some(page_id),
        _ => None,
    }
}

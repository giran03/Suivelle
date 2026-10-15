//! Local AI agents: who may connect, what they may see and do, and the record of what they did.
//!
//! Agents are clients. The app never runs a model or starts an agent: an agent connects to the
//! loopback agent API (see [`server`]) with its token and pulls work. Everything an agent changes
//! goes through the same services as the editor, inside one transaction, recorded as a
//! changeset that can be reverted. Agent permissions, scopes and tokens change only through the
//! app's own interface.

pub mod changeset;
pub mod clients;
pub mod commands;
pub mod content;
pub mod context;
pub mod hub;
pub mod janitor;
pub mod memory;
pub mod mirror;
pub mod ops;
pub mod resume;
pub mod server;
pub mod spec;
pub mod tasks;
pub mod tools;

#[cfg(test)]
mod tests;

use crate::domain::{new_id, now, validate_id, Page};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Tool groups an agent can be granted. Reading its own instructions and listing its workspaces
/// is always allowed.
pub const TOOL_GROUPS: &[&str] = &["pages", "graph", "db", "memory", "tasks", "janitor"];

pub const MODES: &[&str] = &["propose", "write", "auto"];

pub const MAX_AGENTS: i64 = 50;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub role: String,
    /// "active" or "paused". A paused agent cannot connect.
    pub status: String,
    /// "propose": every content change waits for review. "write": changes apply at once.
    /// "auto": additive changes apply at once, the rest wait for review.
    pub mode: String,
    pub workspace_ids: Vec<String>,
    pub tools: Vec<String>,
    /// Informational; the app never calls a model.
    pub model: String,
    pub instructions_page_id: Option<String>,
    /// The last characters of the current token, so it can be recognized.
    pub token_hint: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInput {
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub workspace_ids: Vec<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub model: String,
}

const COLUMNS: &str = "id, name, role, status, mode, workspace_ids_json, tools_json, model, instructions_page_id, token_hint, created_at, updated_at, last_seen_at";

fn from_row(r: &Row) -> rusqlite::Result<Agent> {
    let list = |s: String| serde_json::from_str::<Vec<String>>(&s).unwrap_or_default();
    Ok(Agent {
        id: r.get(0)?,
        name: r.get(1)?,
        role: r.get(2)?,
        status: r.get(3)?,
        mode: r.get(4)?,
        workspace_ids: list(r.get(5)?),
        tools: list(r.get(6)?),
        model: r.get(7)?,
        instructions_page_id: r.get(8)?,
        token_hint: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
        last_seen_at: r.get(12)?,
    })
}

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

pub fn list(conn: &Connection) -> AppResult<Vec<Agent>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM agent ORDER BY name COLLATE NOCASE"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Agent> {
    validate_id(id, "agent")?;
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM agent WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("agent".into()))
}

fn check(conn: &Connection, input: &AgentInput, id: Option<&str>) -> AppResult<()> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return bad("Give the agent a name of up to 80 characters.");
    }
    if name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*')) {
        return bad("Agent names cannot contain / \\ : \" < > | ? or *.");
    }
    if input.role.chars().count() > 300 || input.model.chars().count() > 120 {
        return bad("Keep the role under 300 characters and the model under 120.");
    }
    if let Some(m) = &input.mode {
        if !MODES.contains(&m.as_str()) {
            return bad("Mode must be propose, write or auto.");
        }
    }
    if let Some(s) = &input.status {
        if !matches!(s.as_str(), "active" | "paused") {
            return bad("Status must be active or paused.");
        }
    }
    for t in &input.tools {
        if !TOOL_GROUPS.contains(&t.as_str()) {
            return bad(format!("Unknown tool group '{t}'."));
        }
    }
    if input.workspace_ids.len() > 64 {
        return bad("Choose up to 64 workspaces.");
    }
    for w in &input.workspace_ids {
        validate_id(w, "workspace")?;
        if repo::workspace::get(conn, w)?.is_none() {
            return Err(AppError::NotFound("workspace".into()));
        }
    }
    let clash: Option<String> = conn
        .query_row(
            "SELECT id FROM agent WHERE name = ?1 COLLATE NOCASE",
            [name],
            |r| r.get(0),
        )
        .optional()?;
    if clash.is_some_and(|c| Some(c.as_str()) != id) {
        return bad("Another agent already has this name.");
    }
    Ok(())
}

/// The default mode for new agents, chosen in Settings.
pub fn default_mode(conn: &Connection) -> String {
    setting(conn, "agents.defaultMode")
        .ok()
        .flatten()
        .filter(|m| MODES.contains(&m.as_str()))
        .unwrap_or_else(|| "propose".into())
}

fn default_instructions(role: &str) -> String {
    format!(
        "# Role\n\n{}\n\n# How to work\n\n- Read the pages you need before changing them.\n- Record lasting facts and decisions with memory_write.\n- Explain each proposed change in its rationale.\n",
        if role.trim().is_empty() { "Describe what this agent is for." } else { role.trim() }
    )
}

fn instructions_page(tx: &Connection, ws: &str, name: &str, body: &str) -> AppResult<String> {
    let hub = hub::ensure(tx, ws)?;
    let page = crate::transfer::insert_page(tx, None, ws, Some(&hub.page_id), &format!("{name} instructions"), None, "page", false)?;
    content::write_markdown(tx, &page, body, content::WriteMode::Replace)?;
    Ok(page.id)
}

/// Gives the agent a live instructions page in its first workspace when its page is missing,
/// trashed, or in a workspace it no longer sees. The old page's text carries over; the old page
/// itself is left alone. Returns whether a page was made.
pub fn ensure_instructions(conn: &mut Connection, agent: &Agent) -> AppResult<bool> {
    let Some(ws) = agent.workspace_ids.first() else { return Ok(false) };
    let current = match agent.instructions_page_id.as_deref() {
        Some(id) => repo::page::get(conn, id)?,
        None => None,
    };
    if current.as_ref().is_some_and(|p| p.deleted_at.is_none() && agent.in_workspace(&p.workspace_id)) {
        return Ok(false);
    }
    let body = current
        .and_then(|p| content::body_markdown(conn, &p.id).ok())
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| default_instructions(&agent.role));
    let tx = conn.transaction()?;
    let page_id = instructions_page(&tx, ws, &agent.name, &body)?;
    tx.execute("UPDATE agent SET instructions_page_id = ?2 WHERE id = ?1", params![agent.id, page_id])?;
    tx.commit()?;
    Ok(true)
}

/// Runs [`ensure_instructions`] for every agent.
pub fn repair_instructions(conn: &mut Connection) -> AppResult<usize> {
    let mut n = 0;
    for a in list(conn)? {
        n += usize::from(ensure_instructions(conn, &a)?);
    }
    Ok(n)
}

pub fn create(conn: &mut Connection, input: AgentInput) -> AppResult<Agent> {
    check(conn, &input, None)?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM agent", [], |r| r.get(0))?;
    if count >= MAX_AGENTS {
        return bad(format!("Up to {MAX_AGENTS} agents can be set up."));
    }
    let tx = conn.transaction()?;
    let id = new_id();
    let stamp = now();
    let mode = input.mode.clone().unwrap_or_else(|| default_mode(&tx));
    let tools = if input.tools.is_empty() {
        vec!["pages".to_string(), "graph".into(), "memory".into(), "tasks".into()]
    } else {
        input.tools.clone()
    };
    // The agent's instructions live in an ordinary page in its first workspace's Agent Hub.
    let instructions = match input.workspace_ids.first() {
        Some(ws) => Some(instructions_page(&tx, ws, input.name.trim(), &default_instructions(&input.role))?),
        None => None,
    };
    tx.execute(
        "INSERT INTO agent (id, name, role, status, mode, workspace_ids_json, tools_json, model, instructions_page_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            id,
            input.name.trim(),
            input.role.trim(),
            input.status.clone().unwrap_or_else(|| "active".into()),
            mode,
            serde_json::to_string(&input.workspace_ids).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&tools).unwrap_or_else(|_| "[]".into()),
            input.model.trim(),
            instructions,
            stamp
        ],
    )?;
    tx.commit()?;
    get(conn, &id)
}

pub fn update(conn: &mut Connection, id: &str, input: AgentInput) -> AppResult<Agent> {
    let current = get(conn, id)?;
    check(conn, &input, Some(id))?;
    conn.execute(
        "UPDATE agent SET name = ?2, role = ?3, status = ?4, mode = ?5, workspace_ids_json = ?6, tools_json = ?7, model = ?8, updated_at = ?9 WHERE id = ?1",
        params![
            id,
            input.name.trim(),
            input.role.trim(),
            input.status.unwrap_or(current.status),
            input.mode.unwrap_or(current.mode),
            serde_json::to_string(&input.workspace_ids).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&input.tools).unwrap_or_else(|_| "[]".into()),
            input.model.trim(),
            now()
        ],
    )?;
    // A change of workspaces can leave the instructions page out of the agent's sight.
    ensure_instructions(conn, &get(conn, id)?)?;
    get(conn, id)
}

/// Removes an agent and its token. Its instructions page, proposals and history stay.
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    validate_id(id, "agent")?;
    conn.execute("DELETE FROM agent WHERE id = ?1", [id])?;
    conn.execute(
        "UPDATE proposal SET status = 'rejected', decision_note = 'The agent was removed.', decided_at = ?1 WHERE agent_id = ?2 AND status = 'pending'",
        params![now(), id],
    )?;
    Ok(())
}

fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Issues a new token, replacing the old one. The token is returned once and stored only as a hash.
pub fn rotate_token(conn: &Connection, id: &str) -> AppResult<String> {
    get(conn, id)?;
    let token = format!(
        "sva_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let hint: String = token.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    conn.execute(
        "UPDATE agent SET token_hash = ?2, token_hint = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, hash_token(&token), hint, now()],
    )?;
    Ok(token)
}

pub fn revoke_token(conn: &Connection, id: &str) -> AppResult<()> {
    get(conn, id)?;
    conn.execute(
        "UPDATE agent SET token_hash = NULL, token_hint = NULL, updated_at = ?2 WHERE id = ?1",
        params![id, now()],
    )?;
    Ok(())
}

/// Whether `token` is the agent's current token.
pub fn token_matches(conn: &Connection, id: &str, token: &str) -> bool {
    conn.query_row("SELECT token_hash FROM agent WHERE id = ?1", [id], |r| r.get::<_, Option<String>>(0))
        .ok()
        .flatten()
        .is_some_and(|h| h == hash_token(token.trim()))
}

/// The active agent a token belongs to.
pub fn authenticate(conn: &Connection, token: &str) -> AppResult<Option<Agent>> {
    let token = token.trim();
    if !token.starts_with("sva_") || token.len() != 68 {
        return Ok(None);
    }
    let agent = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM agent WHERE token_hash = ?1"),
            [hash_token(token)],
            from_row,
        )
        .optional()?;
    let Some(agent) = agent.filter(|a| a.status == "active") else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE agent SET last_seen_at = ?2 WHERE id = ?1",
        params![agent.id, now()],
    )?;
    Ok(Some(agent))
}

// ---------------------------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------------------------

impl Agent {
    pub fn can_use(&self, group: &str) -> bool {
        self.tools.iter().any(|t| t == group)
    }

    pub fn require(&self, group: &str) -> AppResult<()> {
        if self.can_use(group) {
            Ok(())
        } else {
            Err(AppError::Validation(format!(
                "This agent is not allowed to use the {group} tools."
            )))
        }
    }

    pub fn in_workspace(&self, workspace_id: &str) -> bool {
        self.workspace_ids.iter().any(|w| w == workspace_id)
    }

    /// The workspace to act in: the one asked for (when in scope) or the agent's first.
    pub fn workspace(&self, asked: Option<&str>) -> AppResult<String> {
        match asked {
            Some(w) if self.in_workspace(w) => Ok(w.to_string()),
            Some(_) => Err(AppError::NotFound("workspace".into())),
            None => self
                .workspace_ids
                .first()
                .cloned()
                .ok_or_else(|| AppError::Validation("This agent has no workspaces. Add one in Settings > Agents.".into())),
        }
    }

    /// A live page the agent may see. Pages outside its workspaces read as missing.
    pub fn page(&self, conn: &Connection, page_id: &str) -> AppResult<Page> {
        validate_id(page_id, "page")?;
        repo::page::get(conn, page_id)?
            .filter(|p| p.deleted_at.is_none() && self.in_workspace(&p.workspace_id))
            .ok_or_else(|| AppError::NotFound("page".into()))
    }
}

// ---------------------------------------------------------------------------------------------
// installation settings
// ---------------------------------------------------------------------------------------------

pub fn setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM app_setting WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO app_setting (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    /// Whether the agent API listens at all.
    pub api_enabled: bool,
    /// The mode new agents start with.
    pub default_mode: String,
    /// How edits made to mirror files outside the app are taken in: "propose" or "apply".
    pub mirror_edits: String,
}

pub fn settings(conn: &Connection) -> AppResult<AgentSettings> {
    Ok(AgentSettings {
        api_enabled: setting(conn, "agents.apiEnabled")?.as_deref() == Some("true"),
        default_mode: default_mode(conn),
        mirror_edits: setting(conn, "agents.mirrorEdits")?
            .filter(|m| m == "apply")
            .unwrap_or_else(|| "propose".into()),
    })
}

pub fn save_settings(conn: &Connection, s: &AgentSettings) -> AppResult<AgentSettings> {
    if !MODES.contains(&s.default_mode.as_str()) {
        return bad("Mode must be propose, write or auto.");
    }
    if !matches!(s.mirror_edits.as_str(), "propose" | "apply") {
        return bad("Mirror edits must be propose or apply.");
    }
    set_setting(conn, "agents.apiEnabled", if s.api_enabled { "true" } else { "false" })?;
    set_setting(conn, "agents.defaultMode", &s.default_mode)?;
    set_setting(conn, "agents.mirrorEdits", &s.mirror_edits)?;
    settings(conn)
}

/// Records one agent API call (never its arguments or the content it returned).
pub fn audit(conn: &Connection, agent_id: &str, tool: &str, ok: bool, ms: u64) {
    let _ = conn.execute(
        "INSERT INTO agent_audit (agent_id, tool, ok, duration_ms, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![agent_id, tool, ok, ms as i64, now()],
    );
    // Keep the newest 5,000 calls.
    let _ = conn.execute(
        "DELETE FROM agent_audit WHERE id <= (SELECT id FROM agent_audit ORDER BY id DESC LIMIT 1 OFFSET 5000)",
        [],
    );
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub agent_id: String,
    pub tool: String,
    pub ok: bool,
    pub duration_ms: i64,
    pub created_at: String,
}

pub fn audit_list(conn: &Connection, agent_id: Option<&str>, limit: i64) -> AppResult<Vec<AuditEntry>> {
    let mut stmt = conn.prepare(
        "SELECT agent_id, tool, ok, duration_ms, created_at FROM agent_audit
         WHERE ?1 IS NULL OR agent_id = ?1 ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![agent_id, limit.clamp(1, 500)], |r| {
        Ok(AuditEntry {
            agent_id: r.get(0)?,
            tool: r.get(1)?,
            ok: r.get(2)?,
            duration_ms: r.get(3)?,
            created_at: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

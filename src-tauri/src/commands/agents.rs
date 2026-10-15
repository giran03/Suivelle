//! Settings > Agents, the Review inbox and agent activity: the only place agent permissions,
//! scopes and tokens change.

use super::{lock, logged, worker, worker::blocking};
use crate::agents::clients::{self, subagents, ConnectInput, Env};
use crate::agents::{self, changeset, janitor, mirror, ops, spec, tasks, Agent, AgentInput, AgentSettings};
use crate::database::Db;
use crate::errors::{AppError, AppResult};
use serde::Serialize;
use tauri::{Emitter, Manager};

fn run<T, F>(app: &tauri::AppHandle, name: &str, f: F) -> AppResult<T>
where
    F: FnOnce(&mut rusqlite::Connection) -> AppResult<T>,
{
    let t = std::time::Instant::now();
    let db = app.state::<Db>();
    let res = lock(&db).and_then(|mut c| f(&mut c));
    logged(name, t, res)
}

fn writable(app: &tauri::AppHandle) -> AppResult<()> {
    if app.try_state::<crate::SafeMode>().is_some_and(|s| s.0.is_some()) {
        return Err(AppError::Validation("Suivelle is open read-only right now.".into()));
    }
    Ok(())
}

/// Tells the window pages changed outside the editor, so it can refresh.
fn changed(app: &tauri::AppHandle, page_ids: &[String], source: &str) {
    let _ = app.emit("agent-activity", serde_json::json!({ "agentName": source, "tool": "review", "pageIds": page_ids }));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub settings: AgentSettings,
    pub agents: Vec<Agent>,
    pub port: Option<u16>,
    pub bridge_path: Option<String>,
    pub pending: i64,
}

fn bridge_path() -> Option<String> {
    clients::bridge::bundled().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn agents_overview(app: tauri::AppHandle) -> AppResult<Overview> {
    blocking("agents_overview", move || {
        run(&app, "agents_overview", |c| {
            Ok(Overview {
                settings: agents::settings(c)?,
                agents: agents::list(c)?,
                port: agents::server::port(),
                bridge_path: bridge_path(),
                pending: ops::pending_count(c)?,
            })
        })
    })
    .await
}

#[tauri::command]
pub async fn agents_save_settings(app: tauri::AppHandle, settings: AgentSettings) -> AppResult<AgentSettings> {
    blocking("agents_save_settings", move || {
        writable(&app)?;
        let saved = run(&app, "agents_save_settings", |c| agents::save_settings(c, &settings))?;
        if saved.api_enabled {
            agents::server::start(&app);
        }
        Ok(saved)
    })
    .await
}

#[tauri::command]
pub async fn agent_create(app: tauri::AppHandle, input: AgentInput) -> AppResult<Agent> {
    blocking("agent_create", move || {
        writable(&app)?;
        run(&app, "agent_create", |c| agents::create(c, input))
    })
    .await
}

#[tauri::command]
pub async fn agent_update(app: tauri::AppHandle, id: String, input: AgentInput) -> AppResult<Agent> {
    blocking("agent_update", move || {
        writable(&app)?;
        run(&app, "agent_update", |c| agents::update(c, &id, input))
    })
    .await
}

#[tauri::command]
pub async fn agent_delete(app: tauri::AppHandle, id: String) -> AppResult<()> {
    blocking("agent_delete", move || {
        writable(&app)?;
        run(&app, "agent_delete", |c| {
            // An agent connected to an app leaves that app's config first.
            if let Some(client) = clients::client_of(c, &id)? {
                if let Err(e) = Env::system().and_then(|env| clients::disconnect(c, &env, &client)) {
                    tracing::warn!(error = %e, "could not disconnect the agent's app");
                }
            }
            agents::delete(c, &id)
        })
    })
    .await
}

/// A new token for the agent, shown once.
#[tauri::command]
pub async fn agent_token_rotate(app: tauri::AppHandle, id: String) -> AppResult<String> {
    blocking("agent_token_rotate", move || {
        writable(&app)?;
        run(&app, "agent_token_rotate", |c| agents::rotate_token(c, &id))
    })
    .await
}

#[tauri::command]
pub async fn agent_token_revoke(app: tauri::AppHandle, id: String) -> AppResult<()> {
    blocking("agent_token_revoke", move || {
        writable(&app)?;
        run(&app, "agent_token_revoke", |c| agents::revoke_token(c, &id))
    })
    .await
}

#[tauri::command]
pub async fn agent_audit(app: tauri::AppHandle, agent_id: Option<String>) -> AppResult<Vec<agents::AuditEntry>> {
    blocking("agent_audit", move || run(&app, "agent_audit", |c| agents::audit_list(c, agent_id.as_deref(), 200))).await
}

// ---------------------------------------------------------------------------------------------
// review inbox and activity
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn proposal_list(app: tauri::AppHandle, status: String) -> AppResult<Vec<ops::ProposalInfo>> {
    blocking("proposal_list", move || run(&app, "proposal_list", |c| ops::list(c, &status, None, 200))).await
}

#[tauri::command]
pub async fn proposal_detail(app: tauri::AppHandle, id: String) -> AppResult<ops::ProposalInfo> {
    blocking("proposal_detail", move || run(&app, "proposal_detail", |c| ops::detail(c, &id))).await
}

#[tauri::command]
pub async fn proposal_approve(
    app: tauri::AppHandle,
    id: String,
    only: Option<Vec<usize>>,
    note: Option<String>,
) -> AppResult<Vec<String>> {
    blocking("proposal_approve", move || {
        writable(&app)?;
        let result = run(&app, "proposal_approve", |c| {
            let out = ops::approve(c, &id, only, note);
            // A failed apply is a decision too: the agent hears about it either way.
            let task = crate::agents::resume::follow_up(c, &id).ok().flatten();
            let out = out?;
            super::react(&app, c, out.events.clone());
            Ok(out.page_ids.into_iter().chain(task).collect::<Vec<_>>())
        });
        let pages = result?;
        changed(&app, &pages, "Review");
        Ok(pages)
    })
    .await
}

#[tauri::command]
pub async fn proposal_reject(app: tauri::AppHandle, id: String, note: Option<String>) -> AppResult<()> {
    blocking("proposal_reject", move || {
        writable(&app)?;
        let task = run(&app, "proposal_reject", |c| {
            ops::reject(c, &id, note)?;
            crate::agents::resume::follow_up(c, &id)
        })?;
        if let Some(task) = task {
            changed(&app, &[task], "Review");
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn changeset_list(
    app: tauri::AppHandle,
    agent_id: Option<String>,
    page_id: Option<String>,
) -> AppResult<Vec<changeset::ChangesetInfo>> {
    blocking("changeset_list", move || {
        run(&app, "changeset_list", |c| changeset::list(c, agent_id.as_deref(), page_id.as_deref(), 100))
    })
    .await
}

#[tauri::command]
pub async fn changeset_revert(app: tauri::AppHandle, id: String) -> AppResult<Vec<String>> {
    blocking("changeset_revert", move || {
        writable(&app)?;
        let pages = run(&app, "changeset_revert", |c| changeset::revert(c, &id))?;
        changed(&app, &pages, "Revert");
        Ok(pages)
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// vault health
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn janitor_report(app: tauri::AppHandle, workspace_id: String) -> AppResult<Vec<janitor::Finding>> {
    blocking("janitor_report", move || run(&app, "janitor_report", |c| janitor::report(c, &workspace_id, &[], 100))).await
}

/// Applies suggested fixes the user picked, as one revertable changeset.
#[tauri::command]
pub async fn janitor_fix(app: tauri::AppHandle, workspace_id: String, fixes: Vec<ops::Op>) -> AppResult<Vec<String>> {
    blocking("janitor_fix", move || {
        writable(&app)?;
        if fixes.is_empty() || fixes.len() > ops::MAX_OPS {
            return Err(AppError::Validation("Choose between 1 and 200 fixes.".into()));
        }
        let pages = run(&app, "janitor_fix", |c| {
            let actor = ops::Actor::user(vec![workspace_id.clone()]);
            let (_, fx) = ops::apply_as(c, &actor, "Vault health fixes", None, &fixes)?;
            super::react(&app, c, fx.events.clone());
            Ok(fx.page_ids)
        })?;
        changed(&app, &pages, "Vault health");
        Ok(pages)
    })
    .await
}

#[tauri::command]
pub async fn todo_promote(app: tauri::AppHandle, block_id: String, agent: Option<String>) -> AppResult<String> {
    blocking("todo_promote", move || {
        writable(&app)?;
        let (id, pages) = run(&app, "todo_promote", |c| {
            let workspaces: Vec<String> = crate::repositories::workspace::list(c)?.into_iter().map(|w| w.id).collect();
            tasks::promote(c, &ops::Actor::user(workspaces), &block_id, agent.as_deref())
        })?;
        changed(&app, &pages, "Tasks");
        Ok(id)
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// mirror and exports
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn mirror_get(app: tauri::AppHandle, workspace_id: String) -> AppResult<mirror::MirrorConfig> {
    blocking("mirror_get", move || run(&app, "mirror_get", |c| mirror::config(c, &workspace_id))).await
}

#[tauri::command]
pub async fn mirror_choose(app: tauri::AppHandle, workspace_id: String) -> AppResult<Option<mirror::MirrorConfig>> {
    worker::dialog("mirror_choose", move || {
        use tauri_plugin_dialog::DialogExt;
        writable(&app)?;
        let Some(folder) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let path = super::path_of(folder)?.to_string_lossy().into_owned();
        run(&app, "mirror_choose", |c| mirror::configure(c, &workspace_id, true, Some(path))).map(Some)
    })
    .await
}

#[tauri::command]
pub async fn mirror_set_enabled(app: tauri::AppHandle, workspace_id: String, enabled: bool) -> AppResult<mirror::MirrorConfig> {
    blocking("mirror_set_enabled", move || {
        writable(&app)?;
        run(&app, "mirror_set_enabled", |c| mirror::configure(c, &workspace_id, enabled, None))
    })
    .await
}

/// Asks for a project folder and writes the agent's Claude Code subagent file into it.
#[tauri::command]
pub async fn agent_export_subagent(app: tauri::AppHandle, id: String, force: bool) -> AppResult<Option<spec::Exported>> {
    worker::dialog("agent_export_subagent", move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(folder) = app.dialog().file().set_title("Choose the project folder").blocking_pick_folder() else {
            return Ok(None);
        };
        let dir = super::path_of(folder)?;
        run(&app, "agent_export_subagent", |c| {
            let agent = agents::get(c, &id)?;
            spec::export_subagent(c, &agent, &dir, force)
        })
        .map(Some)
    })
    .await
}

/// Asks for a project folder and writes the Suivelle section of its AGENTS.md.
#[tauri::command]
pub async fn agents_export_agents_md(app: tauri::AppHandle, page_ids: Vec<String>, force: bool) -> AppResult<Option<spec::Exported>> {
    worker::dialog("agents_export_agents_md", move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(folder) = app.dialog().file().set_title("Choose the project folder").blocking_pick_folder() else {
            return Ok(None);
        };
        let dir = super::path_of(folder)?;
        run(&app, "agents_export_agents_md", |c| {
            let list = agents::list(c)?;
            spec::export_agents_md(c, &list, &page_ids, &dir, force)
        })
        .map(Some)
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// agent apps on this computer
// ---------------------------------------------------------------------------------------------

/// Looks for agent apps (Claude Code, Codex, Cursor, …). Reads files and PATH only.
#[tauri::command]
pub async fn clients_scan(app: tauri::AppHandle) -> AppResult<clients::Scan> {
    blocking("clients_scan", move || {
        let env = Env::system()?;
        run(&app, "clients_scan", |c| clients::scan(c, &env))
    })
    .await
}

/// Connects an app: its agent, a token, and the suivelle entry in its MCP config.
#[tauri::command]
pub async fn client_connect(app: tauri::AppHandle, client_id: String, input: ConnectInput) -> AppResult<clients::ConnectResult> {
    blocking("client_connect", move || {
        writable(&app)?;
        let env = Env::system()?;
        let out = run(&app, "client_connect", |c| clients::connect(c, &env, &client_id, input))?;
        changed(&app, &[], "Agents");
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn client_repair(app: tauri::AppHandle, client_id: String) -> AppResult<clients::ConnectResult> {
    blocking("client_repair", move || {
        writable(&app)?;
        let env = Env::system()?;
        run(&app, "client_repair", |c| clients::repair(c, &env, &client_id))
    })
    .await
}

#[tauri::command]
pub async fn client_disconnect(app: tauri::AppHandle, client_id: String) -> AppResult<clients::DisconnectResult> {
    blocking("client_disconnect", move || {
        writable(&app)?;
        let env = Env::system()?;
        run(&app, "client_disconnect", |c| clients::disconnect(c, &env, &client_id))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentScan {
    pub folder: String,
    pub items: Vec<subagents::Subagent>,
}

/// Claude Code subagents in the user's folder, or (with `project`) in a project folder the user picks.
#[tauri::command]
pub async fn subagents_scan(app: tauri::AppHandle, project: bool) -> AppResult<Option<SubagentScan>> {
    worker::dialog("subagents_scan", move || {
        use tauri_plugin_dialog::DialogExt;
        let dir = if project {
            let Some(folder) = app.dialog().file().set_title("Choose the project folder").blocking_pick_folder() else {
                return Ok(None);
            };
            super::path_of(folder)?
        } else {
            dirs::home_dir().ok_or_else(|| AppError::Internal("Could not find the user folder.".into()))?
        };
        let folder = dir.join(".claude").join("agents");
        let items = run(&app, "subagents_scan", |c| subagents::scan(c, &dir))?;
        Ok(Some(SubagentScan { folder: folder.to_string_lossy().into_owned(), items }))
    })
    .await
}

#[tauri::command]
pub async fn subagents_import(
    app: tauri::AppHandle,
    paths: Vec<String>,
    workspace_ids: Vec<String>,
    mode: Option<String>,
) -> AppResult<Vec<subagents::Imported>> {
    blocking("subagents_import", move || {
        writable(&app)?;
        let out = run(&app, "subagents_import", |c| subagents::import(c, &paths, &workspace_ids, mode))?;
        changed(&app, &[], "Agents");
        Ok(out)
    })
    .await
}

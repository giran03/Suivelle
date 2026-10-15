//! Letting an agent carry on after the user decides on its proposal, without Suivelle ever
//! reaching out to it.
//!
//! An agent that depends on a pending proposal calls `proposal_wait`. While its session is open,
//! the call stays open and returns the decision as soon as it is made (the server polls the
//! database and keeps `waiting_until` a few seconds ahead). If nobody is waiting when the user
//! decides (the wait ran out or the session ended), a "Continue: …" task is queued for that agent,
//! which its next session picks up.

use super::ops::{self, ProposalInfo};
use super::Agent;
use crate::domain::now;
use crate::errors::{AppError, AppResult};
use rusqlite::{params, Connection};

/// How far ahead a waiting session marks itself as present; it renews this on every poll.
const PRESENCE_SECS: i64 = 5;
pub const MAX_WAIT_SECS: u64 = 600;
pub const DEFAULT_WAIT_SECS: u64 = 300;

/// What the agent is told about a decided proposal.
pub fn outcome(p: &ProposalInfo) -> String {
    let note = p
        .decision_note
        .as_deref()
        .filter(|n| !n.trim().is_empty())
        .map(|n| format!(" Reviewer's note: {n}"))
        .unwrap_or_default();
    match p.status.as_str() {
        "applied" => format!("Proposal {} “{}” was approved and applied.{note} Continue the work that depended on it.", p.id, p.title),
        "rejected" => format!("Proposal {} “{}” was rejected.{note} Adjust your approach; propose again only with the note addressed.", p.id, p.title),
        "failed" => format!(
            "Proposal {} “{}” was approved but could not be applied: {}. Re-read the pages involved and propose again.",
            p.id,
            p.title,
            p.error.as_deref().unwrap_or("unknown error")
        ),
        other => format!("Proposal {} “{}” is {other}.", p.id, p.title),
    }
}

fn own(conn: &Connection, agent: &Agent, id: &str) -> AppResult<ProposalInfo> {
    let p = ops::detail(conn, id)?;
    if p.agent_id.as_deref() != Some(&agent.id) {
        return Err(AppError::NotFound("proposal".into()));
    }
    Ok(p)
}

/// The decision if there is one. Otherwise marks the agent as wanting to hear it, and present
/// (`waiting`) when its session will now wait.
pub fn begin(
    conn: &Connection,
    agent: &Agent,
    id: &str,
    waiting: bool,
) -> AppResult<Option<String>> {
    let p = own(conn, agent, id)?;
    if p.status != "pending" {
        return Ok(Some(outcome(&p)));
    }
    conn.execute(
        "UPDATE proposal SET resume = 1 WHERE id = ?1 AND resume = 0",
        [id],
    )?;
    if waiting {
        renew(conn, id)?;
    }
    Ok(None)
}

/// Keeps a waiting session marked as present, and returns the decision once made.
pub fn poll(conn: &Connection, agent: &Agent, id: &str) -> AppResult<Option<String>> {
    let p = own(conn, agent, id)?;
    if p.status != "pending" {
        conn.execute(
            "UPDATE proposal SET waiting_until = NULL WHERE id = ?1",
            [id],
        )?;
        return Ok(Some(outcome(&p)));
    }
    renew(conn, id)?;
    Ok(None)
}

fn renew(conn: &Connection, id: &str) -> AppResult<()> {
    let until = (chrono::Utc::now() + chrono::Duration::seconds(PRESENCE_SECS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    conn.execute(
        "UPDATE proposal SET waiting_until = ?2 WHERE id = ?1",
        params![id, until],
    )?;
    Ok(())
}

/// The session stopped waiting without a decision.
pub fn end(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE proposal SET waiting_until = NULL WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// After the user decides: queues a "Continue: …" task for the agent when it asked to hear the
/// decision and no session of it is waiting. Returns the task's page id.
pub fn follow_up(conn: &mut Connection, id: &str) -> AppResult<Option<String>> {
    let p = ops::detail(conn, id)?;
    let waiting = conn.query_row(
        "SELECT COALESCE(waiting_until > ?2, 0) FROM proposal WHERE id = ?1",
        params![id, now()],
        |r| r.get::<_, bool>(0),
    )?;
    if !p.resume || p.status == "pending" || waiting {
        return Ok(None);
    }
    // Only once, and only for an agent that still exists.
    if conn.execute(
        "UPDATE proposal SET resume = 2 WHERE id = ?1 AND resume = 1",
        [id],
    )? == 0
    {
        return Ok(None);
    }
    let Some(agent) = p.agent_id.as_deref().and_then(|a| super::get(conn, a).ok()) else {
        return Ok(None);
    };
    let body = format!("{}\n\nProposal id: {}", outcome(&p), p.id);
    let task = super::tasks::queue_for(
        conn,
        &p.workspace_id,
        &agent.name,
        &format!("Continue: {}", p.title),
        &body,
    )?;
    Ok(Some(task))
}

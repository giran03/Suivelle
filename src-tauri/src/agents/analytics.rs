//! Privacy-safe token usage and Jev ("System One") telemetry for connected AI agents.
//!
//! Suivelle never logs page bodies or tool arguments in `agent_audit`. Instead, each MCP request
//! accumulates character-derived token counts (`input_tokens`, `output_tokens`, `saved_tokens`) and
//! Jev gatekeeper metrics (`jev_calls`, `jev_cache_hits`, `jev_errors`, `jev_tokens`,
//! `jev_questions`, `jev_ms`, `jev_pruned`) in thread-local storage for the duration of the call,
//! then writes the summary row when the call finishes.

use crate::errors::AppResult;
use chrono::{Duration, Timelike, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::collections::{BTreeMap, HashMap};

/// Fast, deterministic token estimate (~4 UTF-8 characters per token), matching `context::pack`.
pub fn estimate_tokens(text: &str) -> i64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let chars = trimmed.chars().count() as i64;
    ((chars + 3) / 4).max(1)
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallMetrics {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub saved_tokens: i64,
    pub jev_calls: i64,
    pub jev_cache_hits: i64,
    pub jev_errors: i64,
    pub jev_tokens: i64,
    pub jev_questions: i64,
    pub jev_ms: i64,
    pub jev_pruned: i64,
}

thread_local! {
    static CURRENT: Cell<CallMetrics> = const { Cell::new(CallMetrics {
        input_tokens: 0,
        output_tokens: 0,
        saved_tokens: 0,
        jev_calls: 0,
        jev_cache_hits: 0,
        jev_errors: 0,
        jev_tokens: 0,
        jev_questions: 0,
        jev_ms: 0,
        jev_pruned: 0,
    }) };
}

/// Resets the thread-local telemetry accumulator at the start of an agent operation.
pub fn begin_call() {
    CURRENT.with(|c| c.set(CallMetrics::default()));
}

/// Adds tokens prevented from entering the agent's context window (via Jev pruning, body tiering,
/// duplicate suppression, or `known_hash` page skip) and the number of items pruned/compressed.
pub fn record_saved(saved_tokens: i64, pruned_items: i64) {
    if saved_tokens <= 0 && pruned_items <= 0 {
        return;
    }
    CURRENT.with(|c| {
        let mut m = c.get();
        m.saved_tokens = m.saved_tokens.saturating_add(saved_tokens.max(0));
        m.jev_pruned = m.jev_pruned.saturating_add(pruned_items.max(0));
        c.set(m);
    });
}

/// Records one live HTTP request to Jev (`POST /v1/systemone`).
pub fn record_jev_call(tokens: i64, questions: usize, ms: u64) {
    CURRENT.with(|c| {
        let mut m = c.get();
        m.jev_calls = m.jev_calls.saturating_add(1);
        m.jev_tokens = m.jev_tokens.saturating_add(tokens.max(0));
        m.jev_questions = m.jev_questions.saturating_add(questions as i64);
        m.jev_ms = m.jev_ms.saturating_add(ms as i64);
        c.set(m);
    });
}

/// Records a Jev evaluation served from the 5-minute in-memory cache (`0` remote tokens, `0 ms`).
pub fn record_jev_cache_hit(questions: usize) {
    CURRENT.with(|c| {
        let mut m = c.get();
        m.jev_cache_hits = m.jev_cache_hits.saturating_add(1);
        m.jev_questions = m.jev_questions.saturating_add(questions as i64);
        c.set(m);
    });
}

/// Records a Jev evaluation that failed open due to timeout, network error, or non-2xx status.
pub fn record_jev_error(questions: usize, ms: u64) {
    CURRENT.with(|c| {
        let mut m = c.get();
        m.jev_errors = m.jev_errors.saturating_add(1);
        m.jev_questions = m.jev_questions.saturating_add(questions as i64);
        m.jev_ms = m.jev_ms.saturating_add(ms as i64);
        c.set(m);
    });
}

/// Reads the current accumulated metrics without resetting them.
pub fn current_metrics() -> CallMetrics {
    CURRENT.with(|c| c.get())
}

/// Finalizes the current call's metrics by computing `input_tokens` and `output_tokens` and
/// resetting the thread-local accumulator.
pub fn finish_call(input_text: &str, output_text: &str) -> CallMetrics {
    CURRENT.with(|c| {
        let mut m = c.get();
        m.input_tokens = estimate_tokens(input_text);
        m.output_tokens = estimate_tokens(output_text);
        c.set(CallMetrics::default());
        m
    })
}

fn pct(saved: i64, output: i64) -> f64 {
    let denom = output.saturating_add(saved);
    if denom <= 0 || saved <= 0 {
        0.0
    } else {
        ((saved as f64 / denom as f64) * 1000.0).round() / 10.0
    }
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub calls: i64,
    pub errors: i64,
    pub avg_duration_ms: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub saved_tokens: i64,
    pub savings_pct: f64,
    pub jev_calls: i64,
    pub jev_cache_hits: i64,
    pub jev_errors: i64,
    pub jev_tokens: i64,
    pub jev_questions: i64,
    pub jev_avg_ms: i64,
    pub jev_pruned: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub agent_id: String,
    pub agent_name: String,
    pub role: String,
    pub model: String,
    pub status: String,
    pub last_seen_at: Option<String>,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub calls: i64,
    pub errors: i64,
    pub avg_duration_ms: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub saved_tokens: i64,
    pub savings_pct: f64,
    pub jev_calls: i64,
    pub jev_cache_hits: i64,
    pub jev_tokens: i64,
    pub jev_pruned: i64,
    pub top_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    pub tool: String,
    pub calls: i64,
    pub errors: i64,
    pub avg_duration_ms: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub saved_tokens: i64,
    pub jev_calls: i64,
    pub jev_cache_hits: i64,
    pub jev_tokens: i64,
    pub jev_pruned: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub key: String,
    pub label: String,
    pub calls: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub saved_tokens: i64,
    pub jev_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub range: String,
    pub totals: UsageTotals,
    pub agents: Vec<AgentUsage>,
    pub tools: Vec<ToolUsage>,
    pub series: Vec<UsageBucket>,
    pub hourly_series: Vec<UsageBucket>,
    pub recent: Vec<super::AuditEntry>,
}

#[derive(Default)]
struct Accum {
    calls: i64,
    errors: i64,
    duration_ms: i64,
    input_tokens: i64,
    output_tokens: i64,
    saved_tokens: i64,
    jev_calls: i64,
    jev_cache_hits: i64,
    jev_errors: i64,
    jev_tokens: i64,
    jev_questions: i64,
    jev_ms: i64,
    jev_pruned: i64,
    tool_counts: HashMap<String, i64>,
}

impl Accum {
    fn add(&mut self, e: &super::AuditEntry) {
        self.calls += 1;
        if !e.ok {
            self.errors += 1;
        }
        self.duration_ms += e.duration_ms.max(0);
        self.input_tokens += e.input_tokens.max(0);
        self.output_tokens += e.output_tokens.max(0);
        self.saved_tokens += e.saved_tokens.max(0);
        self.jev_calls += e.jev_calls.max(0);
        self.jev_cache_hits += e.jev_cache_hits.max(0);
        self.jev_errors += e.jev_errors.max(0);
        self.jev_tokens += e.jev_tokens.max(0);
        self.jev_questions += e.jev_questions.max(0);
        self.jev_ms += e.jev_ms.max(0);
        self.jev_pruned += e.jev_pruned.max(0);
        *self.tool_counts.entry(e.tool.clone()).or_insert(0) += 1;
    }

    fn avg_ms(&self) -> i64 {
        if self.calls > 0 {
            self.duration_ms / self.calls
        } else {
            0
        }
    }

    fn jev_avg_ms(&self) -> i64 {
        let remote = self.jev_calls + self.jev_errors;
        if remote > 0 {
            self.jev_ms / remote
        } else {
            0
        }
    }

    fn top_tools(&self) -> Vec<String> {
        let mut v: Vec<(&String, &i64)> = self.tool_counts.iter().collect();
        v.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        v.into_iter().take(3).map(|(k, _)| k.clone()).collect()
    }
}

fn normalize_range(range: Option<&str>) -> &'static str {
    match range.map(str::trim) {
        Some("24h") => "24h",
        Some("7d") => "7d",
        Some("30d") => "30d",
        Some("all") => "all",
        _ => "7d",
    }
}

fn build_buckets(range: &str, now: chrono::DateTime<Utc>) -> Vec<UsageBucket> {
    if range == "24h" {
        let base = now
            .with_minute(0)
            .and_then(|t| t.with_second(0))
            .and_then(|t| t.with_nanosecond(0))
            .unwrap_or(now);
        (0..24)
            .rev()
            .map(|h| {
                let dt = base - Duration::hours(h);
                UsageBucket {
                    key: dt.format("%Y-%m-%dT%H").to_string(),
                    label: dt.format("%H:00").to_string(),
                    calls: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    saved_tokens: 0,
                    jev_tokens: 0,
                }
            })
            .collect()
    } else {
        let days: i64 = if range == "7d" { 7 } else { 14 };
        let today = now.date_naive();
        (0..days)
            .rev()
            .map(|d| {
                let date = today - Duration::days(d);
                UsageBucket {
                    key: date.format("%Y-%m-%d").to_string(),
                    label: date.format("%b %d").to_string(),
                    calls: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    saved_tokens: 0,
                    jev_tokens: 0,
                }
            })
            .collect()
    }
}

/// Builds the full token and Jev usage report for `range` (`"24h"`, `"7d"`, `"30d"`, `"all"`)
/// and optional `agent_id` filter.
pub fn report(
    conn: &Connection,
    range: Option<&str>,
    agent_id: Option<&str>,
) -> AppResult<UsageReport> {
    let range = normalize_range(range);
    let agent_filter = agent_id.map(str::trim).filter(|s| !s.is_empty());
    let now = Utc::now();
    let cutoff = match range {
        "24h" => Some(
            (now - Duration::hours(24)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ),
        "7d" => {
            Some((now - Duration::days(7)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        }
        "30d" => {
            Some((now - Duration::days(30)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        }
        _ => None,
    };

    let agents_list = super::list(conn)?;
    let mut agent_map: HashMap<String, super::Agent> = HashMap::new();
    for a in &agents_list {
        agent_map.insert(a.id.clone(), a.clone());
    }

    // Map agent_id -> (client_id, client_name) from `agent_client` and the bundled catalogue.
    let mut client_by_agent: HashMap<String, (String, String)> = HashMap::new();
    {
        let cat = super::clients::catalogue();
        let mut stmt = conn.prepare("SELECT agent_id, client_id FROM agent_client")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows.flatten() {
            let (aid, cid) = row;
            let cname = cat
                .clients
                .iter()
                .find(|c| c.id == cid)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| cid.clone());
            client_by_agent.insert(aid, (cid, cname));
        }
    }

    let mut stmt = conn.prepare(
        "SELECT agent_id, tool, ok, duration_ms, created_at,
                input_tokens, output_tokens, saved_tokens,
                jev_calls, jev_cache_hits, jev_errors, jev_tokens, jev_questions, jev_ms, jev_pruned
         FROM agent_audit
         WHERE (?1 IS NULL OR created_at >= ?1)
           AND (?2 IS NULL OR agent_id = ?2)
         ORDER BY id DESC",
    )?;
    let rows = stmt.query_map(params![cutoff, agent_filter], |r| {
        let aid: String = r.get(0)?;
        let aname = if aid == "janitor" {
            "Vault upkeep".to_string()
        } else {
            agent_map
                .get(&aid)
                .map(|a| a.name.clone())
                .unwrap_or_else(|| "Removed agent".to_string())
        };
        Ok(super::AuditEntry {
            agent_id: aid,
            agent_name: Some(aname),
            tool: r.get(1)?,
            ok: r.get(2)?,
            duration_ms: r.get(3)?,
            created_at: r.get(4)?,
            input_tokens: r.get(5)?,
            output_tokens: r.get(6)?,
            saved_tokens: r.get(7)?,
            jev_calls: r.get(8)?,
            jev_cache_hits: r.get(9)?,
            jev_errors: r.get(10)?,
            jev_tokens: r.get(11)?,
            jev_questions: r.get(12)?,
            jev_ms: r.get(13)?,
            jev_pruned: r.get(14)?,
        })
    })?;

    let mut total_acc = Accum::default();
    let mut by_agent: HashMap<String, Accum> = HashMap::new();
    let mut by_tool: BTreeMap<String, Accum> = BTreeMap::new();
    let mut series = build_buckets(range, now);
    let mut hourly_series = build_buckets("24h", now);
    let mut bucket_idx: HashMap<String, usize> = series
        .iter()
        .enumerate()
        .map(|(i, b)| (b.key.clone(), i))
        .collect();
    let mut recent = Vec::new();

    for entry in rows {
        let e = entry?;
        total_acc.add(&e);
        by_agent.entry(e.agent_id.clone()).or_default().add(&e);
        by_tool.entry(e.tool.clone()).or_default().add(&e);

        if let Some(b) = hourly_series.iter_mut().find(|b| b.key == e.created_at.get(..13).unwrap_or_default()) {
            b.calls += 1;
            b.input_tokens += e.input_tokens.max(0);
            b.output_tokens += e.output_tokens.max(0);
            b.saved_tokens += e.saved_tokens.max(0);
            b.jev_tokens += e.jev_tokens.max(0);
        }

        let bkey = if range == "24h" {
            e.created_at.get(..13).unwrap_or_default()
        } else {
            e.created_at.get(..10).unwrap_or_default()
        };
        if let Some(&idx) = bucket_idx.get(bkey) {
            let b = &mut series[idx];
            b.calls += 1;
            b.input_tokens += e.input_tokens.max(0);
            b.output_tokens += e.output_tokens.max(0);
            b.saved_tokens += e.saved_tokens.max(0);
            b.jev_tokens += e.jev_tokens.max(0);
        } else if range == "all" && !bkey.is_empty() && series.len() < 30 {
            let idx = series.len();
            series.push(UsageBucket {
                key: bkey.to_string(),
                label: bkey.to_string(),
                calls: 1,
                input_tokens: e.input_tokens.max(0),
                output_tokens: e.output_tokens.max(0),
                saved_tokens: e.saved_tokens.max(0),
                jev_tokens: e.jev_tokens.max(0),
            });
            bucket_idx.insert(bkey.to_string(), idx);
        }

        if recent.len() < 60 {
            recent.push(e);
        }
    }

    let totals = UsageTotals {
        calls: total_acc.calls,
        errors: total_acc.errors,
        avg_duration_ms: total_acc.avg_ms(),
        input_tokens: total_acc.input_tokens,
        output_tokens: total_acc.output_tokens,
        total_tokens: total_acc.input_tokens + total_acc.output_tokens,
        saved_tokens: total_acc.saved_tokens,
        savings_pct: pct(total_acc.saved_tokens, total_acc.output_tokens),
        jev_calls: total_acc.jev_calls,
        jev_cache_hits: total_acc.jev_cache_hits,
        jev_errors: total_acc.jev_errors,
        jev_tokens: total_acc.jev_tokens,
        jev_questions: total_acc.jev_questions,
        jev_avg_ms: total_acc.jev_avg_ms(),
        jev_pruned: total_acc.jev_pruned,
    };

    let mut agents_out: Vec<AgentUsage> = Vec::new();
    for a in &agents_list {
        if agent_filter.is_some_and(|f| f != a.id) {
            continue;
        }
        let acc = by_agent.remove(&a.id).unwrap_or_default();
        let client = client_by_agent.get(&a.id).cloned();
        agents_out.push(AgentUsage {
            agent_id: a.id.clone(),
            agent_name: a.name.clone(),
            role: a.role.clone(),
            model: a.model.clone(),
            status: a.status.clone(),
            last_seen_at: a.last_seen_at.clone(),
            client_id: client.as_ref().map(|c| c.0.clone()),
            client_name: client.as_ref().map(|c| c.1.clone()),
            calls: acc.calls,
            errors: acc.errors,
            avg_duration_ms: acc.avg_ms(),
            input_tokens: acc.input_tokens,
            output_tokens: acc.output_tokens,
            total_tokens: acc.input_tokens + acc.output_tokens,
            saved_tokens: acc.saved_tokens,
            savings_pct: pct(acc.saved_tokens, acc.output_tokens),
            jev_calls: acc.jev_calls,
            jev_cache_hits: acc.jev_cache_hits,
            jev_tokens: acc.jev_tokens,
            jev_pruned: acc.jev_pruned,
            top_tools: acc.top_tools(),
        });
    }
    // Include any audit entries for removed agents or background "janitor" upkeep.
    for (aid, acc) in by_agent {
        let name = if aid == "janitor" {
            "Vault upkeep".to_string()
        } else {
            "Removed agent".to_string()
        };
        agents_out.push(AgentUsage {
            agent_id: aid,
            agent_name: name,
            role: String::new(),
            model: String::new(),
            status: "inactive".into(),
            last_seen_at: None,
            client_id: None,
            client_name: None,
            calls: acc.calls,
            errors: acc.errors,
            avg_duration_ms: acc.avg_ms(),
            input_tokens: acc.input_tokens,
            output_tokens: acc.output_tokens,
            total_tokens: acc.input_tokens + acc.output_tokens,
            saved_tokens: acc.saved_tokens,
            savings_pct: pct(acc.saved_tokens, acc.output_tokens),
            jev_calls: acc.jev_calls,
            jev_cache_hits: acc.jev_cache_hits,
            jev_tokens: acc.jev_tokens,
            jev_pruned: acc.jev_pruned,
            top_tools: acc.top_tools(),
        });
    }
    agents_out.sort_by(|a, b| {
        (b.total_tokens + b.saved_tokens)
            .cmp(&(a.total_tokens + a.saved_tokens))
            .then(b.calls.cmp(&a.calls))
            .then(a.agent_name.to_lowercase().cmp(&b.agent_name.to_lowercase()))
    });

    let mut tools_out: Vec<ToolUsage> = by_tool
        .into_iter()
        .map(|(tool, acc)| ToolUsage {
            tool,
            calls: acc.calls,
            errors: acc.errors,
            avg_duration_ms: acc.avg_ms(),
            input_tokens: acc.input_tokens,
            output_tokens: acc.output_tokens,
            total_tokens: acc.input_tokens + acc.output_tokens,
            saved_tokens: acc.saved_tokens,
            jev_calls: acc.jev_calls,
            jev_cache_hits: acc.jev_cache_hits,
            jev_tokens: acc.jev_tokens,
            jev_pruned: acc.jev_pruned,
        })
        .collect();
    tools_out.sort_by(|a, b| {
        (b.total_tokens + b.saved_tokens)
            .cmp(&(a.total_tokens + a.saved_tokens))
            .then(b.calls.cmp(&a.calls))
            .then(a.tool.cmp(&b.tool))
    });

    Ok(UsageReport {
        range: range.to_string(),
        totals,
        agents: agents_out,
        tools: tools_out,
        series,
        hourly_series,
        recent,
    })
}

/// Clears recorded usage history (for all agents, or a single agent when `agent_id` is given).
pub fn clear(conn: &Connection, agent_id: Option<&str>) -> AppResult<()> {
    match agent_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => {
            conn.execute("DELETE FROM agent_audit WHERE agent_id = ?1", [id])?;
        }
        None => {
            conn.execute("DELETE FROM agent_audit", [])?;
        }
    }
    Ok(())
}

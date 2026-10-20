//! Optional TypeSafe AI Jev ("System One") decision gatekeeper for agent memory and context packs.
//!
//! When the user supplies a Jev API key in Settings > Agents, Suivelle uses a single batched
//! `POST https://api.typesafe.ai/v1/systemone` call per memory/context operation to:
//! 1. Prune irrelevant memories and connected pages from `context_pack` and `whoami`, and tier
//!    medium-relevance memories down to title-only bullets to minimize agent token consumption.
//! 2. Semantically rerank `memory_recall` candidates and rescue memories that share no exact words
//!    with the search query.
//! 3. Catch semantic duplicates (`>= 0.90` skipped without writing) and contradictions at
//!    `memory_write` and `janitor_report` time.
//!
//! Everything here is strictly opt-in and fail-open: when disabled, unconfigured, offline, or slow
//! (>1.8s), callers silently fall back to Suivelle's local BM25 and word-overlap heuristics.

use super::clients::secret;
use super::memory::{excerpt, Memory};
use super::{set_setting, setting};
use crate::domain::new_id;
use crate::errors::{AppError, AppResult};
use reqwest::blocking::Client;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const DEFAULT_ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
pub const MODEL: &str = "jev-latest";

const SETTING_ENABLED: &str = "agents.jevEnabled";
const SETTING_KEY_HINT: &str = "agents.jevKeyHint";
const SETTING_KEY_ID: &str = "agents.jevKeyId";
const SETTING_KEY_FALLBACK: &str = "agents.jevApiKey";
const SETTING_ENDPOINT: &str = "agents.jevEndpoint";

const CONNECT_TIMEOUT: Duration = Duration::from_millis(1000);
const REQUEST_TIMEOUT: Duration = Duration::from_millis(1800);
const CACHE_TTL: Duration = Duration::from_secs(300);
const CACHE_MAX: usize = 128;

#[derive(Debug, Clone)]
pub struct Config {
    pub api_key: String,
    pub endpoint: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemOneRequest<'a> {
    pub model: &'a str,
    pub state: String,
    pub questions: BTreeMap<String, Question>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Question {
    Noul {
        instructions: String,
    },
    Score {
        instructions: String,
        criteria: Vec<String>,
    },
    Choice {
        instructions: String,
        criteria: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SystemOneResponse {
    #[serde(default)]
    pub answers: HashMap<String, Answer>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Answer {
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub noul: Option<f64>,
    #[serde(default)]
    pub choice: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub probabilities: HashMap<String, f64>,
    #[serde(default)]
    pub confidence: Option<f64>,
}

impl Answer {
    pub fn prob(&self, option: &str) -> f64 {
        self.probabilities.get(option).copied().unwrap_or(0.0)
    }
}

static CACHE: OnceLock<Mutex<HashMap<u64, (Instant, SystemOneResponse)>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<u64, (Instant, SystemOneResponse)>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(endpoint: &str, state: &str, questions: &BTreeMap<String, Question>) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    endpoint.hash(&mut hasher);
    state.hash(&mut hasher);
    if let Ok(q) = serde_json::to_string(questions) {
        q.hash(&mut hasher);
    }
    hasher.finish()
}

fn use_os_secret() -> bool {
    secret::available() && !cfg!(test)
}

/// Last 4 visible characters of an API key, for Settings > Agents.
fn key_hint(key: &str) -> String {
    let chars: Vec<char> = key.trim().chars().collect();
    let start = chars.len().saturating_sub(4);
    chars[start..].iter().collect()
}

/// Reads whether Jev is enabled in Settings.
pub fn is_enabled(conn: &Connection) -> bool {
    setting(conn, SETTING_ENABLED)
        .ok()
        .flatten()
        .as_deref()
        == Some("true")
}

/// Reads the saved 4-character key hint, if a key is configured.
pub fn hint(conn: &Connection) -> Option<String> {
    setting(conn, SETTING_KEY_HINT)
        .ok()
        .flatten()
        .filter(|h| !h.is_empty())
}

/// Reads the raw Jev API key from the OS credential store (or fallback setting).
pub fn read_key(conn: &Connection) -> Option<String> {
    if let Some(id) = setting(conn, SETTING_KEY_ID)
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
    {
        if let Some(k) = secret::read(&id).filter(|k| !k.trim().is_empty()) {
            return Some(k);
        }
    }
    setting(conn, SETTING_KEY_FALLBACK)
        .ok()
        .flatten()
        .filter(|k| !k.trim().is_empty())
}

/// Saves or clears the Jev API key. Passing an empty string removes the stored key.
pub fn save_key(conn: &Connection, raw_key: &str) -> AppResult<()> {
    let key = raw_key.trim();
    if key.is_empty() {
        return clear_key(conn);
    }
    if key.chars().count() > 256 || key.chars().any(char::is_control) {
        return Err(AppError::Validation(
            "Enter a valid Jev API key (up to 256 characters).".into(),
        ));
    }
    let h = key_hint(key);
    if use_os_secret() {
        let id = new_id();
        secret::store(&id, key)?;
        if let Some(old_id) = setting(conn, SETTING_KEY_ID)? {
            if !old_id.is_empty() && old_id != id {
                secret::delete(&old_id);
            }
        }
        set_setting(conn, SETTING_KEY_ID, &id)?;
        set_setting(conn, SETTING_KEY_FALLBACK, "")?;
    } else {
        set_setting(conn, SETTING_KEY_FALLBACK, key)?;
    }
    set_setting(conn, SETTING_KEY_HINT, &h)?;
    Ok(())
}

/// Removes the stored Jev API key from both the OS credential store and `app_setting`.
pub fn clear_key(conn: &Connection) -> AppResult<()> {
    if let Some(old_id) = setting(conn, SETTING_KEY_ID)? {
        if !old_id.is_empty() {
            secret::delete(&old_id);
        }
    }
    set_setting(conn, SETTING_KEY_ID, "")?;
    set_setting(conn, SETTING_KEY_FALLBACK, "")?;
    set_setting(conn, SETTING_KEY_HINT, "")?;
    Ok(())
}

/// Returns the active Jev configuration when Jev is enabled and a key is present.
pub fn active(conn: &Connection) -> Option<Config> {
    if !is_enabled(conn) {
        return None;
    }
    let api_key = read_key(conn)?;
    let endpoint = setting(conn, SETTING_ENDPOINT)
        .ok()
        .flatten()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
    Some(Config { api_key, endpoint })
}

#[cfg(test)]
pub fn set_test_endpoint(conn: &Connection, url: &str) {
    let _ = set_setting(conn, SETTING_ENDPOINT, url);
}

fn http_client() -> Option<Client> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent("Suivelle-Agent-Jev/1.0")
        .build()
        .ok()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevHealth {
    pub ok: bool,
    pub status: Option<u16>,
    pub latency_ms: u64,
    pub model: String,
    pub message: String,
}

/// Sends a live 1-question System One probe to verify the stored (or candidate) Jev API key and endpoint.
pub fn health_check(conn: &Connection, candidate_key: Option<&str>) -> AppResult<JevHealth> {
    let api_key = candidate_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| read_key(conn))
        .ok_or_else(|| AppError::Validation("Add a Jev API key first.".into()))?;
    if api_key.chars().count() > 256 || api_key.chars().any(char::is_control) {
        return Err(AppError::Validation(
            "Enter a valid Jev API key (up to 256 characters).".into(),
        ));
    }
    let endpoint = setting(conn, SETTING_ENDPOINT)
        .ok()
        .flatten()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());

    let mut questions = BTreeMap::new();
    questions.insert(
        "probe".to_string(),
        Question::Noul {
            instructions: "Return 1 if this health check state is readable.".to_string(),
        },
    );
    let body = serde_json::to_vec(&SystemOneRequest {
        model: MODEL,
        state: "Suivelle Jev health check.".to_string(),
        questions,
    })
    .map_err(|e| AppError::Internal(e.to_string()))?;

    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = Client::builder()
        .connect_timeout(Duration::from_millis(2500))
        .timeout(Duration::from_millis(4000))
        .user_agent("Suivelle-Agent-Jev/1.0")
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let started = Instant::now();
    let resp = match client
        .post(&endpoint)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
    {
        Ok(resp) => resp,
        Err(err) => {
            let latency_ms = started.elapsed().as_millis() as u64;
            let reason = if err.is_timeout() {
                "timed out"
            } else if err.is_connect() {
                "could not connect"
            } else {
                "network error"
            };
            return Ok(JevHealth {
                ok: false,
                status: None,
                latency_ms,
                model: MODEL.to_string(),
                message: format!(
                    "Could not reach TypeSafe AI ({reason}). Suivelle will use local search."
                ),
            });
        }
    };

    let code = resp.status().as_u16();
    let latency_ms = started.elapsed().as_millis() as u64;
    if !resp.status().is_success() {
        let message = match code {
            401 | 403 => format!(
                "TypeSafe AI rejected this API key (HTTP {code}). Check or replace the key."
            ),
            429 => "TypeSafe AI rate limit reached (HTTP 429). Try again in a moment.".to_string(),
            _ => format!(
                "TypeSafe AI returned HTTP {code}. Suivelle will use local search until it recovers."
            ),
        };
        return Ok(JevHealth {
            ok: false,
            status: Some(code),
            latency_ms,
            model: MODEL.to_string(),
            message,
        });
    }

    let bytes = match resp.bytes() {
        Ok(b) => b,
        Err(_) => {
            return Ok(JevHealth {
                ok: false,
                status: Some(code),
                latency_ms,
                model: MODEL.to_string(),
                message: "Could not read response from TypeSafe AI.".to_string(),
            });
        }
    };
    if serde_json::from_slice::<SystemOneResponse>(&bytes).is_err() {
        return Ok(JevHealth {
            ok: false,
            status: Some(code),
            latency_ms,
            model: MODEL.to_string(),
            message: "TypeSafe AI returned an unexpected response format.".to_string(),
        });
    }

    Ok(JevHealth {
        ok: true,
        status: Some(code),
        latency_ms,
        model: MODEL.to_string(),
        message: format!("Healthy · connected to TypeSafe AI ({MODEL}) in {latency_ms} ms."),
    })
}

/// Evaluates `questions` against `state` in a single parallel System One pass.
/// Returns `None` on network error, timeout, or non-2xx status (fail-open).
pub fn evaluate(
    cfg: &Config,
    state: String,
    questions: BTreeMap<String, Question>,
) -> Option<SystemOneResponse> {
    if questions.is_empty() || state.trim().is_empty() {
        return None;
    }
    let q_count = questions.len();
    let key = cache_key(&cfg.endpoint, &state, &questions);
    if let Ok(mut guard) = cache().lock() {
        if let Some((at, cached)) = guard.get(&key) {
            if at.elapsed() < CACHE_TTL {
                super::analytics::record_jev_cache_hit(q_count);
                return Some(cached.clone());
            }
        }
        guard.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
    }

    let started = Instant::now();
    let req_tokens = super::analytics::estimate_tokens(&state)
        + serde_json::to_string(&questions)
            .map(|s| super::analytics::estimate_tokens(&s))
            .unwrap_or(0);
    let fail = |ms: u64| {
        super::analytics::record_jev_error(q_count, ms);
        None
    };
    let Some(client) = http_client() else {
        return fail(started.elapsed().as_millis() as u64);
    };
    let Ok(body) = serde_json::to_vec(&SystemOneRequest {
        model: MODEL,
        state,
        questions,
    }) else {
        return fail(started.elapsed().as_millis() as u64);
    };
    let Ok(resp) = client
        .post(&cfg.endpoint)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", cfg.api_key))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
    else {
        return fail(started.elapsed().as_millis() as u64);
    };
    if !resp.status().is_success() {
        tracing::debug!(status = %resp.status(), "jev api returned non-success");
        return fail(started.elapsed().as_millis() as u64);
    }
    let Ok(bytes) = resp.bytes() else {
        return fail(started.elapsed().as_millis() as u64);
    };
    let Ok(parsed) = serde_json::from_slice::<SystemOneResponse>(&bytes) else {
        return fail(started.elapsed().as_millis() as u64);
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;
    super::analytics::record_jev_call(req_tokens, q_count, elapsed_ms);
    if let Ok(mut guard) = cache().lock() {
        if guard.len() >= CACHE_MAX {
            guard.clear();
        }
        guard.insert(key, (Instant::now(), parsed.clone()));
    }
    Some(parsed)
}

// ---------------------------------------------------------------------------------------------
// Gate 1 & 2: Memory relevance ranking & adaptive body tiering
// ---------------------------------------------------------------------------------------------

/// Evaluates candidate memories against `query` in one batched Jev call, pruning irrelevant
/// candidates (`noul < 0.35`) and attaching `Memory::relevance` so callers can compress
/// medium-confidence memories (`0.35..0.75`) to shorter excerpts or title-only bullets.
///
/// Returns `true` if Jev ranked the list, or `false` if the caller should use the default sort.
pub fn rank_memories(
    conn: &Connection,
    cfg: &Config,
    query: &str,
    scope: Option<&str>,
    found: &mut Vec<(usize, u8, f64, Memory)>,
) -> bool {
    let query = query.trim();
    if query.is_empty() || found.is_empty() {
        return false;
    }
    // Pre-sort lexically so if there are more than 24 candidates we evaluate the strongest 24.
    found.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(a.1.cmp(&b.1))
            .then(a.2.total_cmp(&b.2))
            .then(b.3.created_at.cmp(&a.3.created_at))
    });
    found.truncate(24);

    let mut state = format!(
        "Task / Search Query: {query}\nTarget Scope: {}\n\nCandidate Memories:\n",
        scope.unwrap_or("(any)")
    );
    let mut questions = BTreeMap::new();
    for (idx, (_, _, _, m)) in found.iter().enumerate() {
        let preview = super::content::body_markdown(conn, &m.page_id).unwrap_or_default();
        let (short, _) = excerpt(preview.trim(), 200);
        let kind = m
            .values
            .get("Kind")
            .and_then(|v| v.as_str())
            .unwrap_or("Fact");
        let sc = m
            .values
            .get("Scope")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        state.push_str(&format!(
            "[m{idx}] Title: {} | Kind: {kind} | Scope: {sc}\n",
            m.title
        ));
        if !short.is_empty() {
            state.push_str(&format!("Excerpt: {}\n", short.replace('\n', " ")));
        }
        questions.insert(
            format!("m{idx}"),
            Question::Noul {
                instructions: format!(
                    "Is candidate memory [m{idx}] (\"{}\") directly relevant, helpful, or a required constraint for the Task / Search Query?",
                    m.title
                ),
            },
        );
    }

    let Some(resp) = evaluate(cfg, state, questions) else {
        return false;
    };

    let mut scored: Vec<(usize, u8, f64, f64, i64, Memory)> = Vec::with_capacity(found.len());
    for (idx, (words, fit, aged_rank, mut m)) in found.drain(..).enumerate() {
        let key = format!("m{idx}");
        let noul = resp
            .answers
            .get(&key)
            .and_then(|a| a.noul)
            .unwrap_or(0.5)
            .clamp(0.0, 1.0);
        m.relevance = Some(noul);
        let preview = super::content::body_markdown(conn, &m.page_id).unwrap_or_default();
        let (short, _) = excerpt(preview.trim(), 400);
        let est_tokens = super::analytics::estimate_tokens(&m.title)
            + super::analytics::estimate_tokens(short)
            + 12;
        scored.push((words, fit, aged_rank, noul, est_tokens, m));
    }

    let any_relevant = scored.iter().any(|(_, _, _, noul, _, _)| *noul >= 0.35);
    let mut pruned_tokens: i64 = 0;
    let mut pruned_count: i64 = 0;
    if any_relevant {
        scored.retain(|(words, _, _, noul, est_tokens, _)| {
            let keep = *noul >= 0.35 || (*words > 0 && *noul >= 0.25);
            if !keep {
                pruned_tokens += *est_tokens;
                pruned_count += 1;
            }
            keep
        });
    } else {
        // If Jev says none of the zero-word rescue candidates are relevant, drop zero-word ones.
        scored.retain(|(words, _, _, _, est_tokens, _)| {
            let keep = *words > 0;
            if !keep {
                pruned_tokens += *est_tokens;
                pruned_count += 1;
            }
            keep
        });
    }
    if pruned_count > 0 {
        super::analytics::record_saved(pruned_tokens, pruned_count);
    }

    // Sort by: high-confidence relevant first -> scope fit -> 5% Jev probability bucket ->
    // lexical word count -> aged BM25 -> newest.
    scored.sort_by(|a, b| {
        let tier_a = u8::from(a.3 >= 0.40);
        let tier_b = u8::from(b.3 >= 0.40);
        let bucket_a = (a.3 * 20.0).round() as i32;
        let bucket_b = (b.3 * 20.0).round() as i32;
        tier_b
            .cmp(&tier_a)
            .then(a.1.cmp(&b.1))
            .then(bucket_b.cmp(&bucket_a))
            .then(b.0.cmp(&a.0))
            .then(a.2.total_cmp(&b.2))
            .then(b.5.created_at.cmp(&a.5.created_at))
    });

    *found = scored
        .into_iter()
        .map(|(w, f, r, _, _, m)| (w, f, r, m))
        .collect();
    true
}

// ---------------------------------------------------------------------------------------------
// Gate 1b: Connected pages pruning in context_pack
// ---------------------------------------------------------------------------------------------

/// Prunes and reorders connected pages `(Link, first_line)` in `context_pack` using a single
/// Jev batch call when a topic/query is known. Returns the number of low-relevance links dropped.
pub fn filter_connected_pages(
    cfg: &Config,
    topic: &str,
    center_title: &str,
    items: &mut Vec<(super::context::Link, String)>,
) -> usize {
    let topic = topic.trim();
    if topic.is_empty() || items.len() <= 1 {
        return 0;
    }
    let eval_count = items.len().min(25);
    let mut state = format!("Task Topic: {topic}\nCurrent Page: {center_title}\n\nConnected Pages:\n");
    let mut questions = BTreeMap::new();
    for (idx, (link, line)) in items.iter().take(eval_count).enumerate() {
        state.push_str(&format!(
            "[p{idx}] ({}) {}: {}\n",
            link.via, link.title, line
        ));
        questions.insert(
            format!("p{idx}"),
            Question::Noul {
                instructions: format!(
                    "Is connected page [p{idx}] (\"{}\") likely needed to understand or complete the Task Topic?",
                    link.title
                ),
            },
        );
    }

    let Some(resp) = evaluate(cfg, state, questions) else {
        return 0;
    };

    let before = items.len();
    let tail = items.split_off(eval_count);
    let mut scored: Vec<(f64, super::context::Link, String)> = items
        .drain(..)
        .enumerate()
        .map(|(idx, (link, line))| {
            let noul = resp
                .answers
                .get(&format!("p{idx}"))
                .and_then(|a| a.noul)
                .unwrap_or(0.5)
                .clamp(0.0, 1.0);
            (noul, link, line)
        })
        .collect();

    let mut dropped_tokens: i64 = 0;
    let mut dropped_count: i64 = 0;
    if scored.iter().any(|(n, _, _)| *n >= 0.35) {
        scored.retain(|(n, link, line)| {
            let keep = *n >= 0.35;
            if !keep {
                let bullet = format!("- {} — **{}** (id {}): {}\n", link.via, link.title, link.page_id, line);
                dropped_tokens += super::analytics::estimate_tokens(&bullet);
                dropped_count += 1;
            }
            keep
        });
    }
    scored.sort_by(|a, b| {
        let high_a = u8::from(a.0 >= 0.65);
        let high_b = u8::from(b.0 >= 0.65);
        high_b.cmp(&high_a).then(b.0.total_cmp(&a.0))
    });

    let kept = scored.len();
    *items = scored.into_iter().map(|(_, l, s)| (l, s)).collect();
    if kept == before {
        items.extend(tail);
        0
    } else {
        for (link, line) in &tail {
            let bullet = format!("- {} — **{}** (id {}): {}\n", link.via, link.title, link.page_id, line);
            dropped_tokens += super::analytics::estimate_tokens(&bullet);
            dropped_count += 1;
        }
        if dropped_count > 0 {
            super::analytics::record_saved(dropped_tokens, dropped_count);
        }
        before + tail.len() - kept
    }
}

// ---------------------------------------------------------------------------------------------
// Gate 3: Write-time semantic deduplication & contradiction gate
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum WriteDecision {
    /// New memory states the exact same claim with no new detail (`>= 0.90`); skip writing.
    ExactDuplicate { page_id: String, title: String },
    /// New memory contradicts or updates an active memory in the same scope.
    Contradicts { page_id: String, title: String },
    /// New memory is semantically very close (`0.65..0.90`) to an active memory.
    Similar { page_id: String, title: String },
}

/// Checks a new memory against active memories in the same scope in one batched Jev call.
pub fn check_write(
    cfg: &Config,
    title: &str,
    body: &str,
    candidates: &[Memory],
) -> Option<WriteDecision> {
    if candidates.is_empty() {
        return None;
    }
    let mut state = format!(
        "New Memory to Record:\nTitle: {}\nBody: {}\n\nExisting Active Memories in Scope:\n",
        title.trim(),
        body.trim()
    );
    let mut questions = BTreeMap::new();
    let mut criteria = BTreeMap::new();
    criteria.insert(
        "exact_duplicate".into(),
        "States the exact same underlying fact, rule, or decision with no meaningful new detail"
            .into(),
    );
    criteria.insert(
        "updates_or_contradicts".into(),
        "Reverses, conflicts with, or updates the fact, rule, or decision in the existing memory"
            .into(),
    );
    criteria.insert(
        "distinct".into(),
        "Covers a different topic, or adds compatible distinct facts that should coexist".into(),
    );

    for (idx, m) in candidates.iter().take(10).enumerate() {
        let (short, _) = excerpt(m.body.trim(), 280);
        state.push_str(&format!("[e{idx}] Title: {}\n", m.title));
        if !short.is_empty() {
            state.push_str(&format!("Body: {}\n", short.replace('\n', " ")));
        }
        questions.insert(
            format!("c{idx}"),
            Question::Choice {
                instructions: format!(
                    "How does the New Memory relate to existing memory [e{idx}] (\"{}\")?",
                    m.title
                ),
                criteria: criteria.clone(),
            },
        );
    }

    let resp = evaluate(cfg, state, questions)?;
    let mut best_contradiction: Option<(f64, &Memory)> = None;
    let mut best_similar: Option<(f64, &Memory)> = None;

    for (idx, m) in candidates.iter().take(10).enumerate() {
        let Some(ans) = resp.answers.get(&format!("c{idx}")) else {
            continue;
        };
        let dup_p = ans.prob("exact_duplicate");
        let con_p = ans.prob("updates_or_contradicts");
        let chosen = ans.choice.as_deref().unwrap_or_default();

        if chosen == "exact_duplicate" && dup_p >= 0.90 {
            return Some(WriteDecision::ExactDuplicate {
                page_id: m.page_id.clone(),
                title: m.title.clone(),
            });
        }
        if (chosen == "updates_or_contradicts" && con_p >= 0.70) || con_p >= 0.75 {
            if best_contradiction.is_none_or(|(p, _)| con_p > p) {
                best_contradiction = Some((con_p, m));
            }
        } else if (chosen == "exact_duplicate" && dup_p >= 0.65) || dup_p >= 0.70 {
            if best_similar.is_none_or(|(p, _)| dup_p > p) {
                best_similar = Some((dup_p, m));
            }
        }
    }

    if let Some((_, m)) = best_contradiction {
        return Some(WriteDecision::Contradicts {
            page_id: m.page_id.clone(),
            title: m.title.clone(),
        });
    }
    if let Some((_, m)) = best_similar {
        return Some(WriteDecision::Similar {
            page_id: m.page_id.clone(),
            title: m.title.clone(),
        });
    }
    None
}

// ---------------------------------------------------------------------------------------------
// Gate 4: Vault health (`janitor_report` -> `memory_duplicates`)
// ---------------------------------------------------------------------------------------------

/// Evaluates pairs of active memories in one scope `(page_id, title, norm_title)` that did not
/// trigger the lexical overlap check, returning `(newer_idx, older_idx, is_contradiction)`.
pub fn find_scope_duplicates(
    conn: &Connection,
    cfg: &Config,
    scope: &str,
    items: &[(String, String, String)],
    already_flagged: &std::collections::HashSet<String>,
) -> Vec<(usize, usize, bool)> {
    if items.len() < 2 || items.len() > 20 {
        return Vec::new();
    }
    let mut state = format!(
        "Scope: {}\nActive Memories in Scope:\n",
        if scope.is_empty() { "(unscoped)" } else { scope }
    );
    for (idx, (page_id, title, _)) in items.iter().enumerate() {
        let body = super::content::body_markdown(conn, page_id).unwrap_or_default();
        let (short, _) = excerpt(body.trim(), 160);
        state.push_str(&format!(
            "[m{idx}] Title: {title}{}\n",
            if short.is_empty() {
                String::new()
            } else {
                format!(" — {}", short.replace('\n', " "))
            }
        ));
    }

    let mut criteria = BTreeMap::new();
    criteria.insert(
        "same_claim".into(),
        "Both memories state the same claim, preference, or rule".into(),
    );
    criteria.insert(
        "contradicts".into(),
        "The two memories directly conflict with or contradict each other".into(),
    );
    criteria.insert(
        "distinct".into(),
        "They record different, compatible facts".into(),
    );

    let mut questions = BTreeMap::new();
    let mut pairs = Vec::new();
    'outer: for i in 0..items.len() {
        for j in (i + 1)..items.len() {
            if already_flagged.contains(&items[j].0) {
                continue;
            }
            let qkey = format!("p_{i}_{j}");
            questions.insert(
                qkey,
                Question::Choice {
                    instructions: format!(
                        "Compare [m{i}] (\"{}\") and [m{j}] (\"{}\").",
                        items[i].1, items[j].1
                    ),
                    criteria: criteria.clone(),
                },
            );
            pairs.push((i, j));
            if pairs.len() >= 20 {
                break 'outer;
            }
        }
    }
    if questions.is_empty() {
        return Vec::new();
    }

    let Some(resp) = evaluate(cfg, state, questions) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, j) in pairs {
        let Some(ans) = resp.answers.get(&format!("p_{i}_{j}")) else {
            continue;
        };
        let chosen = ans.choice.as_deref().unwrap_or_default();
        let same_p = ans.prob("same_claim");
        let con_p = ans.prob("contradicts");
        if (chosen == "same_claim" && same_p >= 0.80) || same_p >= 0.85 {
            out.push((i, j, false));
        } else if (chosen == "contradicts" && con_p >= 0.80) || con_p >= 0.85 {
            out.push((i, j, true));
        }
    }
    if !out.is_empty() {
        super::analytics::record_saved(0, out.len() as i64);
    }
    out
}

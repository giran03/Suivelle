//! Claude Code subagents (`.claude/agents/*.md`) brought in as Suivelle agents: the reverse of
//! the subagent export. The file's front matter gives the name, role and model; its body becomes
//! the agent's instructions page.

use crate::agents::content::{self, WriteMode};
use crate::agents::{self, AgentInput};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const MAX_FILE: u64 = 256 * 1024;
const MAX_FILES: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    pub path: String,
    pub name: String,
    pub description: String,
    pub model: String,
    /// Written by Suivelle's own export.
    pub from_suivelle: bool,
    /// An agent with this name already exists.
    pub exists: bool,
}

/// Front matter fields and the body after them.
pub fn parse(text: &str) -> (BTreeMap<String, String>, String) {
    let text = text.trim_start_matches('\u{feff}');
    let mut fields = BTreeMap::new();
    let mut lines = text.split_inclusive('\n');
    if lines.next().map(str::trim_end) != Some("---") {
        return (fields, text.to_string());
    }
    let mut consumed = text.find('\n').map_or(text.len(), |i| i + 1);
    let mut pending: Option<(String, bool, Vec<String>)> = None;
    let flush = |p: &mut Option<(String, bool, Vec<String>)>, fields: &mut BTreeMap<String, String>| {
        if let Some((k, literal, parts)) = p.take() {
            fields.insert(k, parts.join(if literal { "\n" } else { " " }).trim().to_string());
        }
    };
    for raw in lines {
        consumed += raw.len();
        let line = raw.trim_end_matches(['\r', '\n']);
        if line.trim_end() == "---" {
            flush(&mut pending, &mut fields);
            let body = text.get(consumed.min(text.len())..).unwrap_or("");
            return (fields, body.trim_start_matches(['\r', '\n']).to_string());
        }
        if let Some((_, _, parts)) = pending.as_mut() {
            if line.starts_with(' ') || line.starts_with('\t') || line.trim().is_empty() {
                parts.push(line.trim().to_string());
                continue;
            }
        }
        flush(&mut pending, &mut fields);
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim().to_string(), v.trim());
        match v {
            "|" | "|-" | "|+" => pending = Some((k, true, Vec::new())),
            ">" | ">-" | ">+" => pending = Some((k, false, Vec::new())),
            _ if v.starts_with('"') => {
                fields.insert(k, serde_json::from_str::<String>(v).unwrap_or_else(|_| v.trim_matches('"').to_string()));
            }
            _ if v.starts_with('\'') && v.ends_with('\'') && v.len() >= 2 => {
                fields.insert(k, v[1..v.len() - 1].replace("''", "'"));
            }
            _ => {
                fields.insert(k, v.to_string());
            }
        }
    }
    // No closing fence: not front matter after all.
    (BTreeMap::new(), text.to_string())
}

fn exists(conn: &Connection, name: &str) -> AppResult<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM agent WHERE name = ?1 COLLATE NOCASE", [name], |_| Ok(()))
        .optional()?
        .is_some())
}

/// A subagent file Suivelle may read: a small `.md` directly inside a `.claude/agents` folder.
fn checked(path: &Path) -> AppResult<PathBuf> {
    let bad = || AppError::Validation(format!("{} is not a Claude Code subagent file.", path.display()));
    let dir = path.parent().ok_or_else(bad)?;
    let in_agents = dir.file_name().is_some_and(|n| n == "agents") && dir.parent().and_then(Path::file_name).is_some_and(|n| n == ".claude");
    let meta = std::fs::metadata(path).map_err(|_| bad())?;
    if !in_agents || !meta.is_file() || path.extension().is_none_or(|e| e != "md") || meta.len() > MAX_FILE {
        return Err(bad());
    }
    Ok(path.to_path_buf())
}

fn describe(conn: &Connection, path: &Path) -> AppResult<Subagent> {
    let text = std::fs::read_to_string(path)?;
    let (fm, _) = parse(&text);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name = fm.get("name").filter(|n| !n.trim().is_empty()).cloned().unwrap_or(stem);
    Ok(Subagent {
        path: path.display().to_string(),
        exists: exists(conn, name.trim())?,
        name: name.trim().to_string(),
        description: fm.get("description").cloned().unwrap_or_default(),
        model: fm.get("model").cloned().unwrap_or_default(),
        from_suivelle: text.contains("<!-- suivelle:fingerprint "),
    })
}

/// The subagents in `<dir>/.claude/agents` (or `dir` itself when it is that folder).
pub fn scan(conn: &Connection, dir: &Path) -> AppResult<Vec<Subagent>> {
    let folder = if dir.file_name().is_some_and(|n| n == "agents") { dir.to_path_buf() } else { dir.join(".claude").join("agents") };
    let Ok(read) = std::fs::read_dir(&folder) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for e in read.flatten().take(MAX_FILES) {
        if let Ok(p) = checked(&e.path()) {
            if let Ok(s) = describe(conn, &p) {
                out.push(s);
            }
        }
    }
    out.sort_by_key(|s| s.name.to_lowercase());
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub path: String,
    pub name: String,
    pub agent_id: Option<String>,
    pub error: Option<String>,
}

fn clip(s: &str, max: usize) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

fn import_one(conn: &mut Connection, path: &Path, workspace_ids: &[String], mode: Option<String>) -> AppResult<(String, String)> {
    let path = checked(path)?;
    let text = std::fs::read_to_string(&path)?;
    let info = describe(conn, &path)?;
    if info.exists {
        return Err(AppError::Validation(format!("An agent named {} already exists.", info.name)));
    }
    let (_, body) = parse(&text);
    let mut body: String = body.lines().filter(|l| !l.starts_with("<!-- suivelle:fingerprint ")).collect::<Vec<_>>().join("\n");
    if info.from_suivelle {
        if let Some(at) = body.find("## Working in Suivelle") {
            body.truncate(at);
        }
    }
    let agent = agents::create(
        conn,
        AgentInput {
            name: clip(&info.name, 80),
            role: clip(&info.description, 300),
            mode,
            workspace_ids: workspace_ids.to_vec(),
            model: clip(&info.model, 120),
            ..Default::default()
        },
    )?;
    if let (Some(page_id), false) = (agent.instructions_page_id.as_deref(), body.trim().is_empty()) {
        let tx = conn.transaction()?;
        if let Some(page) = repo::page::get(&tx, page_id)? {
            content::write_markdown(&tx, &page, body.trim(), WriteMode::Replace)?;
        }
        tx.commit()?;
    }
    Ok((agent.id, agent.name))
}

/// Creates one agent per file. Files that fail are reported, not fatal.
pub fn import(conn: &mut Connection, paths: &[String], workspace_ids: &[String], mode: Option<String>) -> AppResult<Vec<Imported>> {
    if workspace_ids.is_empty() {
        return Err(AppError::Validation("Choose a workspace for their instructions.".into()));
    }
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err(AppError::Validation("Choose between 1 and 200 subagents.".into()));
    }
    let mut out = Vec::new();
    for p in paths {
        let path = PathBuf::from(p);
        let fallback = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        match import_one(conn, &path, workspace_ids, mode.clone()) {
            Ok((id, name)) => out.push(Imported { path: p.clone(), name, agent_id: Some(id), error: None }),
            Err(e) => out.push(Imported { path: p.clone(), name: fallback, agent_id: None, error: Some(e.to_string()) }),
        }
    }
    Ok(out)
}

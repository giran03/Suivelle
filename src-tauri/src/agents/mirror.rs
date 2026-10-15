//! The plain-text mirror: a folder of Markdown files kept in step with one workspace, so any
//! tool that reads files (grep, git, editors, agents) sees the workspace as plain text.
//!
//! The database stays the source of truth. Each page is written as `<title>.md` (subpages in a
//! folder of the same name) with front matter holding its id. Output is deterministic, and a
//! file is rewritten only when its content changes. Edits made to the files are read back: by
//! default each becomes a proposal in the Review inbox ("apply" applies them directly). When a
//! page changed in the app and its file changed too, the file's version is kept as a proposal
//! and a `.conflict.md` copy, and the file is rewritten from the app. Files the mirror did not
//! write are only ever imported, never deleted.

use super::content::{self, norm, resolve_title};
use super::ops::{apply_as, submit_from_mirror, Actor, Op};
use crate::database::Db;
use crate::domain::{now, validate_id};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use crate::search::text::INTERNAL_PAGE_LINK;
use crate::transfer::export::safe_name;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{Emitter, Manager};

const MARKER: &str = ".suivelle-mirror.json";
const MAX_RENDERS_PER_PASS: usize = 300;
const MAX_INBOUND_PER_PASS: usize = 100;
const MAX_FOREIGN_FILES: usize = 50;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MirrorConfig {
    pub enabled: bool,
    pub path: String,
    #[serde(default)]
    pub last_sync: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub files: i64,
}

fn key(ws: &str) -> String {
    format!("mirror.{ws}")
}

pub fn config(conn: &Connection, ws: &str) -> AppResult<MirrorConfig> {
    Ok(super::setting(conn, &key(ws))?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

fn save(conn: &Connection, ws: &str, c: &MirrorConfig) -> AppResult<()> {
    super::set_setting(conn, &key(ws), &serde_json::to_string(c).unwrap_or_default())
}

/// Turns the mirror on (into `path`) or off for a workspace. The folder must be empty, or one
/// this workspace mirrored before.
pub fn configure(conn: &Connection, ws: &str, enabled: bool, path: Option<String>) -> AppResult<MirrorConfig> {
    validate_id(ws, "workspace")?;
    if repo::workspace::get(conn, ws)?.is_none() {
        return Err(AppError::NotFound("workspace".into()));
    }
    let mut c = config(conn, ws)?;
    if let Some(p) = path {
        let dir = PathBuf::from(p.trim());
        if !dir.is_absolute() {
            return Err(AppError::Validation("Choose a folder.".into()));
        }
        std::fs::create_dir_all(&dir)?;
        let marker = dir.join(MARKER);
        let ours = std::fs::read_to_string(&marker)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .is_some_and(|v| v["workspaceId"] == ws);
        if !ours {
            let mut entries = std::fs::read_dir(&dir)?.filter_map(Result::ok).filter(|e| !e.file_name().to_string_lossy().starts_with('.'));
            if entries.next().is_some() {
                return Err(AppError::Validation(
                    "Choose an empty folder (or one this workspace mirrored before). To bring existing notes in, use Import.".into(),
                ));
            }
            let info = serde_json::json!({ "workspaceId": ws, "createdAt": now(), "note": "Suivelle keeps this folder in step with a workspace. The database is the source of truth; edits here come back as proposals." });
            std::fs::write(&marker, serde_json::to_string_pretty(&info).unwrap_or_default())?;
        }
        if c.path != dir.to_string_lossy() {
            conn.execute("DELETE FROM mirror_file WHERE workspace_id = ?1", [ws])?;
        }
        c.path = dir.to_string_lossy().into_owned();
    }
    if enabled && c.path.is_empty() {
        return Err(AppError::Validation("Choose a folder for the mirror first.".into()));
    }
    c.enabled = enabled;
    c.last_error = None;
    save(conn, ws, &c)?;
    Ok(c)
}

// ---------------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------------

struct Node {
    id: String,
    parent: Option<String>,
    title: String,
    updated: String,
}

fn live_pages(conn: &Connection, ws: &str) -> AppResult<Vec<Node>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_page_id, title, updated_at FROM page
         WHERE workspace_id = ?1 AND deleted_at IS NULL ORDER BY created_at, id",
    )?;
    let rows = stmt.query_map([ws], |r| {
        Ok(Node {
            id: r.get(0)?,
            parent: r.get(1)?,
            title: r.get(2)?,
            updated: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Each page's file, relative to the mirror root, with "/" separators. Siblings that would share
/// a name are numbered in creation order.
fn layout(pages: &[Node]) -> HashMap<String, String> {
    let ids: HashSet<&str> = pages.iter().map(|p| p.id.as_str()).collect();
    let mut children: HashMap<Option<&str>, Vec<&Node>> = HashMap::new();
    for p in pages {
        let parent = p.parent.as_deref().filter(|x| ids.contains(x));
        children.entry(parent).or_default().push(p);
    }
    let mut out = HashMap::new();
    let mut stack: Vec<(Option<&str>, String, usize)> = vec![(None, String::new(), 0)];
    while let Some((parent, dir, depth)) = stack.pop() {
        if depth > 40 {
            continue;
        }
        let mut used: HashSet<String> = HashSet::new();
        for c in children.get(&parent).map(Vec::as_slice).unwrap_or_default() {
            let base = safe_name(&c.title);
            let mut name = base.clone();
            let mut n = 2;
            while !used.insert(name.to_lowercase()) || name.to_lowercase().ends_with(".conflict") {
                name = format!("{base} ({n})");
                n += 1;
            }
            let file = format!("{dir}{name}.md");
            out.insert(c.id.clone(), file);
            stack.push((Some(c.id.as_str()), format!("{dir}{name}/"), depth + 1));
        }
    }
    out
}

/// `[Title](suivelle://page/<id>)` as `[[Title]]` when that title leads back to the page.
fn wikilinks(conn: &Connection, ws: &str, md: &str) -> String {
    let needle = format!("]({INTERNAL_PAGE_LINK}");
    let mut out = String::with_capacity(md.len());
    let mut rest = md;
    while let Some(i) = rest.find(&needle) {
        let after = &rest[i + needle.len()..];
        let open = rest[..i].rfind('[').filter(|o| !rest[*o..i].contains('\n') && !rest[*o..i].contains(']'));
        let close = after.find(')');
        match (open, close) {
            (Some(o), Some(c)) if c == 36 => {
                let text = &rest[o + 1..i];
                let id = &after[..c];
                let title = repo::page::get(conn, id).ok().flatten().filter(|p| p.workspace_id == ws && p.deleted_at.is_none()).map(|p| p.title);
                let unique = title.as_ref().is_some_and(|t| resolve_title(conn, ws, t).ok().flatten().as_deref() == Some(id));
                match title {
                    Some(t) if unique && !t.contains('|') && !t.contains(']') => {
                        out.push_str(&rest[..o]);
                        if norm(text) == norm(&t) {
                            out.push_str(&format!("[[{t}]]"));
                        } else {
                            out.push_str(&format!("[[{t}|{text}]]"));
                        }
                    }
                    _ => out.push_str(&rest[..i + needle.len() + c + 1]),
                }
                rest = &after[c + 1..];
            }
            _ => {
                out.push_str(&rest[..i + needle.len()]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn tags_of(conn: &Connection, page_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT tag FROM block_tag WHERE page_id = ?1 ORDER BY tag")?;
    let rows = stmt.query_map([page_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn json(v: impl Serialize) -> String {
    serde_json::to_string(&v).unwrap_or_default()
}

/// The page's body as the mirror writes it (Markdown with wikilinks).
fn body(conn: &Connection, ws: &str, page_id: &str) -> AppResult<String> {
    Ok(wikilinks(conn, ws, &content::body_markdown(conn, page_id)?))
}

/// The record's values by property name, when the page is a record.
fn properties(conn: &Connection, page_id: &str) -> AppResult<Option<Map<String, Value>>> {
    let rec: Option<(String, String)> = conn
        .query_row("SELECT id, database_id FROM db_record WHERE page_id = ?1", [page_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let Some((rid, dbid)) = rec else { return Ok(None) };
    let props = crate::databases::service::load_properties(conn, &dbid)?;
    let row = crate::databases::service::load_rows(conn, &[rid])?.into_iter().next();
    Ok(row.map(|r| super::hub::readable(conn, &props, &r.values)))
}

/// The full file for a page.
pub fn render(conn: &Connection, ws: &str, page_id: &str) -> AppResult<String> {
    let page = repo::page::get(conn, page_id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
    let mut fm = format!("---\nsuivelle: 1\nid: {}\ntitle: {}\nkind: {}\n", page.id, json(&page.title), page.kind);
    let by: Option<String> = conn
        .query_row("SELECT a.name FROM page p JOIN agent a ON a.id = p.created_by WHERE p.id = ?1", [page_id], |r| r.get(0))
        .optional()?;
    if let Some(a) = by {
        fm.push_str(&format!("created_by: {}\n", json(a)));
    }
    let aliases = content::aliases(conn, page_id)?;
    if !aliases.is_empty() {
        fm.push_str(&format!("aliases: {}\n", json(aliases)));
    }
    let tags = tags_of(conn, page_id)?;
    if !tags.is_empty() {
        fm.push_str(&format!("tags: {}\n", json(tags)));
    }
    if let Some(p) = properties(conn, page_id)? {
        fm.push_str(&format!("properties: {}\n", json(p)));
    }
    fm.push_str("---\n\n");
    let b = if page.kind == "database" {
        // A database's page holds its table: list its records as links.
        let mut stmt = conn.prepare(
            "SELECT p.title FROM db_record r JOIN db_database d ON d.id = r.database_id JOIN page p ON p.id = r.page_id
             WHERE d.page_id = ?1 AND p.deleted_at IS NULL ORDER BY r.unique_id LIMIT 2000",
        )?;
        let titles: Vec<String> = stmt.query_map([page_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        titles.iter().map(|t| format!("- [[{}]]", t.replace(['[', ']', '|'], ""))).collect::<Vec<_>>().join("\n")
    } else {
        body(conn, ws, page_id)?
    };
    Ok(format!("{fm}{}\n", b.trim_end()))
}

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

fn stat(path: &Path) -> Option<(i64, i64)> {
    let m = std::fs::metadata(path).ok()?;
    let ms = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
    Some((m.len() as i64, ms))
}

struct Known {
    path: String,
    hash: String,
    size: i64,
    modified: i64,
    page_updated: String,
}

fn known(conn: &Connection, ws: &str) -> AppResult<HashMap<String, Known>> {
    let mut stmt = conn.prepare("SELECT page_id, path, hash, size, modified_ms, page_updated FROM mirror_file WHERE workspace_id = ?1")?;
    let rows = stmt.query_map([ws], |r| {
        Ok((
            r.get::<_, String>(0)?,
            Known {
                path: r.get(1)?,
                hash: r.get(2)?,
                size: r.get(3)?,
                modified: r.get(4)?,
                page_updated: r.get(5)?,
            },
        ))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn record(conn: &Connection, ws: &str, page_id: &str, rel: &str, file: &Path, h: &str, page_updated: &str) -> AppResult<()> {
    let (size, modified) = stat(file).unwrap_or((0, 0));
    conn.execute(
        "INSERT INTO mirror_file (workspace_id, page_id, path, hash, size, modified_ms, page_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(workspace_id, page_id) DO UPDATE SET path = excluded.path, hash = excluded.hash, size = excluded.size, modified_ms = excluded.modified_ms, page_updated = excluded.page_updated",
        params![ws, page_id, rel, h, size, modified, page_updated],
    )?;
    Ok(())
}

fn full(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part))
}

/// Removes a file the mirror wrote, unless someone changed it since, and then empty folders.
fn remove_ours(root: &Path, rel: &str, expected: &str) {
    let path = full(root, rel);
    if std::fs::read(&path).is_ok_and(|b| hash(&b) == expected) {
        let _ = std::fs::remove_file(&path);
        let mut dir = path.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            if d == root || std::fs::remove_dir(&d).is_err() {
                break;
            }
            dir = d.parent().map(Path::to_path_buf);
        }
    }
}

/// Writes changed pages to the folder. With `everything`, re-renders all pages (picking up
/// renamed link targets); otherwise only pages changed since they were last written.
pub fn sync_out(conn: &Connection, ws: &str, root: &Path, everything: bool) -> AppResult<usize> {
    let pages = live_pages(conn, ws)?;
    let paths = layout(&pages);
    let mut had = known(conn, ws)?;
    let mut written = 0;
    let mut renders = 0;
    for p in &pages {
        let Some(rel) = paths.get(&p.id) else { continue };
        let prev = had.remove(&p.id);
        let moved = prev.as_ref().is_some_and(|k| &k.path != rel);
        let stale = prev.as_ref().is_none_or(|k| k.page_updated != p.updated);
        if !(everything || moved || stale) {
            continue;
        }
        if renders >= MAX_RENDERS_PER_PASS {
            // The rest go out on the next pass; keep their old rows meanwhile.
            if let Some(k) = prev {
                had.insert(p.id.clone(), k);
            }
            continue;
        }
        renders += 1;
        let text = render(conn, ws, &p.id)?;
        let h = hash(text.as_bytes());
        let file = full(root, rel);
        if prev.as_ref().is_some_and(|k| k.hash == h && !moved) && file.exists() {
            record(conn, ws, &p.id, rel, &file, &h, &p.updated)?;
            continue;
        }
        if let Some(k) = &prev {
            if moved {
                remove_ours(root, &k.path, &k.hash);
            }
        }
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&file, text.as_bytes())?;
        record(conn, ws, &p.id, rel, &file, &h, &p.updated)?;
        written += 1;
    }
    // Pages that are gone or trashed: their files go too (only if unchanged since written).
    let live: HashSet<&str> = pages.iter().map(|p| p.id.as_str()).collect();
    for (page_id, k) in had {
        if live.contains(page_id.as_str()) {
            continue;
        }
        remove_ours(root, &k.path, &k.hash);
        conn.execute("DELETE FROM mirror_file WHERE workspace_id = ?1 AND page_id = ?2", params![ws, page_id])?;
    }
    Ok(written)
}

// ---------------------------------------------------------------------------------------------
// reading edits back
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct FileDoc {
    pub front: Map<String, Value>,
    pub body: String,
}

/// Splits front matter (`key: value` lines; JSON values where they parse) from the body.
pub fn parse_file(text: &str) -> FileDoc {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut doc = FileDoc::default();
    let rest = match text.strip_prefix("---\n") {
        Some(r) => r,
        None => {
            doc.body = text;
            return doc;
        }
    };
    let Some(end) = rest.find("\n---").filter(|e| rest[e + 4..].starts_with('\n') || rest.len() == e + 4) else {
        doc.body = text.clone();
        return doc;
    };
    for line in rest[..end].lines() {
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim();
            let value = serde_json::from_str::<Value>(v).unwrap_or_else(|_| Value::String(v.trim_matches(|c| c == '"' || c == '\'').to_string()));
            doc.front.insert(k.trim().to_string(), value);
        }
    }
    doc.body = rest[(end + 4).min(rest.len())..].trim_start_matches('\n').to_string();
    doc
}

fn stem(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).trim_end_matches(".md").to_string()
}

/// The changes a file asks for, compared with the page as it is.
fn diff(conn: &Connection, ws: &str, page_id: &str, rel: &str, doc: &FileDoc) -> AppResult<Vec<Op>> {
    let page = repo::page::get(conn, page_id)?.ok_or_else(|| AppError::NotFound("page".into()))?;
    let mut ops = Vec::new();
    let front_title = doc.front.get("title").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
    let file_stem = stem(rel);
    let new_title = if !front_title.is_empty() && front_title != page.title {
        Some(front_title)
    } else if file_stem != safe_name(&page.title) && !file_stem.ends_with(')') {
        Some(file_stem)
    } else {
        None
    };
    if let Some(t) = new_title {
        ops.push(Op::RenamePage { page_id: page_id.into(), title: t });
    }
    if let Some(a) = doc.front.get("aliases").and_then(Value::as_array) {
        let want: Vec<String> = a.iter().filter_map(|x| x.as_str().map(String::from)).collect();
        if want != content::aliases(conn, page_id)? {
            ops.push(Op::SetAliases { page_id: page_id.into(), aliases: want });
        }
    }
    if let (Some(Value::Object(want)), Some(have)) = (doc.front.get("properties"), properties(conn, page_id)?) {
        let changed: Map<String, Value> = want
            .iter()
            .filter(|(k, v)| have.get(*k) != Some(*v))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if !changed.is_empty() {
            ops.push(Op::SetValues { page_id: page_id.into(), values: changed });
        }
    }
    if page.kind != "database" && doc.body.trim_end() != body(conn, ws, page_id)?.trim_end() {
        ops.push(Op::UpdateContent {
            page_id: page_id.into(),
            markdown: doc.body.clone(),
            append: false,
            base_hash: None,
        });
    }
    Ok(ops)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.filter_map(Result::ok) {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || out.len() > 20_000 {
            continue;
        }
        let path = e.path();
        if path.is_dir() {
            walk(root, &path, out);
        } else if name.ends_with(".md") && !name.ends_with(".conflict.md") {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"));
            }
        }
    }
}

/// What reading the folder did.
#[derive(Debug, Default)]
pub struct Inbound {
    pub applied: usize,
    pub proposed: usize,
    pub page_ids: Vec<String>,
}

/// Reads edits made to the folder. `apply` applies them; otherwise each becomes a proposal.
pub fn sync_in(conn: &mut Connection, ws: &str, root: &Path, apply: bool, scan_new: bool) -> AppResult<Inbound> {
    let mut result = Inbound::default();
    let rows = known(conn, ws)?;
    let mut handled = 0;
    let actor = Actor::mirror(ws);
    let take = |conn: &mut Connection, title: String, why: String, ops: Vec<Op>, force_review: bool, result: &mut Inbound| -> AppResult<()> {
        if ops.is_empty() {
            return Ok(());
        }
        if apply && !force_review {
            let (_, fx) = apply_as(conn, &actor, &title, None, &ops)?;
            result.applied += 1;
            result.page_ids.extend(fx.page_ids);
        } else {
            submit_from_mirror(conn, ws, &title, &why, &ops)?;
            result.proposed += 1;
        }
        Ok(())
    };
    for (page_id, k) in &rows {
        if handled >= MAX_INBOUND_PER_PASS {
            break;
        }
        let file = full(root, &k.path);
        let Some((size, modified)) = stat(&file) else {
            // The file was deleted: propose trashing the page (if it is still live).
            if repo::page::get(conn, page_id)?.is_some_and(|p| p.deleted_at.is_none()) {
                handled += 1;
                take(conn, format!("Delete “{}” (its file was removed)", stem(&k.path)), format!("{} was deleted from the mirror folder.", k.path), vec![Op::TrashPage { page_id: page_id.clone() }], true, &mut result)?;
            }
            conn.execute("DELETE FROM mirror_file WHERE workspace_id = ?1 AND page_id = ?2", params![ws, page_id])?;
            continue;
        };
        if size == k.size && modified == k.modified {
            continue;
        }
        let bytes = std::fs::read(&file)?;
        let h = hash(&bytes);
        if h == k.hash {
            conn.execute("UPDATE mirror_file SET size = ?3, modified_ms = ?4 WHERE workspace_id = ?1 AND page_id = ?2", params![ws, page_id, size, modified])?;
            continue;
        }
        handled += 1;
        let doc = parse_file(&String::from_utf8_lossy(&bytes));
        let page = repo::page::get(conn, page_id)?.filter(|p| p.deleted_at.is_none());
        let Some(page) = page else { continue };
        let ops = diff(conn, ws, page_id, &k.path, &doc)?;
        let conflict = page.updated_at != k.page_updated;
        if conflict {
            // Both sides changed: keep the file's version aside and let the app's version win on disk.
            let copy = file.with_file_name(format!("{}.conflict.md", stem(&k.path)));
            let _ = std::fs::write(&copy, &bytes);
            take(conn, format!("Conflicting edit to “{}”", page.title), format!("{} changed in the folder while the page also changed in Suivelle. The folder's version is saved beside it as a .conflict.md file.", k.path), ops, true, &mut result)?;
            conn.execute("UPDATE mirror_file SET page_updated = '' WHERE workspace_id = ?1 AND page_id = ?2", params![ws, page_id])?;
        } else {
            take(conn, format!("Edit to “{}” in the mirror folder", page.title), format!("{} was edited outside Suivelle.", k.path), ops, false, &mut result)?;
            conn.execute(
                "UPDATE mirror_file SET hash = ?3, size = ?4, modified_ms = ?5 WHERE workspace_id = ?1 AND page_id = ?2",
                params![ws, page_id, h, size, modified],
            )?;
        }
    }
    if scan_new {
        let mut files = Vec::new();
        walk(root, root, &mut files);
        let tracked: HashSet<&str> = rows.values().map(|k| k.path.as_str()).collect();
        let new: Vec<String> = files.into_iter().filter(|f| !tracked.contains(f.as_str())).collect();
        if new.len() > MAX_FOREIGN_FILES {
            return Err(AppError::Validation(format!(
                "The mirror folder has {} Markdown files Suivelle did not write. Bring them in with Import instead.",
                new.len()
            )));
        }
        let pages = live_pages(conn, ws)?;
        let paths = layout(&pages);
        let folder_of: HashMap<String, String> = paths.iter().map(|(id, rel)| (rel.trim_end_matches(".md").to_string(), id.clone())).collect();
        for rel in new.into_iter().take(MAX_INBOUND_PER_PASS) {
            let file = full(root, &rel);
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            let doc = parse_file(&text);
            let known_id = doc.front.get("id").and_then(Value::as_str).filter(|id| {
                repo::page::get(conn, id).ok().flatten().is_some_and(|p| p.workspace_id == ws && p.deleted_at.is_none())
            });
            if let Some(id) = known_id {
                // A page's file was renamed or moved by hand: take its edits, and the app puts
                // the file back where it belongs.
                let ops = diff(conn, ws, id, &rel, &doc)?;
                take(conn, format!("Edit to “{}” in the mirror folder", stem(&rel)), format!("{rel} was renamed or moved outside Suivelle."), ops, false, &mut result)?;
                let _ = std::fs::remove_file(&file);
                conn.execute("UPDATE mirror_file SET page_updated = '' WHERE workspace_id = ?1 AND page_id = ?2", params![ws, id])?;
                continue;
            }
            let dir = rel.rsplit_once('/').map(|(d, _)| d.to_string());
            let parent = dir.as_ref().and_then(|d| folder_of.get(d)).cloned();
            let title = doc.front.get("title").and_then(Value::as_str).map(String::from).unwrap_or_else(|| stem(&rel));
            let op = Op::CreatePage {
                key: None,
                workspace_id: Some(ws.into()),
                parent,
                title: title.clone(),
                markdown: doc.body.clone(),
                aliases: doc.front.get("aliases").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
            };
            take(conn, format!("New page “{title}” from the mirror folder"), format!("{rel} was added to the mirror folder."), vec![op], false, &mut result)?;
            // The app writes the page under its own name once it exists; the new file is replaced.
            if apply {
                let _ = std::fs::remove_file(&file);
            } else {
                let _ = std::fs::rename(&file, file.with_extension("pending"));
            }
        }
    }
    Ok(result)
}

/// The mirror loop: every few seconds, writes changed pages out and reads edits back in.
pub fn spawn(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        let mut pass: u64 = 0;
        loop {
            pass += 1;
            if !crate::updates::preparing() && app.try_state::<crate::SafeMode>().is_some_and(|s| s.0.is_none()) {
                if let Some(db) = app.try_state::<Db>() {
                    run_once(&app, &db, pass);
                }
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

fn run_once(app: &tauri::AppHandle, db: &Db, pass: u64) {
    let workspaces: Vec<(String, MirrorConfig)> = match db.0.lock() {
        Ok(c) => repo::workspace::list(&c)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|w| config(&c, &w.id).ok().filter(|m| m.enabled).map(|m| (w.id, m)))
            .collect(),
        Err(_) => return,
    };
    for (ws, mut cfg) in workspaces {
        let root = PathBuf::from(&cfg.path);
        let Ok(mut conn) = db.0.lock() else { return };
        let apply = super::settings(&conn).map(|s| s.mirror_edits == "apply").unwrap_or(false);
        let inbound = if root.is_dir() {
            sync_in(&mut conn, &ws, &root, apply, pass % 3 == 1)
        } else {
            Err(AppError::Validation(format!("The mirror folder {} is missing.", cfg.path)))
        };
        let outbound = inbound.as_ref().map_err(|e| e.to_string()).and_then(|_| {
            // Every ten minutes, re-render everything so renamed link targets catch up.
            sync_out(&conn, &ws, &root, pass % 120 == 1).map_err(|e| e.to_string())
        });
        cfg.last_error = outbound.as_ref().err().cloned();
        if outbound.is_ok() {
            cfg.last_sync = Some(now());
            cfg.files = conn
                .query_row("SELECT COUNT(*) FROM mirror_file WHERE workspace_id = ?1", [&ws], |r| r.get(0))
                .unwrap_or(0);
        }
        let _ = save(&conn, &ws, &cfg);
        drop(conn);
        if let Ok(i) = inbound {
            if i.applied + i.proposed > 0 {
                let _ = app.emit(
                    "agent-activity",
                    serde_json::json!({ "agentName": "Mirror folder", "tool": "mirror", "pageIds": i.page_ids, "proposalStatus": if i.proposed > 0 { Some("pending") } else { None } }),
                );
            }
        }
    }
}

//! Exporting a page, a database or a page with everything below it, laid out the way Notion's own
//! export is: every name ends with the page's id, a page's subpages are in the folder of the same
//! name, a database is a CSV file (Markdown) or a table page (HTML) with a page per record, and
//! callouts, to-dos and toggles use Notion's markup. Notion's importer reads it, and so does
//! Suivelle's, which matches pages, rows and relations back up by those ids.
//!
//! An export of more than one file is a single zip; a single page is a single file. PDF is a
//! single page, printed from its HTML (see `commands::export_page`). The whole-workspace archive
//! lives in `archive`.

use super::blocks::*;
use super::csvio;
use super::html;
use super::markdown::{self, Ctx};
use super::notion::names;
use crate::databases::service::{self as dbs, load_rows};
use crate::databases::{Property, RecordQuery, RecordRow};
use crate::domain::Page;
use crate::errors::{AppError, AppResult};
use crate::files;
use crate::repositories as repo;
use crate::search::text::INTERNAL_PAGE_LINK;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

/// A name that is safe as a file or folder name on Windows, macOS and Linux.
pub fn safe_name(title: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    s = s.trim().trim_matches('.').trim().to_string();
    if s.is_empty() {
        s = "Untitled".into();
    }
    let upper = s.to_ascii_uppercase();
    let stem = upper.split('.').next().unwrap_or("");
    if matches!(stem, "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
    {
        s.insert(0, '_');
    }
    s.chars()
        .take(80)
        .collect::<String>()
        .trim_end()
        .to_string()
}

fn unique(used: &mut HashSet<String>, base: &str, ext: &str) -> String {
    let mut name = format!("{base}{ext}");
    let mut n = 2;
    while !used.insert(name.to_lowercase()) {
        name = format!("{base} {n}{ext}");
        n += 1;
    }
    name
}

/// What to export, as in Notion's export dialog.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    /// "markdown" (Markdown & CSV), "html" or "pdf" (a single page).
    pub format: String,
    #[serde(default = "yes")]
    pub include_subpages: bool,
    /// Subpages go in a folder named like their page; otherwise everything sits side by side.
    #[serde(default = "yes")]
    pub folders: bool,
    /// Files and images are exported; otherwise they are left out.
    #[serde(default = "yes")]
    pub files: bool,
    /// "all" rows of each database, or the rows its first view shows ("view").
    #[serde(default = "all_rows")]
    pub rows: String,
}

fn yes() -> bool {
    true
}

fn all_rows() -> String {
    "all".into()
}

impl ExportOptions {
    pub fn of(format: &str) -> ExportOptions {
        ExportOptions {
            format: format.into(),
            include_subpages: true,
            folders: true,
            files: true,
            rows: all_rows(),
        }
    }

    fn html(&self) -> bool {
        self.format != "markdown"
    }

    fn ext(&self) -> &'static str {
        if self.html() {
            ".html"
        } else {
            ".md"
        }
    }

    fn check(&self) -> AppResult<()> {
        if !matches!(self.format.as_str(), "markdown" | "html" | "pdf") {
            return bad("choose PDF, HTML or Markdown & CSV");
        }
        if !matches!(self.rows.as_str(), "all" | "view") {
            return bad("choose all rows or the rows of the database's view");
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Kind {
    Doc,
    Database,
    /// A record's page; its database's page id.
    Record(String),
}

struct Item {
    page: Page,
    kind: Kind,
    path: String,
}

/// Every file an export writes, and where each page is.
struct Plan {
    items: Vec<Item>,
    paths: HashMap<String, String>,
    notices: Vec<String>,
}

fn hex(id: &str) -> String {
    id.chars().filter(|c| *c != '-').collect()
}

/// A page's file name: its title and, as Notion does, its id.
fn file_name(page: &Page, ext: &str, used: &mut HashSet<String>, with_id: bool) -> String {
    let base = if with_id {
        format!("{} {}", safe_name(&page.title), hex(&page.id))
    } else {
        safe_name(&page.title)
    };
    unique(used, &base, ext)
}

/// The rows a database exports: all of them, or the ones its first view shows, in that order.
fn record_rows(conn: &Connection, database_id: &str, view: bool) -> AppResult<Vec<RecordRow>> {
    if view {
        let mut rows = Vec::new();
        let mut cursor = None;
        loop {
            let page = dbs::query_records(
                conn,
                &RecordQuery {
                    database_id: database_id.into(),
                    view_id: None,
                    group_key: None,
                    subgroup_key: None,
                    cursor,
                    limit: Some(500),
                    skip_total: true,
                    extra_filter: None,
                    range: None,
                },
            )?;
            rows.extend(page.rows);
            match page.next_cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }
        return Ok(rows);
    }
    let mut stmt = conn.prepare(
        "SELECT r.id FROM db_record r JOIN page p ON p.id = r.page_id WHERE r.database_id = ?1 AND p.deleted_at IS NULL ORDER BY r.unique_id",
    )?;
    let ids: Vec<String> = stmt
        .query_map([database_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    let mut rows = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(400) {
        rows.extend(load_rows(conn, chunk)?);
    }
    Ok(rows)
}

fn plan(
    conn: &Connection,
    root: &Page,
    opts: &ExportOptions,
    single: Option<&str>,
) -> AppResult<Plan> {
    let mut plan = Plan {
        items: vec![],
        paths: HashMap::new(),
        notices: vec![],
    };
    // A single file keeps the name it was saved as; a zip names everything as Notion does.
    let with_id = single.is_none();
    #[allow(clippy::too_many_arguments)]
    fn walk(
        conn: &Connection,
        page: &Page,
        dir: &str,
        used: &mut HashSet<String>,
        opts: &ExportOptions,
        plan: &mut Plan,
        with_id: bool,
        name: Option<&str>,
    ) -> AppResult<()> {
        let sub = |file: &str, ext: &str| -> String {
            if opts.folders {
                format!("{dir}{}/", file.trim_end_matches(ext))
            } else {
                dir.to_string()
            }
        };
        match page.kind.as_str() {
            "dashboard" => {
                plan.notices.push(format!(
                    "The dashboard “{}” is left out (dashboards are only in the workspace archive).",
                    page.title
                ));
            }
            "database" => {
                let ext = if opts.html() { ".html" } else { ".csv" };
                let file = match name {
                    Some(n) => n.to_string(),
                    None => file_name(page, ext, used, with_id),
                };
                let path = format!("{dir}{file}");
                plan.paths.insert(page.id.clone(), path.clone());
                plan.items.push(Item {
                    page: page.clone(),
                    kind: Kind::Database,
                    path,
                });
                if opts.include_subpages {
                    let detail = dbs::database_detail_by_page(conn, &page.id)?;
                    let next = sub(&file, ext);
                    let mut local = HashSet::new();
                    let used = if opts.folders { &mut local } else { &mut *used };
                    for row in record_rows(conn, &detail.database.id, opts.rows == "view")? {
                        let Some(rp) = repo::page::get(conn, &row.page_id)? else {
                            continue;
                        };
                        let file = file_name(&rp, opts.ext(), used, with_id);
                        let path = format!("{next}{file}");
                        plan.paths.insert(rp.id.clone(), path.clone());
                        plan.items.push(Item {
                            page: rp,
                            kind: Kind::Record(page.id.clone()),
                            path,
                        });
                    }
                }
            }
            "page" | "record" => {
                let file = match name {
                    Some(n) => n.to_string(),
                    None => file_name(page, opts.ext(), used, with_id),
                };
                let path = format!("{dir}{file}");
                plan.paths.insert(page.id.clone(), path.clone());
                let kind = match (&page.kind[..], &page.parent_page_id) {
                    ("record", Some(db)) => Kind::Record(db.clone()),
                    _ => Kind::Doc,
                };
                plan.items.push(Item {
                    page: page.clone(),
                    kind,
                    path,
                });
                if opts.include_subpages {
                    let kids: Vec<Page> =
                        repo::page::list_children(conn, &page.workspace_id, Some(&page.id))?
                            .into_iter()
                            .filter(|c| c.kind != "record")
                            .collect();
                    if !kids.is_empty() {
                        let next = sub(&file, opts.ext());
                        let mut local = HashSet::new();
                        let used = if opts.folders { &mut local } else { &mut *used };
                        for k in kids {
                            walk(conn, &k, &next, used, opts, plan, with_id, None)?;
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut used = HashSet::new();
    walk(conn, root, "", &mut used, opts, &mut plan, with_id, single)?;
    Ok(plan)
}

/// The path from the file at `from` to the file at `to`, both relative to the export's root.
fn relative(from: &str, to: &str) -> String {
    let from_dirs: Vec<&str> = from.split('/').collect();
    let from_dirs = &from_dirs[..from_dirs.len() - 1];
    let to_parts: Vec<&str> = to.split('/').collect();
    let common = from_dirs
        .iter()
        .zip(&to_parts[..to_parts.len() - 1])
        .take_while(|(a, b)| a == b)
        .count();
    let mut out = "../".repeat(from_dirs.len() - common);
    out.push_str(&to_parts[common..].join("/"));
    out
}

// ---------------------------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    /// "page", "record" or "database".
    pub kind: String,
    pub title: String,
    /// The export is more than one file, so it is saved as a zip.
    pub needs_folder: bool,
    /// The page has subpages (or, for a database, records).
    pub has_children: bool,
    /// A database is part of the export (the "Database views" choice applies).
    pub has_databases: bool,
    /// Files the export writes, not counting attachments.
    pub files: usize,
}

fn has_assets(conn: &Connection, page_id: &str) -> AppResult<bool> {
    let mut found = false;
    visit(
        &resolve_embeds(conn, tree_from_rows(&repo::block::list(conn, page_id)?), 0)?,
        &mut |b| {
            found |= b.media.as_ref().is_some_and(|m| m.attachment.is_some());
        },
    );
    Ok(found)
}

pub fn shape(conn: &Connection, page_id: &str, opts: &ExportOptions) -> AppResult<Shape> {
    crate::domain::validate_id(page_id, "page")?;
    opts.check()?;
    let page = live_page(conn, page_id)?;
    if page.kind == "dashboard" {
        return bad("dashboards cannot be exported on their own; use the workspace archive");
    }
    let mut all = opts.clone();
    all.include_subpages = true;
    let everything = plan(conn, &page, &all, None)?;
    let p = plan(conn, &page, opts, None)?;
    let mut assets = false;
    if opts.files {
        for item in &p.items {
            if item.kind != Kind::Database && has_assets(conn, &item.page.id)? {
                assets = true;
                break;
            }
        }
    }
    Ok(Shape {
        kind: page.kind.clone(),
        title: page.title,
        needs_folder: p.items.len() > 1 || assets,
        has_children: everything.items.len() > 1,
        has_databases: everything.items.iter().any(|i| i.kind == Kind::Database),
        files: p.items.len(),
    })
}

// ---------------------------------------------------------------------------------------------
// content
// ---------------------------------------------------------------------------------------------

/// Replaces blocks that only point at content elsewhere with that content, so an export is complete:
/// a synced block becomes the blocks it shows, and an embedded database becomes a line naming
/// (and, when it is exported too, linking to) it.
fn resolve_embeds(conn: &Connection, blocks: Vec<Blk>, depth: usize) -> AppResult<Vec<Blk>> {
    let mut out = Vec::with_capacity(blocks.len());
    for mut b in blocks {
        b.children = resolve_embeds(conn, std::mem::take(&mut b.children), depth + 1)?;
        let live = |id: &str| -> AppResult<Option<Page>> {
            Ok(repo::page::get(conn, id)?.filter(|p| p.deleted_at.is_none()))
        };
        match b.kind.as_str() {
            "synced_block" => {
                // Synced content cannot hold another synced block, so this is shallow; the cap is a backstop.
                if depth < 6 {
                    if let Some(page) = b.target.as_deref().map(live).transpose()?.flatten() {
                        let inner = tree_from_rows(&repo::block::list(conn, &page.id)?);
                        out.extend(resolve_embeds(conn, inner, depth + 1)?);
                    }
                }
            }
            "database_view" => {
                if let Some(page) = b.target.as_deref().map(live).transpose()?.flatten() {
                    let title = if page.title.is_empty() {
                        "Untitled".to_string()
                    } else {
                        page.title
                    };
                    out.push(Blk::with_inline(
                        "paragraph",
                        vec![Inline::Text {
                            text: format!("Database: {title}"),
                            marks: vec![Mark::Link(format!("{INTERNAL_PAGE_LINK}{}", page.id))],
                        }],
                    ));
                }
            }
            _ => out.push(b),
        }
    }
    Ok(out)
}

fn live_page(conn: &Connection, id: &str) -> AppResult<Page> {
    repo::page::get(conn, id)?
        .filter(|p| p.deleted_at.is_none())
        .ok_or_else(|| AppError::NotFound("page".into()))
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub files: usize,
    pub attachments: usize,
    pub skipped: Vec<String>,
}

fn asset_key(m: &Media) -> Option<String> {
    let hash = m.attachment.as_ref()?.get("hash")?.as_str()?;
    Some(if let Some(crop) = m.presentation.get("crop") {
        format!("{hash}-{}", crop)
    } else {
        hash.into()
    })
}
fn asset_name(m: &Media) -> Option<String> {
    let hash = m.attachment.as_ref()?.get("hash")?.as_str()?;
    if !files::is_hash(hash) {
        return None;
    }
    if let Some(c) = m.presentation.get("crop") {
        use sha2::{Digest, Sha256};
        let digest: String = Sha256::digest(c.to_string().as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Some(format!("{}-crop-{}.png", &hash[..8], &digest[..12]))
    } else {
        Some(format!("{}-{}", &hash[..8], safe_name(&m.name)))
    }
}

/// Readies a page's blocks for export: private notes go, image links to pages follow the export,
/// and without files the media blocks are left out.
fn prepare(
    blocks: &mut Vec<Blk>,
    link: &dyn Fn(&str) -> Option<String>,
    files: bool,
    notices: &mut Vec<String>,
) {
    if !files {
        fn strip(blocks: &mut Vec<Blk>, n: &mut usize) {
            let before = blocks.len();
            blocks.retain(|b| !is_media(&b.kind));
            *n += before - blocks.len();
            for b in blocks.iter_mut() {
                strip(&mut b.children, n);
            }
        }
        let mut n = 0;
        strip(blocks, &mut n);
        if n > 0 {
            notices.push("Files and images are left out of this export.".into());
        }
    }
    visit_mut(blocks, &mut |b| {
        if matches!(
            b.kind.as_str(),
            "columns" | "column" | "tabs" | "tab_panel" | "synced_block" | "database_view"
        ) {
            notices.push(format!(
                "{} content uses a portable fallback.",
                b.kind.replace('_', " ")
            ));
        }
        if let Some(m) = &mut b.media {
            if m.presentation
                .get("note")
                .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            {
                notices.push("Private image notes are omitted.".into());
            }
            if let Some(p) = m.presentation.as_object_mut() {
                p.remove("note");
            }
            if m.presentation.get("crop").is_some() {
                notices.push("Image crops are baked into separate PNG assets; originals are preserved in the workspace.".into());
            }
            if m.presentation["widthMode"] == "percent" {
                notices.push(
                    "Percentage image widths depend on the destination renderer's HTML support."
                        .into(),
                );
            }
            if let Some(id) = m
                .presentation
                .get("link")
                .and_then(Value::as_str)
                .and_then(crate::legacy::page_target)
                .map(String::from)
            {
                match link(&id) {
                    Some(path) => m.presentation["link"] = serde_json::json!(path),
                    None => {
                        if let Some(p) = m.presentation.as_object_mut() {
                            p.remove("link");
                        }
                        notices.push(
                            "An image link targets a page outside this export and was omitted."
                                .into(),
                        );
                    }
                }
            }
        }
    });
    notices.sort();
    notices.dedup();
}

// ---------------------------------------------------------------------------------------------
// database values, as Notion writes them
// ---------------------------------------------------------------------------------------------

fn number_text(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn dynamic_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => if *b { "Yes" } else { "No" }.to_string(),
        Value::Number(n) => n.as_f64().map(number_text).unwrap_or_default(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(dynamic_text).collect::<Vec<_>>().join(", "),
        Value::Object(o) => {
            if let Some(e) = o.get("error").and_then(Value::as_str) {
                return e.to_string();
            }
            names::notion_date_value(v)
        }
    }
}

fn option<'a>(p: &'a Property, id: &Value) -> Option<&'a Value> {
    p.config["options"]
        .as_array()
        .and_then(|a| a.iter().find(|o| &o["id"] == id))
}

fn option_name(p: &Property, id: &Value) -> String {
    option(p, id)
        .and_then(|o| o["name"].as_str())
        .unwrap_or("")
        .to_string()
}

/// The pages a relation cell links to: (title, page id).
fn related(v: Option<&Value>) -> Vec<(String, String)> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|l| {
                    (
                        l.get("title")
                            .and_then(Value::as_str)
                            .filter(|t| !t.is_empty())
                            .unwrap_or("Untitled")
                            .to_string(),
                        l.get("pageId")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A cell as plain text, the way Notion's CSV writes it. Related records name their exported
/// file when `link` knows it (`Title (Other%20Db/Title%20id.md)`). The bool says whether it is
/// text (and so must be guarded against spreadsheet formulas).
pub fn cell_text(
    p: &Property,
    row: &RecordRow,
    link: &dyn Fn(&str) -> Option<String>,
) -> (String, bool) {
    let v = row.values.get(&p.id);
    match p.property_type.as_str() {
        "title" => (row.title.clone(), true),
        "unique_id" => {
            let prefix = p.config.get("prefix").and_then(Value::as_str).unwrap_or("");
            (
                if prefix.is_empty() {
                    row.unique_id.to_string()
                } else {
                    format!("{prefix}-{}", row.unique_id)
                },
                false,
            )
        }
        "created_time" => (names::notion_date(&row.created_at), false),
        "updated_time" => (names::notion_date(&row.updated_at), false),
        "number" => (
            v.and_then(Value::as_f64)
                .map(number_text)
                .unwrap_or_default(),
            false,
        ),
        "checkbox" => (
            if v == Some(&Value::Bool(true)) {
                "Yes"
            } else {
                "No"
            }
            .into(),
            false,
        ),
        "date" => (v.map(names::notion_date_value).unwrap_or_default(), false),
        "select" | "status" => (v.map(|v| option_name(p, v)).unwrap_or_default(), true),
        "multi_select" => (
            v.and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|x| option_name(p, x))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default(),
            true,
        ),
        "relation" => (
            related(v)
                .iter()
                .map(|(title, page)| match link(page) {
                    Some(path) => format!("{title} ({})", path.replace(' ', "%20")),
                    None => title.clone(),
                })
                .collect::<Vec<_>>()
                .join(", "),
            true,
        ),
        "rollup" | "formula" => {
            let t = v.map(dynamic_text).unwrap_or_default();
            let is_text = !matches!(v, Some(Value::Number(_) | Value::Bool(_)));
            (t, is_text)
        }
        _ => (v.and_then(Value::as_str).unwrap_or("").to_string(), true),
    }
}

/// A cell as Notion's HTML export writes it.
fn cell_html(p: &Property, row: &RecordRow, link: &dyn Fn(&str) -> Option<String>) -> String {
    let v = row.values.get(&p.id);
    let pill = |o: Option<&Value>| -> String {
        let Some(o) = o else { return String::new() };
        format!(
            "<span class=\"selected-value select-value-color-{}\">{}</span>",
            names::notion_color(o["color"].as_str().unwrap_or("gray")),
            html::esc(o["name"].as_str().unwrap_or(""))
        )
    };
    match p.property_type.as_str() {
        "title" => html::link_html(&row.title, link(&row.page_id).as_deref()),
        "select" | "status" => v.map(|v| pill(option(p, v))).unwrap_or_default(),
        "multi_select" => v
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|x| pill(option(p, x))).collect())
            .unwrap_or_default(),
        "checkbox" => format!(
            "<div class=\"checkbox checkbox-{}\"></div>",
            if v == Some(&Value::Bool(true)) {
                "on"
            } else {
                "off"
            }
        ),
        "relation" => related(v)
            .iter()
            .map(|(title, page)| html::link_html(title, link(page).as_deref()))
            .collect::<Vec<_>>()
            .join(", "),
        "date" | "created_time" | "updated_time" => {
            let t = cell_text(p, row, link).0;
            if t.is_empty() {
                t
            } else {
                format!("<time>@{}</time>", html::esc(&t))
            }
        }
        "url" => {
            let t = cell_text(p, row, link).0;
            if t.starts_with("http://") || t.starts_with("https://") {
                html::link_html(&t, Some(&t))
            } else {
                html::esc(&t)
            }
        }
        _ => html::esc(&cell_text(p, row, link).0),
    }
}

/// The Notion property type a Suivelle property is exported as.
fn notion_kind(t: &str) -> &'static str {
    match t {
        "title" => "title",
        "number" => "number",
        "select" => "select",
        "multi_select" => "multi_select",
        "status" => "status",
        "date" => "date",
        "checkbox" => "checkbox",
        "url" => "url",
        "email" => "email",
        "phone" => "phone_number",
        "created_time" => "created_time",
        "updated_time" => "last_edited_time",
        "unique_id" => "unique_id",
        "relation" => "relation",
        "rollup" => "rollup",
        "formula" => "formula",
        _ => "text",
    }
}

/// The class of the type icon in a Notion HTML column header.
fn type_icon(t: &str) -> String {
    let k = match notion_kind(t) {
        "title" => "Title",
        "number" => "Number",
        "select" => "Select",
        "multi_select" => "MultipleSelect",
        "status" => "Status",
        "date" => "Date",
        "checkbox" => "Checkbox",
        "url" => "Url",
        "email" => "Email",
        "phone_number" => "PhoneNumber",
        "created_time" => "CreatedAt",
        "last_edited_time" => "LastEditedTime",
        "unique_id" => "UniqueId",
        "relation" => "Relation",
        "rollup" => "Rollup",
        "formula" => "Formula",
        _ => "Text",
    };
    format!("types{k}")
}

fn exported_properties(
    conn: &Connection,
    db_page: &str,
) -> AppResult<(crate::databases::DatabaseDetail, Vec<Property>)> {
    let detail = dbs::database_detail_by_page(conn, db_page)?;
    let mut props: Vec<Property> = detail
        .properties
        .iter()
        .filter(|p| p.property_type != "button")
        .cloned()
        .collect();
    // The title first, as Notion does.
    if let Some(t) = props.iter().position(|p| p.property_type == "title") {
        let title = props.remove(t);
        props.insert(0, title);
    }
    Ok((detail, props))
}

fn csv_bytes(
    props: &[Property],
    rows: &[RecordRow],
    link: &dyn Fn(&str) -> Option<String>,
) -> AppResult<Vec<u8>> {
    let headers: Vec<String> = props.iter().map(|p| p.name.clone()).collect();
    let body: Vec<Vec<String>> = rows
        .iter()
        .map(|row| {
            props
                .iter()
                .map(|p| {
                    let (t, is_text) = cell_text(p, row, link);
                    if is_text {
                        csvio::neutralize(t)
                    } else {
                        t
                    }
                })
                .collect()
        })
        .collect();
    csvio::write(&headers, &body)
}

/// Every record of a database as CSV (UTF-8 with a byte order mark), regardless of any view's
/// filters. Buttons have no value and are left out.
pub fn database_csv(conn: &Connection, page_id: &str) -> AppResult<(String, Vec<u8>)> {
    let (detail, props) = exported_properties(conn, page_id)?;
    let rows = record_rows(conn, &detail.database.id, false)?;
    Ok((detail.page.title, csv_bytes(&props, &rows, &|_| None)?))
}

// ---------------------------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------------------------

/// Where an export goes: a folder, or a zip file.
pub enum Sink {
    Dir(PathBuf),
    Zip(Box<ZipWriter<File>>),
}

fn zip_err(e: impl std::fmt::Display) -> AppError {
    AppError::Internal(format!("the zip file could not be written: {e}"))
}

impl Sink {
    pub fn zip(file: &Path) -> AppResult<Sink> {
        Ok(Sink::Zip(Box::new(ZipWriter::new(File::create(file)?))))
    }

    fn put(&mut self, rel: &str, bytes: &[u8]) -> AppResult<()> {
        match self {
            Sink::Dir(root) => {
                let path = root.join(rel);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(path, bytes)?;
            }
            Sink::Zip(z) => {
                z.start_file(
                    rel,
                    SimpleFileOptions::default().large_file(bytes.len() as u64 > u32::MAX as u64),
                )
                .map_err(zip_err)?;
                z.write_all(bytes)?;
            }
        }
        Ok(())
    }

    fn copy(&mut self, rel: &str, source: &Path) -> AppResult<()> {
        match self {
            Sink::Dir(root) => {
                let path = root.join(rel);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(source, path)?;
            }
            Sink::Zip(z) => {
                let size = std::fs::metadata(source)?.len();
                z.start_file(
                    rel,
                    SimpleFileOptions::default().large_file(size > u32::MAX as u64),
                )
                .map_err(zip_err)?;
                std::io::copy(&mut File::open(source)?, z.as_mut())?;
            }
        }
        Ok(())
    }

    pub fn finish(self) -> AppResult<()> {
        if let Sink::Zip(z) = self {
            z.finish().map_err(zip_err)?.sync_all()?;
        }
        Ok(())
    }
}

struct Exporter<'a> {
    conn: &'a Connection,
    store: &'a Path,
    opts: &'a ExportOptions,
    plan: &'a Plan,
    sink: &'a mut Sink,
    /// asset key → path in the export
    assets: HashMap<String, String>,
    out: Written,
    /// database page → its exported properties, with each record's row
    databases: HashMap<String, (Vec<Property>, HashMap<String, RecordRow>)>,
}

/// Where each exported page is, relative to the file at `from`.
fn linker<'b>(plan: &'b Plan, from: &'b str) -> impl Fn(&str) -> Option<String> + 'b {
    move |id: &str| plan.paths.get(id).map(|to| relative(from, to))
}

impl Exporter<'_> {
    /// Copies (or, for a crop, renders) the files a page shows into `assets/`.
    fn store_assets(&mut self, blocks: &[Blk]) -> AppResult<()> {
        let mut media: Vec<Media> = Vec::new();
        visit(blocks, &mut |b| {
            if let Some(m) = &b.media {
                if m.attachment.is_some() {
                    media.push(m.clone());
                }
            }
        });
        for m in media {
            let hash = m
                .attachment
                .as_ref()
                .and_then(|a| a.get("hash"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let (Some(key), Some(file_name)) = (asset_key(&m), asset_name(&m)) else {
                continue;
            };
            if self.assets.contains_key(&key) || !files::is_hash(&hash) {
                continue;
            }
            let rel = format!("assets/{file_name}");
            let source = files::blob_path(self.store, &hash);
            let copied = if let Some(c) = m.presentation.get("crop") {
                let crop = serde_json::from_value(c.clone())
                    .map_err(|_| AppError::Validation("Invalid image crop".into()))?;
                let mut png = std::io::Cursor::new(Vec::new());
                files::image_edit::render(&source, Some(crop))?
                    .write_to(&mut png, image::ImageFormat::Png)
                    .map_err(|e| AppError::Internal(e.to_string()))?;
                self.sink.put(&rel, &png.into_inner()).is_ok()
            } else {
                source.is_file() && self.sink.copy(&rel, &source).is_ok()
            };
            if copied {
                self.assets.insert(key, rel);
                self.out.attachments += 1;
            }
        }
        Ok(())
    }

    fn rows_of(&mut self, db_page: &str) -> AppResult<()> {
        if self.databases.contains_key(db_page) {
            return Ok(());
        }
        let (detail, props) = exported_properties(self.conn, db_page)?;
        let rows = record_rows(self.conn, &detail.database.id, self.opts.rows == "view")?;
        let by_page = rows.into_iter().map(|r| (r.page_id.clone(), r)).collect();
        self.databases.insert(db_page.to_string(), (props, by_page));
        Ok(())
    }

    fn page(&mut self, item: &Item) -> AppResult<()> {
        let mut blocks = resolve_embeds(
            self.conn,
            tree_from_rows(&repo::block::list(self.conn, &item.page.id)?),
            0,
        )?;
        let mut notices = Vec::new();
        {
            let link = linker(self.plan, &item.path);
            prepare(&mut blocks, &link, self.opts.files, &mut notices);
        }
        self.out.skipped.extend(notices);
        if self.opts.files {
            self.store_assets(&blocks)?;
        }
        // A record's properties come first: lines in Markdown, a table in HTML.
        let mut lines: Vec<String> = Vec::new();
        let mut props_html: Vec<(String, String, String)> = Vec::new();
        if let Kind::Record(db) = &item.kind {
            self.rows_of(db)?;
            let link = linker(self.plan, &item.path);
            if let Some((props, rows)) = self.databases.get(db) {
                if let Some(row) = rows.get(&item.page.id) {
                    for p in props.iter().filter(|p| p.property_type != "title") {
                        let (text, _) = cell_text(p, row, &link);
                        if text.is_empty() || (p.property_type == "checkbox" && text == "No") {
                            continue;
                        }
                        lines.push(format!("{}: {}", p.name, text.replace('\n', " ")));
                        props_html.push((
                            p.name.clone(),
                            notion_kind(&p.property_type).to_string(),
                            cell_html(p, row, &link),
                        ));
                    }
                }
            }
        }
        let conn = self.conn;
        let assets = &self.assets;
        let from = item.path.clone();
        let link = |id: &str| self.plan.paths.get(id).map(|to| relative(&from, to));
        let ctx = Ctx {
            asset: &|m: &Media| assets.get(&asset_key(m)?).map(|p| relative(&from, p)),
            title: &|id| repo::page::get(conn, id).ok().flatten().map(|p| p.title),
            link: &link,
        };
        let text = if self.opts.html() {
            html::render_page(
                &item.page.title,
                item.page.icon.as_deref(),
                &props_html,
                &blocks,
                &ctx,
            )
        } else {
            let mut s = format!("# {}\n\n", item.page.title.replace('\n', " "));
            if !lines.is_empty() {
                s.push_str(&lines.join("\n"));
                s.push_str("\n\n");
            }
            s.push_str(&markdown::render(&blocks, &ctx));
            s.push('\n');
            s
        };
        self.sink.put(&item.path, text.as_bytes())?;
        self.out.files += 1;
        Ok(())
    }

    fn database(&mut self, item: &Item) -> AppResult<()> {
        self.rows_of(&item.page.id)?;
        let (detail, props) = exported_properties(self.conn, &item.page.id)?;
        let rows = record_rows(self.conn, &detail.database.id, self.opts.rows == "view")?;
        let link = linker(self.plan, &item.path);
        let bytes = if self.opts.html() {
            let columns: Vec<(String, String)> = props
                .iter()
                .map(|p| (p.name.clone(), type_icon(&p.property_type)))
                .collect();
            let cells: Vec<Vec<String>> = rows
                .iter()
                .map(|r| props.iter().map(|p| cell_html(p, r, &link)).collect())
                .collect();
            html::render_collection(&item.page.title, &columns, &cells).into_bytes()
        } else {
            csv_bytes(&props, &rows, &link)?
        };
        self.sink.put(&item.path, &bytes)?;
        self.out.files += 1;
        Ok(())
    }
}

/// Writes `page_id` (and, as `opts` says, everything below it) to `sink`. `single` names the
/// one file of an export that is a single page.
pub fn export(
    conn: &Connection,
    store: &Path,
    page_id: &str,
    opts: &ExportOptions,
    sink: &mut Sink,
    single: Option<&str>,
) -> AppResult<Written> {
    opts.check()?;
    crate::domain::validate_id(page_id, "page")?;
    let page = live_page(conn, page_id)?;
    if page.kind == "dashboard" {
        return bad("dashboards cannot be exported on their own; use the workspace archive");
    }
    let mut opts = opts.clone();
    if opts.format == "pdf" {
        opts.include_subpages = false;
    }
    let plan = plan(conn, &page, &opts, single)?;
    let mut e = Exporter {
        conn,
        store,
        opts: &opts,
        plan: &plan,
        sink,
        assets: HashMap::new(),
        out: Written::default(),
        databases: HashMap::new(),
    };
    e.out.skipped.extend(plan.notices.iter().cloned());
    for item in &plan.items {
        match item.kind {
            Kind::Database => e.database(item)?,
            _ => e.page(item)?,
        }
    }
    let mut out = e.out;
    out.skipped.sort();
    out.skipped.dedup();
    Ok(out)
}

/// A single page to one file (when [`shape`] says no folder is needed).
pub fn export_page_file(
    conn: &Connection,
    store: &Path,
    page_id: &str,
    format: &str,
    file: &Path,
) -> AppResult<Written> {
    let mut opts = ExportOptions::of(format);
    opts.include_subpages = false;
    let dir = file.parent().unwrap_or(Path::new(".")).to_path_buf();
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export".into());
    let mut sink = Sink::Dir(dir);
    let out = export(conn, store, page_id, &opts, &mut sink, Some(&name))?;
    sink.finish()?;
    Ok(out)
}

/// A page with its files and subpages, inside `folder` (which must exist).
pub fn export_page_folder(
    conn: &Connection,
    store: &Path,
    page_id: &str,
    format: &str,
    folder: &Path,
) -> AppResult<Written> {
    if format != "markdown" && format != "html" {
        return bad("choose Markdown or HTML");
    }
    let mut sink = Sink::Dir(folder.to_path_buf());
    let out = export(
        conn,
        store,
        page_id,
        &ExportOptions::of(format),
        &mut sink,
        None,
    )?;
    sink.finish()?;
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
pub struct Preview {
    pub source: String,
    pub html: String,
    pub notices: Vec<String>,
    pub assets: HashMap<String, Value>,
}

/// The root page as it will be written, with its HTML rendering for display.
pub fn preview(conn: &Connection, page_id: &str, format: &str) -> AppResult<Preview> {
    preview_with(conn, page_id, &ExportOptions::of(format))
}

pub fn preview_with(conn: &Connection, page_id: &str, opts: &ExportOptions) -> AppResult<Preview> {
    opts.check()?;
    crate::domain::validate_id(page_id, "page")?;
    let page = live_page(conn, page_id)?;
    let plan = plan(conn, &page, opts, None)?;
    let from = plan.paths.get(&page.id).cloned().unwrap_or_default();
    let link = |id: &str| plan.paths.get(id).map(|to| relative(&from, to));
    let mut blocks = tree_from_rows(&repo::block::list(conn, page_id)?);
    let mut notices = Vec::new();
    prepare(&mut blocks, &link, opts.files, &mut notices);
    let blocks = resolve_embeds(conn, blocks, 0)?;
    let mut assets = HashMap::new();
    visit(&blocks, &mut |b| {
        if let Some(m) = &b.media {
            if let Some(name) = asset_name(m) {
                if let Some(hash) = m.attachment.as_ref().and_then(|a| a.get("hash")) {
                    assets.insert(
                        relative(&from, &format!("assets/{name}")),
                        serde_json::json!({"hash":hash,"crop":m.presentation.get("crop")}),
                    );
                }
            }
        }
    });
    let ctx = Ctx {
        asset: &|m| asset_name(m).map(|n| relative(&from, &format!("assets/{n}"))),
        title: &|id| repo::page::get(conn, id).ok().flatten().map(|p| p.title),
        link: &link,
    };
    let html = html::render_page(&page.title, page.icon.as_deref(), &[], &blocks, &ctx);
    let source = if opts.html() {
        html.clone()
    } else {
        format!(
            "# {}\n\n{}\n",
            page.title.replace('\n', " "),
            markdown::render(&blocks, &ctx)
        )
    };
    notices.extend(plan.notices);
    notices.push("Preview approximates the destination renderer; Markdown captions import as ordinary paragraphs.".into());
    Ok(Preview {
        source,
        html,
        notices,
        assets,
    })
}

#[cfg(test)]
mod tests {
    use super::relative;

    #[test]
    fn relative_paths_between_exported_files() {
        assert_eq!(relative("A.md", "B.md"), "B.md");
        assert_eq!(relative("A.md", "A/B.md"), "A/B.md");
        assert_eq!(relative("A/B.md", "A.md"), "../A.md");
        assert_eq!(relative("A/B/C.md", "A/D/E.md"), "../D/E.md");
        assert_eq!(relative("A/B.md", "assets/x.png"), "../assets/x.png");
    }
}

//! Exporting a page (Markdown or HTML, with its files and subpages) and a database (CSV).
//! The whole-workspace archive lives in `archive`.

use super::blocks::*;
use super::csvio;
use super::html;
use super::markdown::{self, Ctx};
use crate::databases::service::{self as dbs, load_rows};
use crate::databases::{Property, RecordRow};
use crate::domain::Page;
use crate::errors::{AppError, AppResult};
use crate::files;
use crate::repositories as repo;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    /// "page" or "database".
    pub kind: String,
    pub title: String,
    /// The page has files or subpages, so it needs a folder rather than a single file.
    pub needs_folder: bool,
}

pub fn shape(conn: &Connection, page_id: &str) -> AppResult<Shape> {
    crate::domain::validate_id(page_id, "page")?;
    let page = live_page(conn, page_id)?;
    match page.kind.as_str() {
        "database" => Ok(Shape {
            kind: "database".into(),
            title: page.title,
            needs_folder: false,
        }),
        "page" | "record" => {
            let has_kids =
                !repo::page::list_children(conn, &page.workspace_id, Some(&page.id))?.is_empty();
            let mut has_assets = false;
            visit(
                &resolve_embeds(conn, tree_from_rows(&repo::block::list(conn, &page.id)?), 0)?,
                &mut |b| {
                    has_assets |= b.media.as_ref().is_some_and(|m| m.attachment.is_some());
                },
            );
            Ok(Shape {
                kind: "page".into(),
                title: page.title,
                needs_folder: has_kids || has_assets,
            })
        }
        _ => bad("dashboards cannot be exported on their own; use the workspace archive"),
    }
}

/// Replaces blocks that only point at content elsewhere with that content, so an export is complete:
/// a synced block becomes the blocks it shows, and an embedded database becomes a line naming it.
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
                        vec![plain(format!("Database: {title}"))],
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

// ---------------------------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub files: usize,
    pub attachments: usize,
    pub skipped: Vec<String>,
}

struct Exporter<'a> {
    conn: &'a Connection,
    store: &'a Path,
    root: PathBuf,
    html: bool,
    assets: HashMap<String, String>,
    out: Written,
    page_paths: HashMap<String, String>,
}

fn asset_key(m: &Media) -> Option<String> {
    let hash = m.attachment.as_ref()?.get("hash")?.as_str()?;
    Some(if let Some(crop) = m.presentation.get("crop") {
        format!("{hash}-{}", crop.to_string())
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
fn paths(
    conn: &Connection,
    root: &Page,
    html: bool,
    children: bool,
) -> AppResult<HashMap<String, String>> {
    fn walk(
        conn: &Connection,
        page: &Page,
        prefix: &str,
        ext: &str,
        used: &mut HashSet<String>,
        out: &mut HashMap<String, String>,
        children: bool,
    ) -> AppResult<()> {
        let name = unique(
            used,
            &safe_name(&page.title),
            if page.kind == "database" { ".csv" } else { ext },
        );
        out.insert(page.id.clone(), format!("{prefix}{name}"));
        if children {
            let mut local = HashSet::new();
            let next = format!("{prefix}{}/", name.trim_end_matches(ext));
            for child in repo::page::list_children(conn, &page.workspace_id, Some(&page.id))? {
                if child.kind != "record" && child.kind != "dashboard" {
                    walk(conn, &child, &next, ext, &mut local, out, true)?;
                }
            }
        }
        Ok(())
    }
    let mut out = HashMap::new();
    walk(
        conn,
        root,
        "",
        if html { ".html" } else { ".md" },
        &mut HashSet::new(),
        &mut out,
        children,
    )?;
    Ok(out)
}
fn prepare(
    blocks: &mut [Blk],
    page_paths: &HashMap<String, String>,
    prefix: &str,
    notices: &mut Vec<String>,
) {
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
            {
                if let Some(path) = page_paths.get(id) {
                    m.presentation["link"] = serde_json::json!(format!("{prefix}{path}"));
                } else {
                    if let Some(p) = m.presentation.as_object_mut() {
                        p.remove("link");
                    }
                    notices.push(
                        "An image link targets a page outside this export and was omitted.".into(),
                    );
                }
            }
        }
    });
    notices.sort();
    notices.dedup();
}

#[derive(Serialize)]
pub struct Preview {
    pub source: String,
    pub html: String,
    pub notices: Vec<String>,
    pub assets: HashMap<String, Value>,
}
pub fn preview(conn: &Connection, page_id: &str, format: &str) -> AppResult<Preview> {
    if !matches!(format, "markdown" | "html") {
        return bad("choose Markdown or HTML");
    }
    crate::domain::validate_id(page_id, "page")?;
    let page = live_page(conn, page_id)?;
    let mut blocks = tree_from_rows(&repo::block::list(conn, page_id)?);
    let mut notices = Vec::new();
    prepare(
        &mut blocks,
        &paths(conn, &page, format == "html", true)?,
        "",
        &mut notices,
    );
    let blocks = resolve_embeds(conn, blocks, 0)?;
    let mut assets = HashMap::new();
    visit(&blocks, &mut |b| {
        if let Some(m) = &b.media {
            if let Some(name) = asset_name(m) {
                if let Some(hash) = m.attachment.as_ref().and_then(|a| a.get("hash")) {
                    assets.insert(
                        format!("assets/{name}"),
                        serde_json::json!({"hash":hash,"crop":m.presentation.get("crop")}),
                    );
                }
            }
        }
    });
    let ctx = Ctx {
        asset: &|m| asset_name(m).map(|n| format!("assets/{n}")),
        title: &|id| repo::page::get(conn, id).ok().flatten().map(|p| p.title),
    };
    let html = html::render_document(&page.title, &blocks, &ctx);
    let source = if format == "html" {
        html.clone()
    } else {
        format!(
            "# {}\n\n{}\n",
            page.title.replace('\n', " "),
            markdown::render(&blocks, &ctx)
        )
    };
    notices.push("Preview approximates the destination renderer; Markdown captions import as ordinary paragraphs.".into());
    Ok(Preview {
        source,
        html,
        notices,
        assets,
    })
}

impl Exporter<'_> {
    fn ext(&self) -> &'static str {
        if self.html {
            ".html"
        } else {
            ".md"
        }
    }

    fn document(&mut self, page: &Page, file: &Path, depth: usize) -> AppResult<()> {
        let mut blocks = resolve_embeds(
            self.conn,
            tree_from_rows(&repo::block::list(self.conn, &page.id)?),
            0,
        )?;
        let mut media: Vec<Media> = Vec::new();
        visit(&blocks, &mut |b| {
            if let Some(a) = b.media.as_ref().and_then(|m| m.attachment.as_ref()) {
                if let (Some(h), Some(n)) = (
                    a.get("hash").and_then(Value::as_str),
                    a.get("name").and_then(Value::as_str),
                ) {
                    let _ = (h, n);
                    media.push(b.media.as_ref().unwrap().clone());
                }
            }
        });
        for m in media {
            let hash = m
                .attachment
                .as_ref()
                .and_then(|a| a.get("hash"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(key) = asset_key(&m) else {
                continue;
            };
            if self.assets.contains_key(&key) || !files::is_hash(hash) {
                continue;
            }
            let dir = self.root.join("assets");
            std::fs::create_dir_all(&dir)?;
            let file_name = asset_name(&m).unwrap();
            let source = files::blob_path(self.store, hash);
            let copied = if let Some(c) = m.presentation.get("crop") {
                let crop = serde_json::from_value(c.clone())
                    .map_err(|_| AppError::Validation("Invalid image crop".into()))?;
                files::image_edit::render(&source, Some(crop))?
                    .save_with_format(dir.join(&file_name), image::ImageFormat::Png)
                    .map_err(|e| AppError::Internal(e.to_string()))?;
                true
            } else {
                std::fs::copy(source, dir.join(&file_name)).is_ok()
            };
            if copied {
                self.assets.insert(key, format!("assets/{file_name}"));
                self.out.attachments += 1;
            }
        }
        let prefix = "../".repeat(depth);
        prepare(
            &mut blocks,
            &self.page_paths,
            &prefix,
            &mut self.out.skipped,
        );
        let conn = self.conn;
        let assets = &self.assets;
        let ctx = Ctx {
            asset: &|m: &Media| assets.get(&asset_key(m)?).map(|p| format!("{prefix}{p}")),
            title: &|id| repo::page::get(conn, id).ok().flatten().map(|p| p.title),
        };
        let text = if self.html {
            html::render_document(&page.title, &blocks, &ctx)
        } else {
            format!(
                "# {}\n\n{}\n",
                page.title.replace('\n', " "),
                markdown::render(&blocks, &ctx)
            )
        };
        std::fs::write(file, text)?;
        self.out.files += 1;
        Ok(())
    }

    /// Writes `page` as `<dir>/<name>` and its subpages in `<dir>/<name stem>/`.
    fn page(
        &mut self,
        page: &Page,
        dir: &Path,
        used: &mut HashSet<String>,
        depth: usize,
        children: bool,
    ) -> AppResult<()> {
        match page.kind.as_str() {
            "database" => {
                let name = unique(used, &safe_name(&page.title), ".csv");
                let (_, bytes) = database_csv(self.conn, &page.id)?;
                std::fs::write(dir.join(name), bytes)?;
                self.out.files += 1;
                return Ok(());
            }
            "dashboard" => {
                self.out.skipped.push(format!(
                    "The dashboard “{}” (dashboards are only in the workspace archive)",
                    page.title
                ));
                return Ok(());
            }
            "record" => return Ok(()),
            _ => {}
        }
        let base = safe_name(&page.title);
        let ext = self.ext();
        let name = unique(used, &base, ext);
        self.document(page, &dir.join(&name), depth)?;
        if !children {
            return Ok(());
        }
        let kids = repo::page::list_children(self.conn, &page.workspace_id, Some(&page.id))?;
        if kids.is_empty() {
            return Ok(());
        }
        let sub = dir.join(name.trim_end_matches(ext));
        std::fs::create_dir_all(&sub)?;
        let mut sub_used = HashSet::new();
        for k in kids {
            self.page(&k, &sub, &mut sub_used, depth + 1, true)?;
        }
        Ok(())
    }
}

/// A single page to one file (when [`shape`] says no folder is needed).
pub fn export_page_file(
    conn: &Connection,
    store: &Path,
    page_id: &str,
    format: &str,
    file: &Path,
) -> AppResult<Written> {
    let page = live_page(conn, page_id)?;
    let dir = file.parent().unwrap_or(Path::new(".")).to_path_buf();
    let mut e = Exporter {
        conn,
        store,
        root: dir,
        html: format == "html",
        assets: HashMap::new(),
        out: Written::default(),
        page_paths: HashMap::from([(
            page.id.clone(),
            file.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        )]),
    };
    e.document(&page, file, 0)?;
    Ok(e.out)
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
    let page = live_page(conn, page_id)?;
    let mut e = Exporter {
        conn,
        store,
        root: folder.to_path_buf(),
        html: format == "html",
        assets: HashMap::new(),
        out: Written::default(),
        page_paths: paths(conn, &page, format == "html", true)?,
    };
    let mut used = HashSet::new();
    e.page(&page, folder, &mut used, 0, true)?;
    Ok(e.out)
}

// ---------------------------------------------------------------------------------------------
// databases
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
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map(number_text).unwrap_or_default(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(dynamic_text).collect::<Vec<_>>().join(", "),
        Value::Object(o) => {
            if let Some(e) = o.get("error").and_then(Value::as_str) {
                return e.to_string();
            }
            match (
                o.get("start").and_then(Value::as_str),
                o.get("end").and_then(Value::as_str),
            ) {
                (Some(s), Some(e)) => format!("{s} → {e}"),
                (Some(s), None) => s.to_string(),
                _ => String::new(),
            }
        }
    }
}

fn option_name(p: &Property, id: &Value) -> String {
    p.config["options"]
        .as_array()
        .and_then(|a| a.iter().find(|o| &o["id"] == id))
        .and_then(|o| o["name"].as_str())
        .unwrap_or("")
        .to_string()
}

/// A cell as plain text, the way the table shows it. The bool says whether it is text (and so
/// must be guarded against spreadsheet formulas).
pub fn cell_text(p: &Property, row: &RecordRow) -> (String, bool) {
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
        "created_time" => (row.created_at.clone(), false),
        "updated_time" => (row.updated_at.clone(), false),
        "number" => (
            v.and_then(Value::as_f64)
                .map(number_text)
                .unwrap_or_default(),
            false,
        ),
        "checkbox" => ((v == Some(&Value::Bool(true))).to_string(), false),
        "date" => (v.map(dynamic_text).unwrap_or_default(), false),
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
            v.and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|l| {
                            l.get("title")
                                .and_then(Value::as_str)
                                .unwrap_or("Untitled")
                                .to_string()
                        })
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .unwrap_or_default(),
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

/// Every record of a database as CSV (UTF-8 with a byte order mark), regardless of any view's
/// filters. Buttons have no value and are left out.
pub fn database_csv(conn: &Connection, page_id: &str) -> AppResult<(String, Vec<u8>)> {
    let detail = dbs::database_detail_by_page(conn, page_id)?;
    let props: Vec<&Property> = detail
        .properties
        .iter()
        .filter(|p| p.property_type != "button")
        .collect();
    let headers: Vec<String> = props.iter().map(|p| p.name.clone()).collect();
    let mut stmt = conn.prepare(
        "SELECT r.id FROM db_record r JOIN page p ON p.id = r.page_id WHERE r.database_id = ?1 AND p.deleted_at IS NULL ORDER BY r.unique_id",
    )?;
    let ids: Vec<String> = stmt
        .query_map([&detail.database.id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    let mut rows = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(400) {
        for row in load_rows(conn, chunk)? {
            rows.push(
                props
                    .iter()
                    .map(|p| {
                        let (t, is_text) = cell_text(p, &row);
                        if is_text {
                            csvio::neutralize(t)
                        } else {
                            t
                        }
                    })
                    .collect::<Vec<_>>(),
            );
        }
    }
    Ok((detail.page.title, csvio::write(&headers, &rows)?))
}

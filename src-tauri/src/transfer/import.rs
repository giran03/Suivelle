//! Importing files and folders: Markdown, text, HTML, CSV, PDF, zips of those, Notion exports and
//! Suivelle archives.
//!
//! Importing has two steps. `stage_*` reads and parses everything and keeps the result in memory
//! (nothing is written to the workspace and the frontend never sees a path); `apply` then creates
//! it all in one transaction, under one new page, an existing page or a new workspace, so a failure
//! changes nothing and the result can be trashed in one go.

use super::archive::{self, Archive};
use super::blocks::*;
use super::csvio::{self, ColumnPlan};
use super::unzip::{self, TempDir};
use super::{html, insert_page, markdown, notion};
use crate::databases::service::{self as dbs};
use crate::databases::{DatabaseCreate, PropertyCreate, RecordCreate, SetValue};
use crate::domain::{new_id, BlockBatch};
use crate::errors::{AppError, AppResult};
use crate::files::{self, MAX_ATTACHMENT_BYTES};
use crate::search::text::INTERNAL_PAGE_LINK;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const MAX_FILES: usize = 2_000;
pub const MAX_DOC_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;
const MAX_DEPTH: usize = 12;
const MAX_OPTIONS: usize = 50;

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

pub(crate) enum Source {
    Doc {
        blocks: Vec<Blk>,
        page_id: String,
    },
    Csv {
        csv: csvio::Csv,
        plan: Vec<ColumnPlan>,
    },
    /// A database from a Notion export: typed columns, rows with their own pages, and relations.
    Database(Box<notion::DbModel>),
    /// A PDF, kept whole on a page of its own.
    Pdf {
        page_id: String,
        key: String,
        name: String,
    },
    Folder,
}

pub(crate) struct Node {
    pub index: usize,
    pub title: String,
    pub source: Source,
    pub children: Vec<Node>,
    /// An emoji, or an asset key for an image icon.
    pub icon: Option<String>,
    /// An asset key for the cover picture.
    pub cover: Option<String>,
}

impl Node {
    pub fn new(index: usize, title: String, source: Source) -> Node {
        Node {
            index,
            title,
            source,
            children: vec![],
            icon: None,
            cover: None,
        }
    }
}

/// Where an import came from, when it is more than loose files.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    /// "notion".
    pub kind: String,
    /// "markdown", "html", "pdf" or "mixed".
    pub format: String,
    /// "folders" (subpages in folders) or "flat".
    pub layout: String,
    /// The export looks like a whole workspace rather than one page and its subpages.
    pub workspace: bool,
    /// A name for a new workspace made from it.
    pub name: String,
}

pub struct Staged {
    pub id: String,
    pub(crate) nodes: Vec<Node>,
    archive: Option<(PathBuf, archive::Info)>,
    pub(crate) assets: HashMap<String, u64>,
    pub warnings: Vec<String>,
    pub(crate) bytes: u64,
    pub(crate) origin: Option<Origin>,
    /// Where a zip was unpacked; removed with the session.
    pub(crate) temp: Option<TempDir>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub index: usize,
    pub name: String,
    /// "page", "database" or "folder".
    pub kind: String,
    pub depth: usize,
    pub detail: String,
    pub columns: Option<Vec<ColumnPlan>>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    pub entries: Vec<Entry>,
    pub pages: usize,
    pub databases: usize,
    pub records: usize,
    pub attachments: usize,
    pub bytes: u64,
    pub warnings: Vec<String>,
    pub archive: Option<archive::Info>,
    pub origin: Option<Origin>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// The page that holds everything that was imported (or, in a new workspace, its first page).
    pub page_id: String,
    pub pages: usize,
    pub databases: usize,
    pub records: usize,
    pub attachments: usize,
    pub warnings: Vec<String>,
    /// The workspace that was created, when the import made one.
    pub workspace: Option<crate::domain::Workspace>,
}

/// Where the imported pages go.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    /// Under a new "Imported …" page at the top of the workspace.
    #[default]
    Container,
    /// Under an existing page.
    #[serde(rename_all = "camelCase")]
    Page { page_id: String },
    /// At the top of a new workspace.
    Workspace { name: String },
}

// ---------------------------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------------------------

pub(crate) struct Ctx {
    pub root: PathBuf,
    pub counter: usize,
    pub bytes: u64,
    pub assets: HashMap<String, u64>,
    pub warnings: Vec<String>,
    /// canonical file path -> the page it will become
    pub pages: HashMap<PathBuf, String>,
}

impl Ctx {
    pub fn new(root: PathBuf) -> Ctx {
        Ctx {
            root,
            counter: 0,
            bytes: 0,
            assets: HashMap::new(),
            warnings: vec![],
            pages: HashMap::new(),
        }
    }

    pub fn warn(&mut self, m: String) {
        if self.warnings.len() < 50 && !self.warnings.contains(&m) {
            self.warnings.push(m);
        }
    }

    pub fn next(&mut self) -> usize {
        self.counter += 1;
        self.counter
    }

    /// Counts a file the import will store; `None` when it does not fit the limits.
    pub fn add_asset(&mut self, path: &Path) -> Option<String> {
        let size = std::fs::metadata(path).map(|m| m.len()).ok()?;
        let key = path.to_string_lossy().into_owned();
        if self.assets.contains_key(&key) {
            return Some(key);
        }
        if size > MAX_ATTACHMENT_BYTES || self.bytes + size > MAX_TOTAL_BYTES {
            return None;
        }
        self.bytes += size;
        self.assets.insert(key.clone(), size);
        Some(key)
    }
}

pub(crate) fn kind_of(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "md" | "markdown" | "mdown" => Some("markdown"),
        "txt" | "text" => Some("text"),
        "html" | "htm" | "xhtml" => Some("html"),
        "csv" | "tsv" => Some("csv"),
        "zip" => Some("archive"),
        _ => None,
    }
}

pub(crate) fn is_pdf(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

pub(crate) fn read_limited(path: &Path, ctx: &mut Ctx) -> AppResult<Vec<u8>> {
    let len = std::fs::metadata(path)?.len();
    if len > MAX_DOC_BYTES {
        return bad(format!("{} is larger than 50 MB", display(path)));
    }
    ctx.bytes += len;
    if ctx.bytes > MAX_TOTAL_BYTES {
        return bad("this import is larger than 500 MB; import fewer files at a time");
    }
    Ok(std::fs::read(path)?)
}

pub(crate) fn display(p: &Path) -> String {
    p.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("a file")
        .to_string()
}

pub(crate) fn stem(p: &Path) -> String {
    p.file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled")
        .to_string()
}

fn text_blocks(text: &str) -> Vec<Blk> {
    let text = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    text.split("\n\n")
        .map(|c| c.trim_matches('\n'))
        .filter(|c| !c.trim().is_empty())
        .map(|chunk| {
            let mut inline = Vec::new();
            for (i, line) in chunk.lines().enumerate() {
                if i > 0 {
                    inline.push(Inline::Break);
                }
                inline.push(plain(line.trim_end()));
            }
            Blk::with_inline("paragraph", inline)
        })
        .collect()
}

pub(crate) fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

pub(crate) fn is_external(href: &str) -> bool {
    let l = href.trim().to_ascii_lowercase();
    crate::legacy::page_target(&l).is_some()
        || ["http://", "https://", "mailto:", "suivelle://", "tel:"]
            .iter()
            .any(|p| l.starts_with(p))
}

/// A path named by a document, if it points at an existing file inside the import's root.
pub(crate) fn local_file(href: &str, doc_dir: &Path, root: &Path) -> Option<PathBuf> {
    if href.is_empty() || is_external(href) || href.starts_with('#') || href.contains("://") {
        return None;
    }
    let clean = notion::names::percent_decode(href.split(['#', '?']).next().unwrap_or(""));
    let joined = doc_dir.join(clean.replace('\\', "/"));
    let canon = joined.canonicalize().ok()?;
    (canon.starts_with(root) && canon.is_file()).then_some(canon)
}

/// What a link or image in a document points at.
pub(crate) enum Found {
    /// A page (or database) the import creates, by the id it will have.
    Page(String),
    /// A file the import stores, by its asset key.
    Asset {
        key: String,
        name: String,
    },
    Nothing,
}

/// Looks up what documents point at. Folder imports resolve paths on disk; Notion imports
/// resolve the ids in Notion's file names first.
pub(crate) trait Resolve {
    /// `media` is `Some(is_image)` when the link stands alone and could become a media block,
    /// `None` for a link in running text (which can only lead to a page).
    fn find(&mut self, href: &str, media: Option<bool>) -> Found;
    fn warn(&mut self, m: String);
}

struct FsResolver<'a> {
    dir: PathBuf,
    ctx: &'a mut Ctx,
}

impl Resolve for FsResolver<'_> {
    fn find(&mut self, href: &str, media: Option<bool>) -> Found {
        let Some(path) = local_file(href, &self.dir, &self.ctx.root) else {
            return Found::Nothing;
        };
        if let Some(is_image) = media {
            let is_doc = kind_of(&path).is_some_and(|k| k != "archive") && !is_image;
            if !is_doc {
                return match self.ctx.add_asset(&path) {
                    Some(key) => Found::Asset {
                        key,
                        name: display(&path),
                    },
                    None => Found::Nothing,
                };
            }
        }
        match self.ctx.pages.get(&path) {
            Some(id) => Found::Page(id.clone()),
            None => Found::Nothing,
        }
    }

    fn warn(&mut self, m: String) {
        self.ctx.warn(m);
    }
}

/// Turns standalone images and links to local files into media blocks, and rewrites or drops the
/// remaining relative links.
pub(crate) fn resolve(blocks: &mut [Blk], r: &mut dyn Resolve) {
    let mut external_images = 0usize;
    resolve_in(blocks, r, &mut external_images);
    if external_images > 0 {
        r.warn(format!(
            "{external_images} image{} on the web {} kept as links (nothing is downloaded)",
            if external_images == 1 { "" } else { "s" },
            if external_images == 1 { "was" } else { "were" }
        ));
    }
}

fn resolve_in(blocks: &mut [Blk], r: &mut dyn Resolve, external_images: &mut usize) {
    for b in blocks.iter_mut() {
        if b.kind == "paragraph" {
            let meaningful: Vec<&Inline> = b
                .inline
                .iter()
                .filter(|i| !matches!(i, Inline::Text { text, .. } if text.trim().is_empty()))
                .collect();
            let single = match meaningful.as_slice() {
                [Inline::Image { src, alt }] => Some((src.clone(), alt.clone(), true)),
                [Inline::Text { text, marks }] => marks.iter().find_map(|m| {
                    if let Mark::Link(h) = m {
                        Some((h.clone(), text.clone(), false))
                    } else {
                        None
                    }
                }),
                _ => None,
            };
            if let Some((src, name, is_image)) = single {
                if is_external(&src) {
                    if is_image {
                        *external_images += 1;
                    }
                } else if let Found::Asset { key, name: file } = r.find(&src, Some(is_image)) {
                    let name = if name.trim().is_empty() || is_image {
                        file
                    } else {
                        name
                    };
                    b.kind = media_kind(files::mime_for(&name)).into();
                    if b.kind == "file" && name.to_ascii_lowercase().ends_with(".pdf") {
                        b.kind = "pdf".into();
                    }
                    b.inline.clear();
                    let mut presentation = b
                        .media
                        .as_ref()
                        .map(|m| m.presentation.clone())
                        .unwrap_or(Value::Null);
                    if let Some(href) = presentation
                        .get("link")
                        .and_then(Value::as_str)
                        .map(String::from)
                    {
                        if !is_external(&href) {
                            if let Found::Page(id) = r.find(&href, None) {
                                presentation["link"] = json!(format!("{INTERNAL_PAGE_LINK}{id}"));
                            } else if let Some(p) = presentation.as_object_mut() {
                                p.remove("link");
                            }
                        }
                    }
                    b.media = Some(Media {
                        src: Some(key),
                        name,
                        attachment: None,
                        presentation,
                    });
                    continue;
                }
            }
        }
        sanitize_inline(&mut b.inline, r);
        if let Some(t) = &mut b.table {
            for row in t.iter_mut() {
                for cell in row.iter_mut() {
                    sanitize_inline(cell, r);
                }
            }
        }
        resolve_in(&mut b.children, r, external_images);
    }
}

fn sanitize_inline(items: &mut [Inline], r: &mut dyn Resolve) {
    for it in items.iter_mut() {
        match it {
            Inline::Text { marks, .. } => {
                let old = std::mem::take(marks);
                for m in old {
                    match m {
                        Mark::Link(h) if is_external(&h) => marks.push(Mark::Link(h)),
                        Mark::Link(h) => {
                            if let Found::Page(id) = r.find(&h, None) {
                                marks.push(Mark::Link(format!("{INTERNAL_PAGE_LINK}{id}")));
                            }
                        }
                        other => marks.push(other),
                    }
                }
            }
            Inline::Image { src, alt } if !is_external(src) => {
                *it = plain(alt.clone());
            }
            _ => {}
        }
    }
}

fn doc_node(path: &Path, kind: &str, ctx: &mut Ctx) -> AppResult<Node> {
    let bytes = read_limited(path, ctx)?;
    let text = lossy(&bytes);
    let (title, blocks) = match kind {
        "markdown" => {
            let p = markdown::parse(&text);
            (p.title, p.blocks)
        }
        "html" => {
            let p = html::parse(&text);
            for warning in p.warnings {
                ctx.warn(warning);
            }
            (p.title, p.blocks)
        }
        _ => (None, text_blocks(&text)),
    };
    let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let page_id = ctx.pages.get(&canon).cloned().unwrap_or_else(new_id);
    let index = ctx.next();
    Ok(Node::new(
        index,
        title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| stem(path)),
        Source::Doc { blocks, page_id },
    ))
}

fn csv_node(path: &Path, ctx: &mut Ctx) -> AppResult<Node> {
    let bytes = read_limited(path, ctx)?;
    let csv =
        csvio::read(&bytes).map_err(|e| AppError::Validation(format!("{}: {e}", display(path))))?;
    let plan = csvio::plan(&csv);
    let index = ctx.next();
    Ok(Node::new(index, stem(path), Source::Csv { csv, plan }))
}

/// A PDF on a page of its own, or `None` (with a warning) when it is too large to store.
pub(crate) fn pdf_node(path: &Path, title: String, ctx: &mut Ctx) -> Option<Node> {
    let Some(key) = ctx.add_asset(path) else {
        ctx.warn(format!("“{}” is too large to import", display(path)));
        return None;
    };
    let index = ctx.next();
    Some(Node::new(
        index,
        title,
        Source::Pdf {
            page_id: new_id(),
            key,
            name: display(path),
        },
    ))
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>, ctx: &mut Ctx) {
    if depth > MAX_DEPTH {
        ctx.warn(format!(
            "{} is nested too deeply; deeper files were skipped",
            display(dir)
        ));
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = read.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let Ok(t) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || t.is_symlink() {
            continue;
        }
        if t.is_dir() {
            if !matches!(name.as_str(), "node_modules" | "__MACOSX") {
                walk(&e.path(), depth + 1, out, ctx);
            }
        } else if t.is_file() {
            out.push(e.path());
        }
    }
}

/// Folders become pages, with a page of the same name taking the folder's contents.
fn merge_same_names(nodes: &mut Vec<Node>) {
    let folders: Vec<usize> = (0..nodes.len())
        .filter(|i| matches!(nodes[*i].source, Source::Folder))
        .collect();
    let mut remove = Vec::new();
    for f in folders {
        let name = nodes[f].title.to_lowercase();
        if let Some(d) = (0..nodes.len()).find(|i| {
            *i != f
                && matches!(nodes[*i].source, Source::Doc { .. })
                && nodes[*i].title.to_lowercase() == name
        }) {
            let kids = std::mem::take(&mut nodes[f].children);
            nodes[d].children.extend(kids);
            remove.push(f);
        }
    }
    for i in remove.into_iter().rev() {
        nodes.remove(i);
    }
    for n in nodes.iter_mut() {
        merge_same_names(&mut n.children);
    }
}

pub(crate) fn staged(nodes: Vec<Node>, ctx: Ctx, origin: Option<Origin>) -> Staged {
    Staged {
        id: new_id(),
        nodes,
        archive: None,
        assets: ctx.assets,
        warnings: ctx.warnings,
        bytes: ctx.bytes,
        origin,
        temp: None,
    }
}

/// Places `node` under the folder nodes named by `dirs`, creating them as needed.
pub(crate) fn place(top: &mut Vec<Node>, dirs: &[String], node: Node, ctx: &mut Ctx) {
    let mut level = top;
    for d in dirs {
        let pos = match level
            .iter()
            .position(|n| matches!(n.source, Source::Folder) && n.title == *d)
        {
            Some(p) => p,
            None => {
                let index = ctx.next();
                level.push(Node::new(index, d.clone(), Source::Folder));
                level.len() - 1
            }
        };
        level = &mut level[pos].children;
    }
    level.push(node);
}

fn collect(files: Vec<(PathBuf, Vec<String>)>, root: PathBuf) -> AppResult<Staged> {
    if files.len() > MAX_FILES {
        return bad(format!(
            "that is more than {MAX_FILES} files; import a smaller folder"
        ));
    }
    let root = root.canonicalize()?;
    let mut ctx = Ctx::new(root.clone());
    let supported: Vec<(PathBuf, Vec<String>, &'static str)> = files
        .iter()
        .filter_map(|(p, dirs)| match kind_of(p) {
            Some("archive") | None => None,
            Some(k) => Some((p.canonicalize().unwrap_or(p.clone()), dirs.clone(), k)),
        })
        .collect();
    let pdfs: Vec<(PathBuf, Vec<String>)> = files
        .iter()
        .filter(|(p, _)| is_pdf(p))
        .map(|(p, dirs)| (p.canonicalize().unwrap_or(p.clone()), dirs.clone()))
        .collect();
    if supported.is_empty() && pdfs.is_empty() {
        return bad("there is nothing to import here: use Markdown, text, HTML, CSV or PDF files");
    }
    for (p, _, k) in &supported {
        if *k != "csv" {
            ctx.pages.insert(p.clone(), new_id());
        }
    }
    let mut top: Vec<Node> = Vec::new();
    for (path, dirs, kind) in &supported {
        let node = if *kind == "csv" {
            csv_node(path, &mut ctx)?
        } else {
            doc_node(path, kind, &mut ctx)?
        };
        place(&mut top, dirs, node, &mut ctx);
    }
    merge_same_names(&mut top);
    // Resolve media and links now that every page has its id.
    let page_paths: HashMap<String, PathBuf> = ctx
        .pages
        .iter()
        .map(|(p, id)| (id.clone(), p.clone()))
        .collect();
    fn visit_ids(nodes: &mut [Node], ctx: &mut Ctx, page_paths: &HashMap<String, PathBuf>) {
        for n in nodes {
            if let Source::Doc { blocks, page_id } = &mut n.source {
                if let Some(p) = page_paths.get(page_id.as_str()) {
                    let dir = p.parent().unwrap_or(&ctx.root).to_path_buf();
                    resolve(blocks, &mut FsResolver { dir, ctx });
                }
            }
            visit_ids(&mut n.children, ctx, page_paths);
        }
    }
    visit_ids(&mut top, &mut ctx, &page_paths);
    // A PDF that no document shows becomes a page of its own.
    for (path, dirs) in pdfs {
        if ctx.assets.contains_key(&*path.to_string_lossy()) {
            continue;
        }
        let (title, id) = notion::names::split_id(&stem(&path));
        let title = if id.is_some() && !title.is_empty() {
            title
        } else {
            stem(&path)
        };
        if let Some(node) = pdf_node(&path, title, &mut ctx) {
            place(&mut top, &dirs, node, &mut ctx);
        }
    }
    Ok(staged(top, ctx, None))
}

/// Stages files picked one by one.
pub fn stage_files(paths: Vec<PathBuf>) -> AppResult<Staged> {
    if paths.is_empty() {
        return bad("no files were chosen");
    }
    if paths.iter().any(|p| kind_of(p) == Some("archive")) {
        if paths.len() > 1 {
            return bad("import a zip file on its own");
        }
        return stage_zip(&paths[0]);
    }
    let root = paths[0].parent().map(Path::to_path_buf).unwrap_or_default();
    let mut files = Vec::new();
    for p in paths {
        if !p.is_file() {
            return bad(format!("{} is not a file", display(&p)));
        }
        files.push(p);
    }
    if let Some(s) = notion::stage_files(&files)? {
        return Ok(s);
    }
    // Files picked from different folders can each use their own neighbours as assets.
    collect_multi(files.into_iter().map(|p| (p, vec![])).collect(), root)
}

fn collect_multi(files: Vec<(PathBuf, Vec<String>)>, root: PathBuf) -> AppResult<Staged> {
    let same_dir = files.iter().all(|(p, _)| p.parent() == files[0].0.parent());
    if same_dir {
        return collect(files, root);
    }
    // Different folders: use the nearest common ancestor so every file's neighbours are in reach.
    let mut common: PathBuf = files[0]
        .0
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    for (p, _) in &files {
        while !p.starts_with(&common) {
            if !common.pop() {
                break;
            }
        }
    }
    collect(files, common)
}

/// Stages a folder, keeping its structure.
pub fn stage_folder(dir: PathBuf) -> AppResult<Staged> {
    if !dir.is_dir() {
        return bad("that is not a folder");
    }
    let root = dir.canonicalize()?;
    if let Some(s) = notion::stage_folder(&root)? {
        return Ok(s);
    }
    let mut scratch = Ctx::new(root.clone());
    let mut all = Vec::new();
    walk(&root, 0, &mut all, &mut scratch);
    let files: Vec<(PathBuf, Vec<String>)> = all
        .into_iter()
        .filter(|p| matches!(kind_of(p), Some(k) if k != "archive") || is_pdf(p))
        .map(|p| {
            let rel = p.strip_prefix(&root).unwrap_or(&p);
            let dirs: Vec<String> = rel
                .parent()
                .map(|d| {
                    d.components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            (p, dirs)
        })
        .collect();
    let mut s = collect(files, root)?;
    s.warnings.splice(0..0, scratch.warnings);
    Ok(s)
}

/// Stages a zip: a Suivelle archive as itself, anything else (a Notion export, a zip of notes)
/// by unpacking it and staging the folder.
pub fn stage_zip(path: &Path) -> AppResult<Staged> {
    if unzip::is_suivelle_archive(path) {
        return stage_archive(path);
    }
    let (dir, left_out) = unzip::extract(path)?;
    let mut s = stage_folder(dir.path().to_path_buf())?;
    s.warnings.splice(0..0, left_out);
    if let Some(o) = &mut s.origin {
        if o.name.trim().is_empty() {
            o.name = stem(path);
        }
    }
    s.temp = Some(dir);
    Ok(s)
}

pub fn stage_archive(path: &Path) -> AppResult<Staged> {
    let mut a = Archive::open(path)?;
    let info = a.info()?;
    let mut ctx = Ctx::new(PathBuf::new());
    ctx.bytes = std::fs::metadata(path)?.len();
    let mut s = staged(vec![], ctx, None);
    s.archive = Some((path.to_path_buf(), info));
    Ok(s)
}

pub fn stage_workspace_archive(path: &Path) -> AppResult<Staged> {
    Archive::open(path)?.validate()?;
    stage_archive(path)
}

pub fn apply_workspace(
    conn: &mut Connection,
    store: &Path,
    staged: &Staged,
    name: &str,
    appearance: bool,
) -> AppResult<archive::WorkspaceImported> {
    let (path, _) = staged
        .archive
        .as_ref()
        .ok_or_else(|| AppError::Validation("Choose a Suivelle workspace archive.".into()))?;
    archive::import_workspace(conn, store, path, name, appearance)
}

// ---------------------------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------------------------

fn rows_text(rows: usize, cols: usize) -> String {
    format!(
        "{} row{}, {} column{}",
        rows,
        if rows == 1 { "" } else { "s" },
        cols,
        if cols == 1 { "" } else { "s" }
    )
}

fn flatten_entries(
    nodes: &[Node],
    depth: usize,
    out: &mut Vec<Entry>,
    totals: &mut (usize, usize, usize),
) {
    for n in nodes {
        let entry = |kind: &str, detail: String| Entry {
            index: n.index,
            name: n.title.clone(),
            kind: kind.into(),
            depth,
            detail,
            columns: None,
            truncated: false,
        };
        match &n.source {
            Source::Folder => out.push(entry("folder", "Folder".into())),
            Source::Doc { blocks, .. } => {
                totals.0 += 1;
                let mut count = 0;
                visit(blocks, &mut |_| count += 1);
                out.push(entry(
                    "page",
                    format!("{count} block{}", if count == 1 { "" } else { "s" }),
                ));
            }
            Source::Pdf { .. } => {
                totals.0 += 1;
                out.push(entry("page", "PDF".into()));
            }
            Source::Csv { csv, plan } => {
                totals.1 += 1;
                totals.2 += csv.rows.len();
                out.push(Entry {
                    columns: Some(plan.clone()),
                    truncated: csv.truncated,
                    ..entry("database", rows_text(csv.rows.len(), csv.headers.len()))
                });
            }
            Source::Database(db) => {
                totals.1 += 1;
                totals.2 += db.rows.len();
                let bodies = db.rows.iter().filter(|r| !r.body.is_empty()).count();
                let mut detail = rows_text(db.rows.len(), db.plan.len());
                if bodies > 0 {
                    detail.push_str(&format!(", {bodies} with page content"));
                }
                out.push(Entry {
                    columns: Some(db.plan.clone()),
                    truncated: db.truncated,
                    ..entry("database", detail)
                });
            }
        }
        flatten_entries(&n.children, depth + 1, out, totals);
    }
}

pub fn preview(s: &Staged) -> Preview {
    let mut entries = Vec::new();
    let mut totals = (0, 0, 0);
    flatten_entries(&s.nodes, 0, &mut entries, &mut totals);
    let mut warnings = s.warnings.clone();
    for e in entries.iter().filter(|e| e.truncated) {
        warnings.push(format!(
            "“{}” has more than {} rows; only the first {} are imported",
            e.name,
            csvio::MAX_ROWS,
            csvio::MAX_ROWS
        ));
    }
    let (mut pages, mut databases, mut records) = totals;
    let mut attachments = s.assets.len();
    if let Some((_, info)) = &s.archive {
        pages = info.counts.pages + info.counts.dashboards;
        databases = info.counts.databases;
        records = info.counts.records;
        attachments = info.counts.attachments;
    }
    Preview {
        id: s.id.clone(),
        entries,
        pages,
        databases,
        records,
        attachments,
        bytes: s.bytes,
        warnings,
        archive: s.archive.as_ref().map(|(_, i)| i.clone()),
        origin: s.origin.clone(),
    }
}

// ---------------------------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------------------------

const TONES: [&str; 6] = ["gray", "violet", "blue", "green", "orange", "red"];

/// A relation column waiting for every database to exist.
struct RelJob<'a> {
    database: String,
    name: String,
    target: String,
    /// (row placeholder, related row placeholders)
    links: &'a [(String, Vec<String>)],
}

struct Run<'a> {
    tx: &'a Connection,
    ws: &'a str,
    stored: HashMap<String, (String, u64)>,
    overrides: &'a HashMap<usize, Vec<String>>,
    result: ImportResult,
    /// The id a page was planned with → the id it was created with (databases and records get
    /// theirs from the database service).
    ids: HashMap<String, String>,
    /// planned database page id → database id
    databases: HashMap<String, String>,
    /// planned row page id → record id
    records: HashMap<String, String>,
    /// Page contents, written last so every link can point at its final page.
    bodies: Vec<(String, Vec<Blk>)>,
    relations: Vec<RelJob<'a>>,
}

impl<'a> Run<'a> {
    fn warn(&mut self, m: String) {
        if self.result.warnings.len() < 80 && !self.result.warnings.contains(&m) {
            self.result.warnings.push(m);
        }
    }

    /// Stores an imported file as an attachment of the workspace.
    fn attach(&mut self, key: &str, name: &str) -> Option<Value> {
        let (hash, size) = self.stored.get(key)?.clone();
        let mime = files::mime_for(name);
        let a = files::insert_attachment_in(self.tx, self.ws, &hash, name, mime, size).ok()?;
        self.result.attachments += 1;
        Some(
            json!({ "id": a.id, "hash": a.hash, "name": a.original_name, "mime": a.mime_type, "size": a.size }),
        )
    }

    /// Sets a page's icon and cover from an import.
    fn appearance(
        &mut self,
        page_id: &str,
        icon: Option<&String>,
        cover: Option<&String>,
    ) -> AppResult<()> {
        if icon.is_none() && cover.is_none() {
            return Ok(());
        }
        let Some(mut page) = crate::repositories::page::get(self.tx, page_id)? else {
            return Ok(());
        };
        let image = |run: &mut Self, key: &str| {
            let name = Path::new(key)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            run.attach(key, &name).and_then(|a| {
                a.get("hash")
                    .and_then(Value::as_str)
                    .map(|h| format!("image:{h}"))
            })
        };
        if let Some(i) = icon {
            page.icon = if self.stored.contains_key(i) {
                image(self, i)
            } else if i.chars().count() <= 16 && !i.chars().any(char::is_control) {
                Some(i.clone())
            } else {
                None
            };
        }
        if let Some(c) = cover {
            page.cover = image(self, c);
        }
        crate::repositories::page::update(self.tx, &page)?;
        Ok(())
    }

    fn page(&mut self, parent: Option<&str>, n: &Node, id: &str) -> AppResult<String> {
        let page = insert_page(
            self.tx,
            Some(id.to_string()),
            self.ws,
            parent,
            &n.title,
            None,
            "page",
            false,
        )?;
        self.ids.insert(id.to_string(), page.id.clone());
        self.appearance(&page.id, n.icon.as_ref(), n.cover.as_ref())?;
        self.result.pages += 1;
        Ok(page.id)
    }

    /// Creates a database and its records; returns its page id and the records, in row order.
    fn database(
        &mut self,
        parent: Option<&str>,
        n: &Node,
        plan: &[ColumnPlan],
        rows: &[&[String]],
        colors: Option<&HashMap<(usize, String), String>>,
    ) -> AppResult<(
        crate::databases::DatabaseDetail,
        Vec<crate::databases::RecordRow>,
    )> {
        let made = dbs::create_database_empty_in(
            self.tx,
            DatabaseCreate {
                workspace_id: self.ws.into(),
                parent_page_id: parent.map(String::from),
                title: Some(n.title.chars().take(500).collect()),
            },
            plan.first().map(|c| c.name.as_str()).unwrap_or("Name"),
        )?;
        let chosen: Vec<String> = self
            .overrides
            .get(&n.index)
            .cloned()
            .unwrap_or_else(|| plan.iter().map(|p| p.kind.clone()).collect());
        // (column, kind, property id, options by name)
        let mut cols: Vec<(usize, String, String, HashMap<String, String>)> = Vec::new();
        for (c, p) in plan.iter().enumerate().skip(1) {
            let mut kind = chosen.get(c).cloned().unwrap_or_else(|| p.kind.clone());
            if kind == "skip" || kind == "relation" {
                continue; // relations are added once every database exists
            }
            if !csvio::KINDS.contains(&kind.as_str()) && kind != "status" {
                kind = "text".into();
            }
            let mut options: HashMap<String, String> = HashMap::new();
            let mut config = None;
            if matches!(kind.as_str(), "select" | "multi_select" | "status") {
                let mut names: Vec<String> = Vec::new();
                for r in rows {
                    let cell = r[c].trim();
                    let parts: Vec<&str> = if kind == "multi_select" {
                        cell.split(',').map(str::trim).collect()
                    } else {
                        vec![cell]
                    };
                    for part in parts.into_iter().filter(|s| !s.is_empty()) {
                        let part: String = part.chars().take(60).collect();
                        if !names
                            .iter()
                            .any(|n| n.to_lowercase() == part.to_lowercase())
                        {
                            names.push(part);
                        }
                    }
                }
                if names.len() > MAX_OPTIONS {
                    self.warn(format!("“{}” has more than {MAX_OPTIONS} different values, so it was imported as text", p.name));
                    kind = "text".into();
                } else {
                    let list: Vec<Value> = names
                        .iter()
                        .enumerate()
                        .map(|(i, name)| {
                            let id = new_id();
                            options.insert(name.to_lowercase(), id.clone());
                            let color = colors
                                .and_then(|m| m.get(&(c, name.clone())))
                                .cloned()
                                .unwrap_or_else(|| TONES[i % TONES.len()].to_string());
                            let mut o = json!({ "id": id, "name": name, "color": color });
                            if kind == "status" {
                                o["group"] = json!(notion::names::status_group(name));
                            }
                            o
                        })
                        .collect();
                    config = Some(json!({ "options": list }));
                }
            }
            match dbs::add_property_in(
                self.tx,
                PropertyCreate {
                    database_id: made.database.id.clone(),
                    name: p.name.clone(),
                    property_type: kind.clone(),
                    config,
                },
            ) {
                Ok(prop) => cols.push((c, kind, prop.id, options)),
                Err(e) => self.warn(format!("The column “{}” was skipped: {e}", p.name)),
            }
        }
        let mut skipped = 0usize;
        let mut made_rows = Vec::with_capacity(rows.len());
        for row in rows {
            let mut values = Map::new();
            for (c, kind, pid, options) in &cols {
                let cell = row[*c].as_str();
                let key = |s: &str| s.trim().chars().take(60).collect::<String>().to_lowercase();
                let v = match kind.as_str() {
                    "select" | "status" => options.get(&key(cell)).map(|id| json!(id)),
                    "multi_select" => {
                        let ids: Vec<Value> = cell
                            .split(',')
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .filter_map(|s| options.get(&key(s)).map(|id| json!(id)))
                            .collect();
                        (!ids.is_empty()).then_some(Value::Array(ids))
                    }
                    "date" => {
                        notion::names::date_value(cell).or_else(|| csvio::cell_value("date", cell))
                    }
                    "number" => notion::names::number(cell).map(|n| json!(n)),
                    "text" => (!cell.trim().is_empty()).then(|| {
                        json!(cell
                            .chars()
                            .take(crate::databases::values::MAX_TEXT)
                            .collect::<String>())
                    }),
                    k => csvio::cell_value(k, cell),
                };
                match v {
                    Some(v) => {
                        values.insert(pid.clone(), v);
                    }
                    None if !cell.trim().is_empty() && !matches!(kind.as_str(), "checkbox") => {
                        skipped += 1
                    }
                    None => {}
                }
            }
            let title: String = row[0].trim().chars().take(500).collect();
            let made_row = match dbs::create_record_in(
                self.tx,
                RecordCreate {
                    database_id: made.database.id.clone(),
                    title: Some(title.clone()),
                    values: values.clone(),
                    template_id: None,
                },
            ) {
                Ok(r) => r,
                Err(_) => {
                    skipped += values.len();
                    dbs::create_record_in(
                        self.tx,
                        RecordCreate {
                            database_id: made.database.id.clone(),
                            title: Some(title),
                            values: Map::new(),
                            template_id: None,
                        },
                    )?
                }
            };
            made_rows.push(made_row);
            self.result.records += 1;
        }
        if skipped > 0 {
            self.warn(format!(
                "“{}”: {skipped} cell{} did not fit its column type and {} left empty",
                n.title,
                if skipped == 1 { "" } else { "s" },
                if skipped == 1 { "was" } else { "were" }
            ));
        }
        self.result.databases += 1;
        Ok((made, made_rows))
    }

    fn notion_database(
        &mut self,
        parent: Option<&str>,
        n: &Node,
        db: &'a notion::DbModel,
    ) -> AppResult<String> {
        let rows: Vec<&[String]> = db.rows.iter().map(|r| r.cells.as_slice()).collect();
        let (made, records) = self.database(parent, n, &db.plan, &rows, Some(&db.colors))?;
        self.ids.insert(db.id.clone(), made.page.id.clone());
        self.databases
            .insert(db.id.clone(), made.database.id.clone());
        self.appearance(&made.page.id, n.icon.as_ref(), n.cover.as_ref())?;
        for (row, record) in db.rows.iter().zip(records) {
            self.ids.insert(row.id.clone(), record.page_id.clone());
            self.records.insert(row.id.clone(), record.id.clone());
            self.appearance(&record.page_id, row.icon.as_ref(), row.cover.as_ref())?;
            if !row.body.is_empty() {
                self.bodies.push((record.page_id.clone(), row.body.clone()));
            }
        }
        let chosen = self.overrides.get(&n.index);
        for (c, rel) in db.relations.iter() {
            let kind = chosen
                .and_then(|k| k.get(*c))
                .map(String::as_str)
                .unwrap_or("relation");
            if kind == "relation" {
                self.relations.push(RelJob {
                    database: db.id.clone(),
                    name: db.plan[*c].name.clone(),
                    target: rel.target.clone(),
                    links: &rel.links,
                });
            }
        }
        Ok(made.page.id)
    }

    fn node(&mut self, parent: Option<&str>, n: &'a Node) -> AppResult<String> {
        let id = match &n.source {
            Source::Folder => self.page(parent, n, &new_id())?,
            Source::Doc { blocks, page_id } => {
                let id = self.page(parent, n, page_id)?;
                self.bodies.push((id.clone(), blocks.clone()));
                id
            }
            Source::Pdf { page_id, key, name } => {
                let id = self.page(parent, n, page_id)?;
                let mut b = Blk::new("pdf");
                b.media = Some(Media {
                    src: Some(key.clone()),
                    name: name.clone(),
                    attachment: None,
                    presentation: Value::Null,
                });
                self.bodies.push((id.clone(), vec![b]));
                id
            }
            Source::Csv { csv, plan } => {
                let rows: Vec<&[String]> = csv.rows.iter().map(Vec::as_slice).collect();
                self.database(parent, n, plan, &rows, None)?.0.page.id
            }
            Source::Database(db) => self.notion_database(parent, n, db)?,
        };
        let holder = if matches!(n.source, Source::Csv { .. } | Source::Database(_)) {
            // A database cannot hold pages; anything that was nested under it goes beside it.
            parent.map(String::from)
        } else {
            Some(id.clone())
        };
        for c in &n.children {
            self.node(holder.as_deref(), c)?;
        }
        Ok(id)
    }

    /// Adds the relation columns, pairing a column with its mirror in the other database into one
    /// two-way relation.
    fn relations(&mut self) -> AppResult<()> {
        let jobs = std::mem::take(&mut self.relations);
        let pairs = |j: &RelJob| -> HashSet<(String, String)> {
            j.links
                .iter()
                .flat_map(|(row, to)| to.iter().map(move |t| (row.clone(), t.clone())))
                .collect()
        };
        let mut used = vec![false; jobs.len()];
        for i in 0..jobs.len() {
            if used[i] {
                continue;
            }
            used[i] = true;
            let job = &jobs[i];
            let (Some(db), Some(target)) = (
                self.databases.get(&job.database).cloned(),
                self.databases.get(&job.target).cloned(),
            ) else {
                self.warn(format!(
                    "The relation “{}” points to a database that is not in this import; it was imported as text",
                    job.name
                ));
                self.relation_as_text(job)?;
                continue;
            };
            let mine = pairs(job);
            let mirror = (0..jobs.len()).find(|k| {
                !used[*k]
                    && jobs[*k].database == job.target
                    && jobs[*k].target == job.database
                    && job.database != job.target
                    && pairs(&jobs[*k])
                        .into_iter()
                        .map(|(a, b)| (b, a))
                        .collect::<HashSet<_>>()
                        == mine
            });
            if let Some(k) = mirror {
                used[k] = true;
            }
            let prop = match dbs::add_property_in(
                self.tx,
                PropertyCreate {
                    database_id: db,
                    name: job.name.clone(),
                    property_type: "relation".into(),
                    config: Some(json!({
                        "targetDatabaseId": target,
                        "twoWay": mirror.is_some(),
                        "reverseName": mirror.map(|k| jobs[k].name.clone()),
                    })),
                },
            ) {
                Ok(p) => p,
                Err(e) => {
                    self.warn(format!("The relation “{}” was skipped: {e}", job.name));
                    continue;
                }
            };
            let mut lost = 0usize;
            for (row, to) in job.links {
                let Some(record) = self.records.get(row).cloned() else {
                    continue;
                };
                let mut ids: Vec<String> = Vec::new();
                for t in to {
                    if let Some(r) = self.records.get(t).filter(|r| **r != record) {
                        if !ids.contains(r) {
                            ids.push(r.clone());
                        }
                    }
                }
                ids.truncate(crate::databases::MAX_RELATION_LINKS);
                lost += to.len().saturating_sub(ids.len());
                if ids.is_empty() {
                    continue;
                }
                let n = ids.len();
                if dbs::set_value_in(
                    self.tx,
                    SetValue {
                        record_id: record,
                        property_id: prop.id.clone(),
                        value: json!(ids),
                    },
                )
                .is_err()
                {
                    lost += n;
                }
            }
            if lost > 0 {
                self.warn(format!(
                    "“{}”: {lost} link{} could not be made (the records are not in this import) and {} left out",
                    job.name,
                    if lost == 1 { "" } else { "s" },
                    if lost == 1 { "was" } else { "were" }
                ));
            }
        }
        Ok(())
    }

    /// A relation whose database is missing keeps the titles of what it linked to.
    fn relation_as_text(&mut self, job: &RelJob) -> AppResult<()> {
        let Some(db) = self.databases.get(&job.database).cloned() else {
            return Ok(());
        };
        let Ok(prop) = dbs::add_property_in(
            self.tx,
            PropertyCreate {
                database_id: db,
                name: job.name.clone(),
                property_type: "text".into(),
                config: None,
            },
        ) else {
            return Ok(());
        };
        for (row, to) in job.links {
            let Some(record) = self.records.get(row).cloned() else {
                continue;
            };
            let titles: Vec<String> = to
                .iter()
                .filter_map(|t| self.ids.get(t))
                .filter_map(|p| crate::repositories::page::get(self.tx, p).ok().flatten())
                .map(|p| p.title)
                .collect();
            if !titles.is_empty() {
                let text: String = titles
                    .join(", ")
                    .chars()
                    .take(crate::databases::values::MAX_TEXT)
                    .collect();
                let _ = dbs::set_value_in(
                    self.tx,
                    SetValue {
                        record_id: record,
                        property_id: prop.id.clone(),
                        value: json!(text),
                    },
                );
            }
        }
        Ok(())
    }

    /// Points links, mentions and embeds at the pages as they were finally created.
    fn remap(&self, blocks: &mut [Blk]) {
        let ids = &self.ids;
        let fix_inline = |items: &mut Vec<Inline>| {
            for it in items.iter_mut() {
                match it {
                    Inline::Mention(id) => {
                        if let Some(n) = ids.get(id.as_str()) {
                            *id = n.clone();
                        }
                    }
                    Inline::Text { marks, .. } => {
                        for m in marks.iter_mut() {
                            if let Mark::Link(h) = m {
                                if let Some(n) = h
                                    .strip_prefix(INTERNAL_PAGE_LINK)
                                    .and_then(|id| ids.get(id))
                                {
                                    *h = format!("{INTERNAL_PAGE_LINK}{n}");
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        };
        visit_mut(blocks, &mut |b| {
            fix_inline(&mut b.inline);
            if let Some(t) = &mut b.table {
                for row in t.iter_mut() {
                    for cell in row.iter_mut() {
                        fix_inline(cell);
                    }
                }
            }
            if let Some(t) = &mut b.target {
                if let Some(n) = ids.get(t.as_str()) {
                    *t = n.clone();
                }
            }
            if let Some(m) = &mut b.media {
                if let Some(n) = m
                    .presentation
                    .get("link")
                    .and_then(Value::as_str)
                    .and_then(|h| h.strip_prefix(INTERNAL_PAGE_LINK))
                    .and_then(|id| ids.get(id))
                {
                    m.presentation["link"] = json!(format!("{INTERNAL_PAGE_LINK}{n}"));
                }
            }
        });
        // An embedded database or synced block that points nowhere would show an error.
        let known: HashSet<&String> = ids.values().collect();
        visit_mut(blocks, &mut |b| {
            if matches!(b.kind.as_str(), "database_view" | "synced_block")
                && !b.target.as_ref().is_some_and(|t| known.contains(t))
            {
                b.kind = "paragraph".into();
                if b.inline.is_empty() {
                    b.inline = vec![plain(if b.label.is_empty() {
                        "(embedded database)".to_string()
                    } else {
                        b.label.clone()
                    })];
                }
            }
        });
    }

    /// Stores the files media blocks show; a file that cannot be stored becomes its name in text.
    fn store_media(&mut self, blocks: &mut [Blk], missing: &mut Vec<String>) {
        for b in blocks.iter_mut() {
            if is_media(&b.kind) {
                if let Some(m) = b.media.as_mut() {
                    if m.attachment.is_none() {
                        let key = m.src.clone().unwrap_or_default();
                        m.attachment = self.attach(&key, &m.name.clone());
                    }
                    if m.attachment.is_none() {
                        let name = m.name.clone();
                        b.kind = "paragraph".into();
                        b.inline = vec![plain(format!("[{name}]"))];
                        missing.push(name);
                    }
                }
            }
            self.store_media(&mut b.children, missing);
        }
    }

    fn write_body(&mut self, page_id: &str, mut blocks: Vec<Blk>) -> AppResult<()> {
        self.remap(&mut blocks);
        let mut missing = Vec::new();
        self.store_media(&mut blocks, &mut missing);
        for name in missing {
            self.warn(format!(
                "The file “{name}” could not be stored and was left as text"
            ));
        }
        let mut upserts = flatten(&blocks);
        for u in upserts.iter_mut() {
            if u.data_json.len() > crate::domain::MAX_BLOCK_DATA_BYTES {
                u.data_json = json!({ "content": [{ "type": "text", "text": "(this block was too large to import)" }] }).to_string();
                u.block_type = "paragraph".into();
            }
        }
        let mut rest = upserts;
        while !rest.is_empty() {
            let tail = rest.split_off(rest.len().min(4000));
            crate::services::block::apply_batch_in(
                self.tx,
                &BlockBatch {
                    page_id: page_id.to_string(),
                    upserts: rest,
                    delete_ids: vec![],
                },
            )?;
            rest = tail;
        }
        Ok(())
    }
}

/// Creates everything in `staged` under a new "Imported" page, in one transaction.
pub fn apply(
    conn: &mut Connection,
    store_root: &Path,
    workspace_id: &str,
    staged: &Staged,
    overrides: &HashMap<usize, Vec<String>>,
) -> AppResult<ImportResult> {
    apply_in(
        conn,
        store_root,
        workspace_id,
        staged,
        overrides,
        false,
        &Target::Container,
    )
}

/// UI archive imports must be complete; document imports retain their explicit column/skip choices.
pub fn apply_checked(
    conn: &mut Connection,
    store_root: &Path,
    workspace_id: &str,
    staged: &Staged,
    overrides: &HashMap<usize, Vec<String>>,
    target: &Target,
) -> AppResult<ImportResult> {
    apply_in(
        conn,
        store_root,
        workspace_id,
        staged,
        overrides,
        staged.archive.is_some(),
        target,
    )
}

fn unique_workspace_name(tx: &Connection, name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    let base: String = if trimmed.is_empty() {
        "Imported workspace"
    } else {
        trimmed
    }
    .chars()
    .take(175)
    .collect();
    let names: HashSet<String> = crate::repositories::workspace::list(tx)?
        .into_iter()
        .map(|w| w.name.to_lowercase())
        .collect();
    let mut out = base.clone();
    let mut copy = 1;
    while names.contains(&out.to_lowercase()) {
        out = if copy == 1 {
            format!("{base} (imported)")
        } else {
            format!("{base} (imported {copy})")
        };
        copy += 1;
    }
    Ok(out)
}

fn apply_in(
    conn: &mut Connection,
    store_root: &Path,
    workspace_id: &str,
    staged: &Staged,
    overrides: &HashMap<usize, Vec<String>>,
    strict: bool,
    target: &Target,
) -> AppResult<ImportResult> {
    if !matches!(target, Target::Workspace { .. }) {
        crate::domain::validate_id(workspace_id, "workspace")?;
    }
    if strict {
        if let Some((path, _)) = &staged.archive {
            Archive::open(path)?.validate()?;
        }
    }
    // Files are copied into the store first: it is content-addressed, so a failure later leaves
    // at worst some unreferenced blobs, never a half-imported workspace.
    let mut stored: HashMap<String, (String, u64)> = HashMap::new();
    let mut early: Vec<String> = Vec::new();
    for path in staged.assets.keys() {
        match std::fs::File::open(path)
            .map_err(AppError::from)
            .and_then(|mut f| files::store_reader(store_root, &mut f, MAX_ATTACHMENT_BYTES))
        {
            Ok(v) => {
                stored.insert(path.clone(), v);
            }
            Err(e) => early.push(format!(
                "The file “{}” could not be stored: {e}",
                path.rsplit(['/', '\\']).next().unwrap_or(path)
            )),
        }
    }
    let tx = conn.transaction()?;
    let mut workspace = None;
    let (ws, parent): (String, Option<String>) = match target {
        Target::Container => {
            let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
            let title = match &staged.origin {
                Some(o) if o.kind == "notion" => format!("Imported from Notion {stamp}"),
                _ => format!("Imported {stamp}"),
            };
            let container =
                insert_page(&tx, None, workspace_id, None, &title, None, "page", false)?;
            (workspace_id.to_string(), Some(container.id))
        }
        Target::Page { page_id } => {
            crate::domain::validate_id(page_id, "page")?;
            let page = crate::repositories::page::get(&tx, page_id)?
                .filter(|p| p.deleted_at.is_none() && p.workspace_id == workspace_id)
                .ok_or_else(|| AppError::NotFound("page".into()))?;
            if page.kind != "page" {
                return bad("choose a page to import into (not a database or a record)");
            }
            (workspace_id.to_string(), Some(page.id))
        }
        Target::Workspace { name } => {
            if staged.archive.is_some() {
                return bad("import a Suivelle archive as a workspace from the workspace import");
            }
            let name = unique_workspace_name(&tx, name)?;
            crate::domain::validate_name(&name)?;
            let w = crate::services::workspace::create_in(
                &tx,
                crate::domain::WorkspaceCreate {
                    name,
                    icon: None,
                    settings_json: None,
                },
            )?;
            let id = w.id.clone();
            workspace = Some(w);
            (id, None)
        }
    };
    let mut run = Run {
        tx: &tx,
        ws: &ws,
        stored,
        overrides,
        result: ImportResult {
            page_id: parent.clone().unwrap_or_default(),
            pages: 0,
            databases: 0,
            records: 0,
            attachments: 0,
            warnings: staged.warnings.iter().cloned().chain(early).collect(),
            workspace: None,
        },
        ids: HashMap::new(),
        databases: HashMap::new(),
        records: HashMap::new(),
        bodies: Vec::new(),
        relations: Vec::new(),
    };
    if let Some((path, _)) = &staged.archive {
        let Some(parent) = &parent else {
            return bad("choose where to import the archive");
        };
        let mut a = Archive::open(path)?;
        let st = archive::apply(&tx, store_root, &ws, parent, &mut a)?;
        run.result.pages = st.pages + st.dashboards;
        run.result.databases = st.databases;
        run.result.records = st.records;
        run.result.attachments = st.attachments;
        run.result.warnings.extend(st.warnings);
    } else {
        for n in &staged.nodes {
            let id = run.node(parent.as_deref(), n)?;
            if run.result.page_id.is_empty() {
                run.result.page_id = id;
            }
        }
        run.relations()?;
        for (page, blocks) in std::mem::take(&mut run.bodies) {
            run.write_body(&page, blocks)?;
        }
    }
    let mut result = run.result;
    if strict && !result.warnings.is_empty() {
        return bad(format!(
            "The archive could not be imported completely: {}",
            result.warnings.join("; ")
        ));
    }
    if let Some(w) = workspace {
        result.workspace = crate::repositories::workspace::get(&tx, &w.id)?;
    }
    tx.commit()?;
    Ok(result)
}

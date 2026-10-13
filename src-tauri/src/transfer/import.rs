//! Importing files and folders: Markdown, text, HTML, CSV and Suivelle archives.
//!
//! Importing has two steps. `stage_*` reads and parses everything and keeps the result in memory
//! (nothing is written to the workspace and the frontend never sees a path); `apply` then creates
//! it all in one transaction under one new page, so a failure changes nothing and the result can
//! be trashed in one go.

use super::archive::{self, Archive};
use super::blocks::*;
use super::csvio::{self, ColumnPlan};
use super::{html, insert_page, markdown};
use crate::databases::service::{self as dbs};
use crate::databases::{DatabaseCreate, PropertyCreate, RecordCreate};
use crate::domain::{new_id, BlockBatch};
use crate::errors::{AppError, AppResult};
use crate::files::{self, MAX_ATTACHMENT_BYTES};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const MAX_FILES: usize = 2_000;
pub const MAX_DOC_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;
const MAX_DEPTH: usize = 12;
const MAX_OPTIONS: usize = 50;

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

enum Source {
    Doc {
        blocks: Vec<Blk>,
        page_id: String,
    },
    Csv {
        csv: csvio::Csv,
        plan: Vec<ColumnPlan>,
    },
    Folder,
}

struct Node {
    index: usize,
    title: String,
    source: Source,
    children: Vec<Node>,
}

pub struct Staged {
    pub id: String,
    nodes: Vec<Node>,
    archive: Option<(PathBuf, archive::Info)>,
    assets: HashMap<String, u64>,
    pub warnings: Vec<String>,
    bytes: u64,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// The page that holds everything that was imported.
    pub page_id: String,
    pub pages: usize,
    pub databases: usize,
    pub records: usize,
    pub attachments: usize,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------------------------

struct Ctx {
    root: PathBuf,
    counter: usize,
    bytes: u64,
    assets: HashMap<String, u64>,
    warnings: Vec<String>,
    /// canonical file path -> the page it will become
    pages: HashMap<PathBuf, String>,
}

impl Ctx {
    fn warn(&mut self, m: String) {
        if self.warnings.len() < 50 {
            self.warnings.push(m);
        }
    }
}

fn kind_of(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "md" | "markdown" | "mdown" => Some("markdown"),
        "txt" | "text" => Some("text"),
        "html" | "htm" | "xhtml" => Some("html"),
        "csv" | "tsv" => Some("csv"),
        "zip" => Some("archive"),
        _ => None,
    }
}

fn read_limited(path: &Path, ctx: &mut Ctx) -> AppResult<Vec<u8>> {
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

fn display(p: &Path) -> String {
    p.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("a file")
        .to_string()
}

fn stem(p: &Path) -> String {
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
        .map(str::trim_matches_newlines)
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

trait TrimNewlines {
    fn trim_matches_newlines(&self) -> &str;
}
impl TrimNewlines for str {
    fn trim_matches_newlines(&self) -> &str {
        self.trim_matches('\n')
    }
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_external(href: &str) -> bool {
    let l = href.trim().to_ascii_lowercase();
    crate::legacy::page_target(&l).is_some()
        || ["http://", "https://", "mailto:", "suivelle://", "tel:"]
            .iter()
            .any(|p| l.starts_with(p))
}

/// A path named by a document, if it points at an existing file inside the import's root.
fn local_file(href: &str, doc_dir: &Path, root: &Path) -> Option<PathBuf> {
    if href.is_empty() || is_external(href) || href.starts_with('#') || href.contains("://") {
        return None;
    }
    let clean = percent_decode(href.split(['#', '?']).next().unwrap_or(""));
    let joined = doc_dir.join(clean.replace('\\', "/"));
    let canon = joined.canonicalize().ok()?;
    (canon.starts_with(root) && canon.is_file()).then_some(canon)
}

fn mime_of(path: &Path) -> &'static str {
    files::mime_for(&display(path))
}

/// Turns standalone images and links to local files into media blocks, and rewrites or drops the
/// remaining relative links.
fn resolve(blocks: &mut [Blk], doc_dir: &Path, ctx: &mut Ctx) {
    let mut external_images = 0usize;
    resolve_in(blocks, doc_dir, ctx, &mut external_images);
    if external_images > 0 {
        ctx.warn(format!(
            "{external_images} image{} on the web {} kept as links (nothing is downloaded)",
            if external_images == 1 { "" } else { "s" },
            if external_images == 1 { "was" } else { "were" }
        ));
    }
}

fn resolve_in(blocks: &mut [Blk], doc_dir: &Path, ctx: &mut Ctx, external_images: &mut usize) {
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
                if let Some(path) = local_file(&src, doc_dir, &ctx.root) {
                    let is_doc = kind_of(&path).is_some_and(|k| k != "archive") && !is_image;
                    if !is_doc {
                        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                        let key = path.to_string_lossy().into_owned();
                        if size <= MAX_ATTACHMENT_BYTES
                            && (ctx.assets.contains_key(&key)
                                || ctx.bytes + size <= MAX_TOTAL_BYTES)
                        {
                            if ctx.assets.insert(key.clone(), size).is_none() {
                                ctx.bytes += size;
                            }
                            let name = if name.trim().is_empty() || is_image {
                                display(&path)
                            } else {
                                name
                            };
                            b.kind = media_kind(mime_of(&path)).into();
                            b.inline.clear();
                            let mut presentation = b
                                .media
                                .as_ref()
                                .map(|m| m.presentation.clone())
                                .unwrap_or(serde_json::Value::Null);
                            if let Some(href) = presentation
                                .get("link")
                                .and_then(serde_json::Value::as_str)
                                .map(String::from)
                            {
                                if !is_external(&href) {
                                    if let Some(id) = local_file(&href, doc_dir, &ctx.root)
                                        .and_then(|p| ctx.pages.get(&p))
                                    {
                                        presentation["link"] = serde_json::json!(format!(
                                            "{}{id}",
                                            crate::search::text::INTERNAL_PAGE_LINK
                                        ));
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
                } else if is_image && is_external(&src) {
                    *external_images += 1;
                }
            }
        }
        sanitize_inline(&mut b.inline, doc_dir, ctx);
        if let Some(t) = &mut b.table {
            for row in t.iter_mut() {
                for cell in row.iter_mut() {
                    sanitize_inline(cell, doc_dir, ctx);
                }
            }
        }
        resolve_in(&mut b.children, doc_dir, ctx, external_images);
    }
}

fn sanitize_inline(items: &mut [Inline], doc_dir: &Path, ctx: &Ctx) {
    for it in items.iter_mut() {
        match it {
            Inline::Text { marks, .. } => {
                let old = std::mem::take(marks);
                for m in old {
                    match m {
                        Mark::Link(h) if is_external(&h) => marks.push(Mark::Link(h)),
                        Mark::Link(h) => {
                            if let Some(path) = local_file(&h, doc_dir, &ctx.root) {
                                if let Some(id) = ctx.pages.get(&path) {
                                    marks.push(Mark::Link(format!(
                                        "{}{id}",
                                        crate::search::text::INTERNAL_PAGE_LINK
                                    )));
                                }
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
    ctx.counter += 1;
    Ok(Node {
        index: ctx.counter,
        title: title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| stem(path)),
        source: Source::Doc { blocks, page_id },
        children: vec![],
    })
}

fn csv_node(path: &Path, ctx: &mut Ctx) -> AppResult<Node> {
    let bytes = read_limited(path, ctx)?;
    let csv =
        csvio::read(&bytes).map_err(|e| AppError::Validation(format!("{}: {e}", display(path))))?;
    let plan = csvio::plan(&csv);
    ctx.counter += 1;
    Ok(Node {
        index: ctx.counter,
        title: stem(path),
        source: Source::Csv { csv, plan },
        children: vec![],
    })
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

fn staged(
    id: String,
    nodes: Vec<Node>,
    ctx: Ctx,
    archive: Option<(PathBuf, archive::Info)>,
) -> Staged {
    Staged {
        id,
        nodes,
        archive,
        assets: ctx.assets,
        warnings: ctx.warnings,
        bytes: ctx.bytes,
    }
}

fn collect(files: Vec<(PathBuf, Vec<String>)>, root: PathBuf) -> AppResult<Staged> {
    if files.len() > MAX_FILES {
        return bad(format!(
            "that is more than {MAX_FILES} files; import a smaller folder"
        ));
    }
    let root = root.canonicalize()?;
    let mut ctx = Ctx {
        root: root.clone(),
        counter: 0,
        bytes: 0,
        assets: HashMap::new(),
        warnings: vec![],
        pages: HashMap::new(),
    };
    let supported: Vec<(PathBuf, Vec<String>, &'static str)> = files
        .into_iter()
        .filter_map(|(p, dirs)| match kind_of(&p) {
            Some("archive") | None => None,
            Some(k) => Some((p.canonicalize().unwrap_or(p), dirs, k)),
        })
        .collect();
    if supported.is_empty() {
        return bad("there is nothing to import here: use Markdown, text, HTML or CSV files");
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
        let mut level = &mut top;
        for d in dirs {
            let pos = match level
                .iter()
                .position(|n| matches!(n.source, Source::Folder) && n.title == *d)
            {
                Some(p) => p,
                None => {
                    ctx.counter += 1;
                    level.push(Node {
                        index: ctx.counter,
                        title: d.clone(),
                        source: Source::Folder,
                        children: vec![],
                    });
                    level.len() - 1
                }
            };
            level = &mut level[pos].children;
        }
        level.push(node);
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
                    resolve(blocks, &dir, ctx);
                }
            }
            visit_ids(&mut n.children, ctx, page_paths);
        }
    }
    visit_ids(&mut top, &mut ctx, &page_paths);
    Ok(staged(new_id(), top, ctx, None))
}

/// Stages files picked one by one.
pub fn stage_files(paths: Vec<PathBuf>) -> AppResult<Staged> {
    if paths.is_empty() {
        return bad("no files were chosen");
    }
    if paths.iter().any(|p| kind_of(p) == Some("archive")) {
        if paths.len() > 1 {
            return bad("import a Suivelle archive on its own");
        }
        return stage_archive(&paths[0]);
    }
    let root = paths[0].parent().map(Path::to_path_buf).unwrap_or_default();
    let mut files = Vec::new();
    for p in paths {
        if !p.is_file() {
            return bad(format!("{} is not a file", display(&p)));
        }
        files.push((p, vec![]));
    }
    // Files picked from different folders can each use their own neighbours as assets.
    collect_multi(files, root)
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
    let mut scratch = Ctx {
        root: root.clone(),
        counter: 0,
        bytes: 0,
        assets: HashMap::new(),
        warnings: vec![],
        pages: HashMap::new(),
    };
    let mut all = Vec::new();
    walk(&root, 0, &mut all, &mut scratch);
    let files: Vec<(PathBuf, Vec<String>)> = all
        .into_iter()
        .filter(|p| matches!(kind_of(p), Some(k) if k != "archive"))
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

pub fn stage_archive(path: &Path) -> AppResult<Staged> {
    let mut a = Archive::open(path)?;
    let info = a.info()?;
    let ctx = Ctx {
        root: PathBuf::new(),
        counter: 0,
        bytes: std::fs::metadata(path)?.len(),
        assets: HashMap::new(),
        warnings: vec![],
        pages: HashMap::new(),
    };
    Ok(staged(
        new_id(),
        vec![],
        ctx,
        Some((path.to_path_buf(), info)),
    ))
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

fn flatten_entries(
    nodes: &[Node],
    depth: usize,
    out: &mut Vec<Entry>,
    totals: &mut (usize, usize, usize),
) {
    for n in nodes {
        match &n.source {
            Source::Folder => out.push(Entry {
                index: n.index,
                name: n.title.clone(),
                kind: "folder".into(),
                depth,
                detail: "Folder".into(),
                columns: None,
                truncated: false,
            }),
            Source::Doc { blocks, .. } => {
                totals.0 += 1;
                let mut count = 0;
                visit(blocks, &mut |_| count += 1);
                out.push(Entry {
                    index: n.index,
                    name: n.title.clone(),
                    kind: "page".into(),
                    depth,
                    detail: format!("{count} block{}", if count == 1 { "" } else { "s" }),
                    columns: None,
                    truncated: false,
                });
            }
            Source::Csv { csv, plan } => {
                totals.1 += 1;
                totals.2 += csv.rows.len();
                out.push(Entry {
                    index: n.index,
                    name: n.title.clone(),
                    kind: "database".into(),
                    depth,
                    detail: format!(
                        "{} row{}, {} column{}",
                        csv.rows.len(),
                        if csv.rows.len() == 1 { "" } else { "s" },
                        csv.headers.len(),
                        if csv.headers.len() == 1 { "" } else { "s" }
                    ),
                    columns: Some(plan.clone()),
                    truncated: csv.truncated,
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
    }
}

// ---------------------------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------------------------

const TONES: [&str; 6] = ["gray", "violet", "blue", "green", "orange", "red"];

struct Run<'a> {
    tx: &'a Connection,
    ws: &'a str,
    stored: HashMap<String, (String, u64)>,
    overrides: &'a HashMap<usize, Vec<String>>,
    result: ImportResult,
}

impl Run<'_> {
    fn warn(&mut self, m: String) {
        if self.result.warnings.len() < 50 {
            self.result.warnings.push(m);
        }
    }

    fn doc(&mut self, parent: &str, n: &Node, blocks: &[Blk], page_id: &str) -> AppResult<String> {
        let page = insert_page(
            self.tx,
            Some(page_id.to_string()),
            self.ws,
            Some(parent),
            &n.title,
            None,
            "page",
            false,
        )?;
        let mut blocks = blocks.to_vec();
        let mut missing = Vec::new();
        visit_mut(&mut blocks, &mut |b| {
            if !is_media(&b.kind) {
                return;
            }
            let Some(m) = b.media.as_mut() else { return };
            let key = m.src.clone().unwrap_or_default();
            match self.stored.get(&key) {
                Some((hash, size)) => {
                    let mime = files::mime_for(&m.name);
                    match files::insert_attachment_in(self.tx, self.ws, hash, &m.name, mime, *size)
                    {
                        Ok(a) => {
                            m.attachment = Some(
                                json!({ "id": a.id, "hash": a.hash, "name": a.original_name, "mime": a.mime_type, "size": a.size }),
                            );
                            self.result.attachments += 1;
                        }
                        Err(_) => missing.push(m.name.clone()),
                    }
                }
                None => missing.push(m.name.clone()),
            }
            if m.attachment.is_none() {
                b.kind = "paragraph".into();
                b.inline = vec![plain(format!("[{}]", m.name))];
            }
        });
        for name in missing {
            self.warn(format!(
                "The file “{name}” could not be stored and was left as text"
            ));
        }
        let mut upserts = flatten_blocks(&mut blocks);
        for u in upserts.iter_mut() {
            if u.data_json.len() > crate::domain::MAX_BLOCK_DATA_BYTES {
                u.data_json = json!({ "content": [{ "type": "text", "text": "(this block was too large to import)" }] }).to_string();
                u.block_type = "paragraph".into();
            }
        }
        for chunk in upserts.chunks(4000) {
            crate::services::block::apply_batch_in(
                self.tx,
                &BlockBatch {
                    page_id: page.id.clone(),
                    upserts: chunk.iter().map(clone_upsert).collect(),
                    delete_ids: vec![],
                },
            )?;
        }
        self.result.pages += 1;
        Ok(page.id)
    }

    fn csv(
        &mut self,
        parent: &str,
        n: &Node,
        csv: &csvio::Csv,
        plan: &[ColumnPlan],
    ) -> AppResult<String> {
        let made = dbs::create_database_empty_in(
            self.tx,
            DatabaseCreate {
                workspace_id: self.ws.into(),
                parent_page_id: Some(parent.into()),
                title: Some(n.title.chars().take(500).collect()),
            },
            &plan[0].name,
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
            if !csvio::KINDS.contains(&kind.as_str()) || kind == "skip" {
                continue;
            }
            let mut options: HashMap<String, String> = HashMap::new();
            let mut config = None;
            if kind == "select" || kind == "multi_select" {
                let mut names: Vec<String> = Vec::new();
                for r in &csv.rows {
                    let cell = r[c].trim();
                    let parts: Vec<&str> = if kind == "multi_select" {
                        cell.split(',').map(str::trim).collect()
                    } else {
                        vec![cell]
                    };
                    for part in parts.into_iter().filter(|s| !s.is_empty()) {
                        let part: String = part.chars().take(60).collect();
                        if !names.contains(&part) {
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
                            options.insert(name.clone(), id.clone());
                            json!({ "id": id, "name": name, "color": TONES[i % TONES.len()] })
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
        for row in &csv.rows {
            let mut values = Map::new();
            for (c, kind, pid, options) in &cols {
                let cell = row[*c].as_str();
                let v = match kind.as_str() {
                    "select" => options
                        .get(cell.trim().chars().take(60).collect::<String>().as_str())
                        .map(|id| json!(id)),
                    "multi_select" => {
                        let ids: Vec<Value> = cell
                            .split(',')
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .filter_map(|s| {
                                options
                                    .get(&s.chars().take(60).collect::<String>())
                                    .map(|id| json!(id))
                            })
                            .collect();
                        (!ids.is_empty()).then_some(Value::Array(ids))
                    }
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
            let made_row = dbs::create_record_in(
                self.tx,
                RecordCreate {
                    database_id: made.database.id.clone(),
                    title: Some(title.clone()),
                    values: values.clone(),
                    template_id: None,
                },
            );
            if made_row.is_err() {
                skipped += values.len();
                dbs::create_record_in(
                    self.tx,
                    RecordCreate {
                        database_id: made.database.id.clone(),
                        title: Some(title),
                        values: Map::new(),
                        template_id: None,
                    },
                )?;
            }
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
        Ok(made.page.id)
    }

    fn node(&mut self, parent: &str, n: &Node) -> AppResult<()> {
        let id = match &n.source {
            Source::Folder => {
                self.result.pages += 1;
                insert_page(
                    self.tx,
                    None,
                    self.ws,
                    Some(parent),
                    &n.title,
                    None,
                    "page",
                    false,
                )?
                .id
            }
            Source::Doc { blocks, page_id } => self.doc(parent, n, blocks, page_id)?,
            Source::Csv { csv, plan } => self.csv(parent, n, csv, plan)?,
        };
        if matches!(n.source, Source::Csv { .. }) && !n.children.is_empty() {
            // A database cannot hold pages; anything that was nested under it goes beside it.
            for c in &n.children {
                self.node(parent, c)?;
            }
            return Ok(());
        }
        for c in &n.children {
            self.node(&id, c)?;
        }
        Ok(())
    }
}

fn flatten_blocks(blocks: &mut [Blk]) -> Vec<crate::domain::BlockUpsert> {
    super::blocks::flatten(blocks)
}

fn clone_upsert(u: &crate::domain::BlockUpsert) -> crate::domain::BlockUpsert {
    crate::domain::BlockUpsert {
        id: u.id.clone(),
        parent_block_id: u.parent_block_id.clone(),
        block_type: u.block_type.clone(),
        position: u.position,
        data_json: u.data_json.clone(),
        schema_version: u.schema_version,
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
    apply_in(conn, store_root, workspace_id, staged, overrides, false)
}

/// UI archive imports must be complete; document imports retain their explicit column/skip choices.
pub fn apply_checked(
    conn: &mut Connection,
    store_root: &Path,
    workspace_id: &str,
    staged: &Staged,
    overrides: &HashMap<usize, Vec<String>>,
) -> AppResult<ImportResult> {
    if staged.archive.is_none() {
        return apply(conn, store_root, workspace_id, staged, overrides);
    }
    apply_in(conn, store_root, workspace_id, staged, overrides, true)
}

fn apply_in(
    conn: &mut Connection,
    store_root: &Path,
    workspace_id: &str,
    staged: &Staged,
    overrides: &HashMap<usize, Vec<String>>,
    strict: bool,
) -> AppResult<ImportResult> {
    crate::domain::validate_id(workspace_id, "workspace")?;
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
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    let tx = conn.transaction()?;
    let container = insert_page(
        &tx,
        None,
        workspace_id,
        None,
        &format!("Imported {stamp}"),
        None,
        "page",
        false,
    )?;
    let mut run = Run {
        tx: &tx,
        ws: workspace_id,
        stored,
        overrides,
        result: ImportResult {
            page_id: container.id.clone(),
            pages: 0,
            databases: 0,
            records: 0,
            attachments: 0,
            warnings: staged.warnings.iter().cloned().chain(early).collect(),
        },
    };
    if let Some((path, _)) = &staged.archive {
        let mut a = Archive::open(path)?;
        let st = archive::apply(&tx, store_root, workspace_id, &container.id, &mut a)?;
        run.result.pages = st.pages + st.dashboards;
        run.result.databases = st.databases;
        run.result.records = st.records;
        run.result.attachments = st.attachments;
        run.result.warnings.extend(st.warnings);
    } else {
        for n in &staged.nodes {
            run.node(&container.id, n)?;
        }
    }
    let result = run.result;
    if strict && !result.warnings.is_empty() {
        return bad(format!(
            "The archive could not be imported completely: {}",
            result.warnings.join("; ")
        ));
    }
    tx.commit()?;
    Ok(result)
}

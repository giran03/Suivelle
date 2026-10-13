//! Notion exports: Markdown & CSV, HTML, and PDF, as a zip (unpacked by the caller), a folder, or
//! loose files. Recognized by Notion's 32-character ids in file names or by its HTML, and rebuilt
//! as pages, databases with typed columns, records with their own content, and relations.
//!
//! Notion's ids are the key throughout: a page's subpages are in the folder named with the page's
//! id, links name the id of the page they lead to, and relation cells name the ids of the rows
//! they link. Titles are only used where Notion wrote nothing else (a CSV row and its page).
//! When the export was made without "Create folders for subpages", a page's parent is the page
//! that links to it.

pub mod names;

mod database;
pub(crate) mod html;
mod md;
#[cfg(test)]
mod tests;

pub use database::{DbModel, RelCol, RowModel};

use super::blocks::*;
use super::csvio;
use super::import::{self, Ctx, Found, Node, Origin, Resolve, Source, Staged};
use crate::domain::new_id;
use crate::errors::{AppError, AppResult};
use crate::search::text::INTERNAL_PAGE_LINK;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

pub const MAX_FILES: usize = 25_000;
const MAX_DEPTH: usize = 40;
/// Relation cells name every related row's path, so they can be long.
const MAX_CELL: usize = 200_000;

/// A parsed page.
#[derive(Debug, Default)]
pub struct Doc {
    pub title: Option<String>,
    /// An emoji, or `file:<href>` for a picture.
    pub icon: Option<String>,
    /// The cover picture's href.
    pub cover: Option<String>,
    pub blocks: Vec<Blk>,
    /// A database row's properties, as written on its page.
    pub props: Vec<(String, String)>,
    pub prop_kinds: Vec<String>,
    /// Database tables on the page (HTML export).
    pub collections: Vec<html::Collection>,
    /// The page is a database's own page: nothing but its table.
    pub collection_page: bool,
    /// The page had colours or highlights, which are not imported.
    pub lossy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Markdown,
    Html,
    Csv,
    Pdf,
}

fn kind(path: &Path) -> Option<Kind> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "md" | "markdown" => Some(Kind::Markdown),
        "html" | "htm" => Some(Kind::Html),
        "csv" => Some(Kind::Csv),
        "pdf" => Some(Kind::Pdf),
        _ => None,
    }
}

/// One page, database or PDF of the export.
struct Ent {
    kind: Kind,
    path: PathBuf,
    dir: Vec<String>,
    title: String,
    nid: Option<String>,
    /// The id its page is planned with.
    id: String,
    parent: Option<usize>,
    doc: Option<Doc>,
    csv: Option<csvio::Csv>,
    db: Option<DbModel>,
    /// For a row's page: the database it belongs to.
    row_of: Option<usize>,
    /// Columns typed by the HTML export (they are not inferred again).
    typed: bool,
}

impl Ent {
    fn new(kind: Kind, path: PathBuf, dir: Vec<String>, title: String, nid: Option<String>) -> Ent {
        Ent {
            kind,
            path,
            dir,
            title,
            nid,
            id: new_id(),
            parent: None,
            doc: None,
            csv: None,
            db: None,
            row_of: None,
            typed: false,
        }
    }

    fn name(&self) -> String {
        let t = self
            .doc
            .as_ref()
            .and_then(|d| d.title.clone())
            .unwrap_or_else(|| self.title.clone());
        if t.trim().is_empty() {
            "Untitled".into()
        } else {
            t
        }
    }
}

fn stem_of(p: &Path) -> String {
    p.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------------------------

fn head(path: &Path) -> String {
    let mut buf = Vec::new();
    if let Ok(f) = std::fs::File::open(path) {
        let _ = f.take(256 * 1024).read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Whether these files look like a Notion export.
pub fn detect(files: &[PathBuf]) -> bool {
    let docs: Vec<&PathBuf> = files
        .iter()
        .filter(|p| matches!(kind(p), Some(Kind::Markdown | Kind::Html | Kind::Csv)))
        .collect();
    if docs.is_empty() {
        return false;
    }
    let with_id = docs
        .iter()
        .filter(|p| names::split_id(names::csv_stem(&stem_of(p)).0).1.is_some())
        .count();
    if with_id > 0 && with_id * 2 >= docs.len() {
        return true;
    }
    docs.iter()
        .filter(|p| kind(p) == Some(Kind::Html))
        .take(10)
        .any(|p| html::is_notion(&head(p)))
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH || out.len() > MAX_FILES {
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
        if name.starts_with('.') || t.is_symlink() || name == "__MACOSX" {
            continue;
        }
        if t.is_dir() {
            walk(&e.path(), depth + 1, out);
        } else if t.is_file() {
            out.push(e.path());
        }
    }
}

/// Stages a folder if it is a Notion export.
pub fn stage_folder(root: &Path) -> AppResult<Option<Staged>> {
    let mut files = Vec::new();
    walk(root, 0, &mut files);
    if !detect(&files) {
        return Ok(None);
    }
    if files.len() > MAX_FILES {
        return Err(AppError::Validation(format!(
            "this export has more than {MAX_FILES} files; export a smaller part of the workspace at a time"
        )));
    }
    stage(root, files).map(Some)
}

/// Stages files picked one by one if they are from a Notion export.
pub fn stage_files(files: &[PathBuf]) -> AppResult<Option<Staged>> {
    if !detect(files) {
        return Ok(None);
    }
    let mut root = files[0].parent().map(Path::to_path_buf).unwrap_or_default();
    for p in files {
        while !p.starts_with(&root) {
            if !root.pop() {
                break;
            }
        }
    }
    let root = root.canonicalize()?;
    stage(&root, files.to_vec()).map(Some)
}

// ---------------------------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------------------------

struct NotionResolver<'a> {
    dir: PathBuf,
    ctx: &'a mut Ctx,
    by_nid: &'a HashMap<String, String>,
    by_path: &'a HashMap<PathBuf, String>,
}

impl Resolve for NotionResolver<'_> {
    fn find(&mut self, href: &str, media: Option<bool>) -> Found {
        if media != Some(true) {
            if let Some(id) = names::id_in_href(href).and_then(|n| self.by_nid.get(&n)) {
                return Found::Page(id.clone());
            }
        }
        let Some(path) = import::local_file(href, &self.dir, &self.ctx.root) else {
            return Found::Nothing;
        };
        if let Some(id) = self.by_path.get(&path) {
            if media != Some(true) {
                return Found::Page(id.clone());
            }
        }
        let is_doc = matches!(kind(&path), Some(Kind::Markdown | Kind::Html | Kind::Csv));
        if media.is_some() && !is_doc {
            return match self.ctx.add_asset(&path) {
                Some(key) => Found::Asset {
                    key,
                    name: import::display(&path),
                },
                None => Found::Nothing,
            };
        }
        Found::Nothing
    }

    fn warn(&mut self, m: String) {
        self.ctx.warn(m);
    }
}

/// The page links that stand alone on a line: Notion's subpage and link-to-page blocks.
fn solo_links(blocks: &[Blk]) -> Vec<String> {
    let mut out = Vec::new();
    for b in blocks {
        if b.kind != "paragraph" {
            continue;
        }
        if let [Inline::Text { marks, .. }] = b.inline.as_slice() {
            for m in marks {
                if let Mark::Link(h) = m {
                    out.push(h.clone());
                }
            }
        }
    }
    out
}

/// Links to imported pages that are mentions in Notion become mentions again: a paragraph that is
/// only a link to a page (a subpage or link-to-page block), and a link whose text is the page's
/// title (an inline mention).
fn mentions(blocks: &mut [Blk], titles: &HashMap<String, String>) {
    let target = |marks: &[Mark]| -> Option<String> {
        marks.iter().find_map(|m| match m {
            Mark::Link(h) => h
                .strip_prefix(INTERNAL_PAGE_LINK)
                .filter(|id| titles.contains_key(*id))
                .map(String::from),
            _ => None,
        })
    };
    visit_mut(blocks, &mut |b| {
        if b.kind == "paragraph" {
            if let [Inline::Text { marks, .. }] = b.inline.as_slice() {
                if let Some(id) = target(marks) {
                    b.inline = vec![Inline::Mention(id)];
                    return;
                }
            }
        }
        for it in b.inline.iter_mut() {
            if let Inline::Text { text, marks } = it {
                if marks.len() == 1 {
                    if let Some(id) = target(marks) {
                        if titles[&id].trim() == text.trim() && !text.trim().is_empty() {
                            *it = Inline::Mention(id);
                        }
                    }
                }
            }
        }
    });
}

struct Stage {
    root: PathBuf,
    ctx: Ctx,
    ents: Vec<Ent>,
    /// planned page id → entity
    by_id: HashMap<String, usize>,
}

impl Stage {
    fn rel_dir(&self, p: &Path) -> Vec<String> {
        p.strip_prefix(&self.root)
            .ok()
            .and_then(Path::parent)
            .map(|d| {
                d.components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn collect(&mut self, files: Vec<PathBuf>) {
        let mut csv_by_key: HashMap<String, usize> = HashMap::new();
        for p in files {
            let Some(k) = kind(&p) else { continue };
            let p = p.canonicalize().unwrap_or(p);
            let dir = self.rel_dir(&p);
            let stem = stem_of(&p);
            if k == Kind::Csv {
                let (base, all) = names::csv_stem(&stem);
                let (title, nid) = names::split_id(base);
                let key = nid
                    .clone()
                    .unwrap_or_else(|| format!("{}/{base}", dir.join("/")));
                match csv_by_key.get(&key) {
                    Some(&i) => {
                        // Notion writes the current view and every row: the full file wins.
                        if all {
                            self.ents[i].path = p;
                        }
                    }
                    None => {
                        csv_by_key.insert(key, self.ents.len());
                        self.ents.push(Ent::new(k, p, dir, title, nid));
                    }
                }
            } else {
                let (title, nid) = names::split_id(&stem);
                self.ents.push(Ent::new(k, p, dir, title, nid));
            }
        }
    }

    /// Pairs each file with the page whose folder it is in.
    fn folder_parents(&mut self) {
        let mut by_nid: HashMap<String, usize> = HashMap::new();
        let mut by_name: HashMap<(Vec<String>, String), usize> = HashMap::new();
        for (i, e) in self.ents.iter().enumerate() {
            if let Some(n) = &e.nid {
                by_nid.entry(n.clone()).or_insert(i);
            }
            let stem = stem_of(&e.path);
            by_name
                .entry((e.dir.clone(), names::csv_stem(&stem).0.to_string()))
                .or_insert(i);
        }
        for i in 0..self.ents.len() {
            let dir = self.ents[i].dir.clone();
            let Some(last) = dir.last() else { continue };
            let up = dir[..dir.len() - 1].to_vec();
            let parent = by_name.get(&(up, last.clone())).copied().or_else(|| {
                names::split_id(last)
                    .1
                    .and_then(|n| by_nid.get(&n).copied())
            });
            if let Some(p) = parent.filter(|p| *p != i && self.ents[*p].kind != Kind::Pdf) {
                self.ents[i].parent = Some(p);
            }
        }
    }

    fn read_csvs(&mut self) -> AppResult<()> {
        for i in 0..self.ents.len() {
            if self.ents[i].kind != Kind::Csv {
                continue;
            }
            let path = self.ents[i].path.clone();
            let bytes = import::read_limited(&path, &mut self.ctx)?;
            match csvio::read_with(&bytes, MAX_CELL) {
                Ok(csv) => self.ents[i].csv = Some(csv),
                Err(e) => self.ctx.warn(format!("{}: {e}", import::display(&path))),
            }
        }
        Ok(())
    }

    fn row_keys(&self, i: usize) -> Option<HashSet<String>> {
        let p = self.ents[i].parent?;
        let csv = self.ents[p].csv.as_ref()?;
        Some(csv.headers.iter().skip(1).cloned().collect())
    }

    fn parse_docs(&mut self) -> AppResult<()> {
        for i in 0..self.ents.len() {
            let k = self.ents[i].kind;
            if !matches!(k, Kind::Markdown | Kind::Html) {
                continue;
            }
            let path = self.ents[i].path.clone();
            let bytes = import::read_limited(&path, &mut self.ctx)?;
            let text = import::lossy(&bytes);
            let doc = if k == Kind::Markdown {
                md::parse(&text, self.row_keys(i).as_ref())
            } else {
                html::parse(&text)
            };
            if doc.lossy {
                self.ctx
                    .warn("Text colours and highlights were not imported".into());
            }
            self.ents[i].doc = Some(doc);
        }
        Ok(())
    }

    /// Database pages and inline tables of the HTML export become databases.
    fn html_databases(&mut self) {
        let mut by_nid: HashMap<String, usize> = HashMap::new();
        let mut by_path: HashMap<PathBuf, usize> = HashMap::new();
        for (i, e) in self.ents.iter().enumerate() {
            if let Some(n) = &e.nid {
                by_nid.entry(n.clone()).or_insert(i);
            }
            by_path.entry(e.path.clone()).or_insert(i);
        }
        let maps = (by_nid, by_path);
        for i in 0..self.ents.len() {
            let Some(doc) = self.ents[i].doc.as_mut() else {
                continue;
            };
            if doc.collections.is_empty() {
                continue;
            }
            let collections = std::mem::take(&mut doc.collections);
            if doc.collection_page {
                let c = collections.into_iter().next().expect("one table");
                let id = self.ents[i].id.clone();
                self.ents[i].db = Some(self.collection_model(&c, id, i, i, &maps));
                self.ents[i].typed = true;
                continue;
            }
            // Inline tables: a database below the page, shown where the table was.
            let mut ids = Vec::new();
            for c in collections {
                let mut e = Ent::new(
                    Kind::Html,
                    self.ents[i].path.clone(),
                    self.ents[i].dir.clone(),
                    if c.title.is_empty() {
                        "Database".into()
                    } else {
                        c.title.clone()
                    },
                    None,
                );
                e.parent = Some(i);
                e.typed = true;
                let owner = self.ents.len();
                let model = self.collection_model(&c, e.id.clone(), i, owner, &maps);
                e.db = Some(model);
                ids.push((e.id.clone(), e.title.clone()));
                self.ents.push(e);
            }
            if let Some(doc) = self.ents[i].doc.as_mut() {
                visit_mut(&mut doc.blocks, &mut |b| {
                    if let Some(n) = b
                        .label
                        .strip_prefix("notion-db:")
                        .and_then(|n| n.parse::<usize>().ok())
                    {
                        if let Some((id, title)) = ids.get(n) {
                            b.target = Some(id.clone());
                            b.label = title.clone();
                        }
                    }
                });
            }
        }
    }

    /// A database from an HTML table; its rows' pages are claimed by the ids in the row links.
    fn collection_model(
        &mut self,
        c: &html::Collection,
        id: String,
        page: usize,
        owner: usize,
        maps: &(HashMap<String, usize>, HashMap<PathBuf, usize>),
    ) -> DbModel {
        let dir = self.ents[page]
            .path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let mut model = DbModel {
            id,
            ..Default::default()
        };
        for (n, (name, notion)) in c.columns.iter().enumerate() {
            let (k, note) = database::kind_for(if n == 0 { "title" } else { notion });
            let cells: Vec<&str> = c
                .rows
                .iter()
                .map(|r| r.cells.get(n).map(String::as_str).unwrap_or(""))
                .collect();
            let name = if name.trim().is_empty() {
                format!("Column {}", n + 1)
            } else {
                name.clone()
            };
            model
                .plan
                .push(database::column(&name, k, note.map(String::from), &cells));
        }
        for r in &c.rows {
            for (col, name, color) in &r.colors {
                model
                    .colors
                    .insert((*col, name.clone()), names::tone(color).into());
            }
            let page_ent = r
                .href
                .as_ref()
                .and_then(|h| {
                    names::id_in_href(h)
                        .and_then(|n| maps.0.get(&n).copied())
                        .or_else(|| {
                            import::local_file(h, &dir, &self.root)
                                .and_then(|p| maps.1.get(&p).copied())
                        })
                })
                .filter(|&e| {
                    e != page && self.ents[e].row_of.is_none() && self.ents[e].db.is_none()
                });
            let row_id = match page_ent {
                Some(e) => {
                    self.ents[e].row_of = Some(owner);
                    self.ents[e].id.clone()
                }
                None => new_id(),
            };
            let mut cells = r.cells.clone();
            cells.resize(model.plan.len(), String::new());
            model.rows.push(RowModel {
                id: row_id,
                cells,
                ..Default::default()
            });
        }
        if model.rows.len() > csvio::MAX_ROWS {
            model.rows.truncate(csvio::MAX_ROWS);
            model.truncated = true;
        }
        model
    }

    /// Databases of the Markdown export: a CSV file, and its rows' pages matched by title.
    fn csv_databases(&mut self) {
        for i in 0..self.ents.len() {
            let Some(csv) = self.ents[i].csv.take() else {
                continue;
            };
            let mut model = DbModel {
                id: self.ents[i].id.clone(),
                truncated: csv.truncated,
                ..Default::default()
            };
            for (n, header) in csv.headers.iter().enumerate() {
                let cells: Vec<&str> = csv.rows.iter().map(|r| r[n].as_str()).collect();
                let k = if n == 0 {
                    "title"
                } else {
                    database::infer(header, &cells)
                };
                let note = (k == "relation").then(|| "Relation".to_string());
                model.plan.push(database::column(header, k, note, &cells));
            }
            // Row pages are in the database's folder, or (without folders) anywhere unclaimed.
            let by_title = |ents: &Vec<Ent>, f: &dyn Fn(&Ent) -> bool| {
                let mut m: HashMap<String, std::collections::VecDeque<usize>> = HashMap::new();
                for (e, ent) in ents.iter().enumerate() {
                    if ent.doc.is_some() && f(ent) {
                        m.entry(ent.name().trim().to_string())
                            .or_default()
                            .push_back(e);
                    }
                }
                m
            };
            let mut pages = by_title(&self.ents, &|e| e.parent == Some(i));
            let mut loose = by_title(&self.ents, &|e| e.parent.is_none() && e.row_of.is_none());
            for row in &csv.rows {
                let title = row[0].trim();
                let mut page = pages.get_mut(title).and_then(|q| q.pop_front());
                if page.is_none() && !title.is_empty() {
                    page = loose
                        .get_mut(title)
                        .and_then(|q| q.pop_front())
                        .filter(|&e| {
                            self.ents[e].row_of.is_none() && self.ents[e].parent.is_none()
                        });
                    if let Some(e) = page {
                        // A row page found outside its folder still lists its properties first.
                        let keys: HashSet<String> = csv.headers.iter().skip(1).cloned().collect();
                        if self.ents[e].kind == Kind::Markdown {
                            if let Ok(bytes) = std::fs::read(&self.ents[e].path) {
                                self.ents[e].doc =
                                    Some(md::parse(&import::lossy(&bytes), Some(&keys)));
                            }
                        }
                        self.ents[e].parent = Some(i);
                    }
                }
                let id = match page {
                    Some(e) => {
                        self.ents[e].row_of = Some(i);
                        self.ents[e].id.clone()
                    }
                    None => new_id(),
                };
                model.rows.push(RowModel {
                    id,
                    cells: row.clone(),
                    ..Default::default()
                });
            }
            self.ents[i].db = Some(model);
        }
    }

    /// Without folders for subpages, a page belongs to the first page that links to it.
    fn link_parents(&mut self) -> bool {
        let by_nid: HashMap<String, usize> = self
            .ents
            .iter()
            .enumerate()
            .filter_map(|(i, e)| e.nid.clone().map(|n| (n, i)))
            .collect();
        let mut claimed = false;
        let links: Vec<(usize, Vec<usize>)> = self
            .ents
            .iter()
            .enumerate()
            .filter_map(|(i, e)| {
                let doc = e.doc.as_ref()?;
                let targets: Vec<usize> = solo_links(&doc.blocks)
                    .iter()
                    .filter_map(|h| names::id_in_href(h))
                    .filter_map(|n| by_nid.get(&n).copied())
                    .collect();
                Some((i, targets))
            })
            .collect();
        for (from, targets) in links {
            for t in targets {
                if t == from || self.ents[t].parent.is_some() || self.ents[t].row_of.is_some() {
                    continue;
                }
                // Never make a page its own ancestor.
                let mut up = Some(from);
                let mut cycle = false;
                while let Some(u) = up {
                    if u == t {
                        cycle = true;
                        break;
                    }
                    up = self.ents[u].parent;
                }
                if !cycle {
                    self.ents[t].parent = Some(from);
                    claimed = true;
                }
            }
        }
        claimed
    }

    /// Resolves relation cells to rows, and gives each relation column its target database.
    fn relations(&mut self) {
        // Every row of every database: by Notion id, and by title within its database.
        let mut row_by_nid: HashMap<String, (usize, String)> = HashMap::new();
        let mut rows_by_title: HashMap<usize, HashMap<String, String>> = HashMap::new();
        for (d, e) in self.ents.iter().enumerate() {
            let Some(db) = &e.db else { continue };
            let titles = rows_by_title.entry(d).or_default();
            for r in &db.rows {
                titles
                    .entry(r.cells[0].trim().to_string())
                    .or_insert(r.id.clone());
            }
        }
        for e in self.ents.iter() {
            if let (Some(d), Some(n)) = (e.row_of, &e.nid) {
                row_by_nid.insert(n.clone(), (d, e.id.clone()));
            }
        }
        let db_ids: Vec<usize> = (0..self.ents.len())
            .filter(|&d| self.ents[d].db.is_some())
            .collect();
        for &d in &db_ids {
            let typed = self.ents[d].typed;
            let mut model = self.ents[d].db.take().expect("a database");
            for c in 1..model.plan.len() {
                let cells: Vec<String> = model.rows.iter().map(|r| r.cells[c].clone()).collect();
                let mut target: Option<usize> = None;
                let mut parsed: Vec<Vec<names::Link>> = Vec::new();
                if model.plan[c].kind == "relation" {
                    parsed = cells.iter().map(|c| names::links(c)).collect();
                    let mut votes: HashMap<usize, usize> = HashMap::new();
                    for l in parsed.iter().flatten() {
                        if let Some((db, _)) = l
                            .href
                            .as_ref()
                            .and_then(|h| names::id_in_href(h))
                            .and_then(|n| row_by_nid.get(&n))
                        {
                            *votes.entry(*db).or_default() += 1;
                        }
                    }
                    target = votes.into_iter().max_by_key(|(_, n)| *n).map(|(db, _)| db);
                    if target.is_none() {
                        // Fall back to the database that has rows with these titles.
                        target = db_ids.iter().copied().find(|t| {
                            let titles: HashSet<String> =
                                rows_by_title[t].keys().cloned().collect();
                            parsed.iter().flatten().next().is_some()
                                && parsed.iter().flatten().all(|l| titles.contains(&l.title))
                        });
                    }
                } else if !typed
                    && matches!(
                        model.plan[c].kind.as_str(),
                        "text" | "select" | "multi_select"
                    )
                {
                    // A relation exported without paths is a list of another database's titles.
                    let refs: Vec<&str> = cells.iter().map(String::as_str).collect();
                    let found: Vec<usize> = db_ids
                        .iter()
                        .copied()
                        .filter(|t| *t != d)
                        .filter(|t| {
                            let titles: HashSet<String> =
                                rows_by_title[t].keys().cloned().collect();
                            database::titles_column(&refs, &titles)
                        })
                        .collect();
                    if found.len() == 1 {
                        target = Some(found[0]);
                        parsed = cells.iter().map(|c| names::links(c)).collect();
                        model.plan[c].kind = "relation".into();
                        model.plan[c].note = Some("Relation".into());
                    }
                }
                if model.plan[c].kind != "relation" {
                    continue;
                }
                let Some(t) = target else {
                    model.plan[c].kind = "text".into();
                    model.plan[c].note =
                        Some("Relation to a database outside this export, as titles".into());
                    for (r, links) in model.rows.iter_mut().zip(&parsed) {
                        r.cells[c] = links
                            .iter()
                            .map(|l| l.title.clone())
                            .collect::<Vec<_>>()
                            .join(", ");
                    }
                    continue;
                };
                let mut rel = RelCol {
                    target: self.ents[t].id.clone(),
                    links: vec![],
                };
                for (r, links) in model.rows.iter_mut().zip(&parsed) {
                    let to: Vec<String> = links
                        .iter()
                        .filter_map(|l| {
                            l.href
                                .as_ref()
                                .and_then(|h| names::id_in_href(h))
                                .and_then(|n| row_by_nid.get(&n))
                                .filter(|(db, _)| *db == t)
                                .map(|(_, id)| id.clone())
                                .or_else(|| rows_by_title[&t].get(l.title.trim()).cloned())
                        })
                        .collect();
                    r.cells[c] = links
                        .iter()
                        .map(|l| l.title.clone())
                        .collect::<Vec<_>>()
                        .join(", ");
                    if !to.is_empty() {
                        rel.links.push((r.id.clone(), to));
                    }
                }
                model.plan[c].note = Some(format!("Relation to {}", self.ents[t].name()));
                model.plan[c].samples = model
                    .rows
                    .iter()
                    .map(|r| r.cells[c].trim().to_string())
                    .filter(|s| !s.is_empty())
                    .take(3)
                    .collect();
                model.relations.push((c, rel));
            }
            self.ents[d].db = Some(model);
        }
    }

    /// Resolves links and files on every page.
    fn resolve(&mut self) {
        let by_nid: HashMap<String, String> = self
            .ents
            .iter()
            .filter_map(|e| e.nid.clone().map(|n| (n, e.id.clone())))
            .collect();
        let by_path: HashMap<PathBuf, String> = self
            .ents
            .iter()
            .filter(|e| {
                e.kind != Kind::Pdf && !(e.kind == Kind::Html && e.nid.is_none() && e.db.is_some())
            })
            .map(|e| (e.path.clone(), e.id.clone()))
            .collect();
        let titles: HashMap<String, String> =
            self.ents.iter().map(|e| (e.id.clone(), e.name())).collect();
        for i in 0..self.ents.len() {
            let Some(mut doc) = self.ents[i].doc.take() else {
                continue;
            };
            let dir = self.ents[i]
                .path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_default();
            let mut r = NotionResolver {
                dir,
                ctx: &mut self.ctx,
                by_nid: &by_nid,
                by_path: &by_path,
            };
            import::resolve(&mut doc.blocks, &mut r);
            let mut asset = |href: &str| match r.find(href, Some(true)) {
                Found::Asset { key, .. } => Some(key),
                _ => None,
            };
            doc.icon = match doc.icon.take() {
                Some(i) => match i.strip_prefix("file:") {
                    Some(href) => asset(href),
                    None => Some(i),
                },
                None => None,
            };
            doc.cover = doc.cover.take().and_then(|c| asset(&c));
            mentions(&mut doc.blocks, &titles);
            self.ents[i].doc = Some(doc);
        }
    }

    fn node(&mut self, i: usize, kids: &HashMap<usize, Vec<usize>>) -> Option<Node> {
        let title = self.ents[i].name();
        let index = self.ctx.next();
        let mut node = if let Some(db) = self.ents[i].db.take() {
            let mut db = db;
            // The rows' pages are the records' pages.
            for r in db.rows.iter_mut() {
                if let Some(&e) = self.by_id.get(&r.id) {
                    if let Some(doc) = self.ents[e]
                        .doc
                        .take()
                        .filter(|_| self.ents[e].row_of.is_some())
                    {
                        r.body = doc.blocks;
                        r.icon = doc.icon;
                        r.cover = doc.cover;
                    }
                }
            }
            let mut n = Node::new(index, title, Source::Database(Box::new(db)));
            if let Some(doc) = self.ents[i].doc.as_mut() {
                n.icon = doc.icon.take();
                n.cover = doc.cover.take();
            }
            n
        } else {
            match self.ents[i].kind {
                Kind::Pdf => {
                    let path = self.ents[i].path.clone();
                    if self.ctx.assets.contains_key(&*path.to_string_lossy()) {
                        return None; // a page shows it already
                    }
                    let mut n = import::pdf_node(&path, title, &mut self.ctx)?;
                    n.index = index;
                    n
                }
                Kind::Csv => return None, // unreadable
                _ => {
                    let doc = self.ents[i].doc.take().unwrap_or_default();
                    let mut n = Node::new(
                        index,
                        title,
                        Source::Doc {
                            blocks: doc.blocks,
                            page_id: self.ents[i].id.clone(),
                        },
                    );
                    n.icon = doc.icon;
                    n.cover = doc.cover;
                    n
                }
            }
        };
        for &k in kids.get(&i).map(Vec::as_slice).unwrap_or(&[]) {
            if let Some(c) = self.node(k, kids) {
                node.children.push(c);
            }
        }
        Some(node)
    }
}

fn stage(root: &Path, files: Vec<PathBuf>) -> AppResult<Staged> {
    let root = root.canonicalize().unwrap_or(root.to_path_buf());
    let mut s = Stage {
        root: root.clone(),
        ctx: Ctx::new(root),
        ents: Vec::new(),
        by_id: HashMap::new(),
    };
    s.collect(files);
    if s.ents.is_empty() {
        return Err(AppError::Validation(
            "there is nothing to import in this Notion export".into(),
        ));
    }
    s.folder_parents();
    let folders = s.ents.iter().any(|e| e.parent.is_some());
    s.read_csvs()?;
    s.parse_docs()?;
    s.html_databases();
    s.csv_databases();
    let linked = s.link_parents();
    s.relations();
    s.resolve();
    s.by_id = s
        .ents
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.clone(), i))
        .collect();

    // The tree, and the folders above its top pages that Notion adds (an export folder,
    // "Private & Shared", teamspaces). A path every top page shares is left out.
    let mut kids: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut roots = Vec::new();
    for (i, e) in s.ents.iter().enumerate() {
        if e.row_of.is_some() {
            continue;
        }
        match e.parent {
            Some(p) => kids.entry(p).or_default().push(i),
            None => roots.push(i),
        }
    }
    let mut common: Option<Vec<String>> = None;
    for &r in &roots {
        let d = &s.ents[r].dir;
        common = Some(match common {
            None => d.clone(),
            Some(c) => c
                .iter()
                .zip(d)
                .take_while(|(a, b)| a == b)
                .map(|(a, _)| a.clone())
                .collect(),
        });
    }
    let common = common.unwrap_or_default();
    let shared_names: Vec<String> = common.clone();
    let mut top: Vec<Node> = Vec::new();
    let mut wrapped = false;
    for r in roots {
        let dirs: Vec<String> = s.ents[r].dir[common.len()..].to_vec();
        wrapped |= !dirs.is_empty();
        if let Some(node) = s.node(r, &kids) {
            import::place(&mut top, &dirs, node, &mut s.ctx);
        }
    }
    if top.is_empty() {
        return Err(AppError::Validation(
            "there is nothing to import in this Notion export".into(),
        ));
    }
    let kinds: HashSet<&'static str> = s
        .ents
        .iter()
        .filter(|e| e.nid.is_some() || e.kind == Kind::Pdf)
        .map(|e| match e.kind {
            Kind::Markdown | Kind::Csv => "markdown",
            Kind::Html => "html",
            Kind::Pdf => "pdf",
        })
        .collect();
    let format = match kinds.len() {
        0 => "html",
        1 => kinds.into_iter().next().expect("one"),
        _ => "mixed",
    };
    let named_wrapper = shared_names
        .iter()
        .rev()
        .find(|n| !n.starts_with("Export-") && names::split_id(n).1.is_none())
        .cloned();
    let workspace = top.len() > 1
        || wrapped
        || shared_names
            .iter()
            .any(|n| matches!(n.as_str(), "Private & Shared" | "Teamspaces" | "Shared"));
    let name = if top.len() == 1 && !workspace {
        top[0].title.clone()
    } else {
        named_wrapper
            .filter(|n| n != "Private & Shared")
            .unwrap_or_else(|| "Notion".into())
    };
    let origin = Origin {
        kind: "notion".into(),
        format: format.into(),
        layout: if folders || !linked {
            "folders"
        } else {
            "flat"
        }
        .into(),
        workspace,
        name,
    };
    Ok(import::staged(top, s.ctx, Some(origin)))
}

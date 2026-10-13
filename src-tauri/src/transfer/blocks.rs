//! The shared block model for import and export: a tree of blocks with rich inline text, and the
//! conversion to and from the stored block rows. Markdown, HTML and the archive all go through it.

use crate::domain::{new_id, Block, BlockUpsert, BLOCK_SCHEMA_VERSION};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum Mark {
    Bold,
    Italic,
    Strike,
    Code,
    Underline,
    Link(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Inline {
    Text {
        text: String,
        marks: Vec<Mark>,
    },
    Break,
    /// A mention of another page, by page id.
    Mention(String),
    /// An image in running text. The editor has no inline images: a paragraph holding only one
    /// becomes an image block when its file can be found, otherwise it is kept as a link.
    Image {
        src: String,
        alt: String,
    },
}

pub fn plain(text: impl Into<String>) -> Inline {
    Inline::Text {
        text: text.into(),
        marks: vec![],
    }
}

/// A file a media block points at. While importing, `src` is what the source document said and
/// `attachment` is empty until the file is stored; when exporting, `attachment` is what the
/// block holds (`{id, hash, name, mime, size}`).
#[derive(Debug, Clone, Default)]
pub struct Media {
    pub src: Option<String>,
    pub name: String,
    pub attachment: Option<Value>,
    pub presentation: Value,
}

pub type Table = Vec<Vec<Vec<Inline>>>;

#[derive(Debug, Clone)]
pub struct Blk {
    pub kind: String,
    pub inline: Vec<Inline>,
    pub checked: bool,
    pub open: bool,
    pub level: u8,
    pub label: String,
    pub text: String,
    pub language: Option<String>,
    pub latex: String,
    pub tone: String,
    /// Rows of cells of inline text; the first row is the header.
    pub table: Option<Table>,
    pub media: Option<Media>,
    /// For a synced block or an embedded database: the page it points at.
    pub target: Option<String>,
    pub children: Vec<Blk>,
}

impl Blk {
    pub fn new(kind: &str) -> Self {
        Blk {
            kind: kind.into(),
            inline: vec![],
            checked: false,
            open: false,
            level: 0,
            label: String::new(),
            text: String::new(),
            language: None,
            latex: String::new(),
            tone: "note".into(),
            table: None,
            media: None,
            target: None,
            children: vec![],
        }
    }

    pub fn with_inline(kind: &str, inline: Vec<Inline>) -> Self {
        Blk {
            inline,
            ..Blk::new(kind)
        }
    }
}

pub fn is_media(kind: &str) -> bool {
    matches!(kind, "image" | "audio" | "video" | "file" | "pdf")
}

/// The block type for a file with this content type.
pub fn media_kind(mime: &str) -> &'static str {
    match mime.split('/').next().unwrap_or("") {
        "image" => "image",
        "audio" => "audio",
        "video" => "video",
        _ if mime == "application/pdf" => "pdf",
        _ => "file",
    }
}

// ---- inline <-> JSON ----

fn mark_json(m: &Mark) -> Value {
    match m {
        Mark::Bold => json!({ "type": "bold" }),
        Mark::Italic => json!({ "type": "italic" }),
        Mark::Strike => json!({ "type": "strike" }),
        Mark::Code => json!({ "type": "code" }),
        Mark::Underline => json!({ "type": "underline" }),
        Mark::Link(href) => json!({ "type": "link", "attrs": { "href": href } }),
    }
}

pub fn inlines_to_json(items: &[Inline]) -> Value {
    Value::Array(
        items
            .iter()
            .filter_map(|i| match i {
                Inline::Text { text, marks } if !text.is_empty() => {
                    let mut o = Map::new();
                    o.insert("type".into(), json!("text"));
                    o.insert("text".into(), json!(text));
                    if !marks.is_empty() {
                        o.insert(
                            "marks".into(),
                            Value::Array(marks.iter().map(mark_json).collect()),
                        );
                    }
                    Some(Value::Object(o))
                }
                Inline::Text { .. } => None,
                Inline::Break => Some(json!({ "type": "hardBreak" })),
                Inline::Mention(id) => {
                    Some(json!({ "type": "pageMention", "attrs": { "pageId": id } }))
                }
                Inline::Image { src, alt } => Some(json!({
                    "type": "text",
                    "text": if alt.is_empty() { src.as_str() } else { alt.as_str() },
                    "marks": [{ "type": "link", "attrs": { "href": src } }]
                })),
            })
            .collect(),
    )
}

pub fn inlines_from_json(v: &Value) -> Vec<Inline> {
    let Some(items) = v.as_array() else {
        return vec![];
    };
    items
        .iter()
        .filter_map(|n| match n.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = n.get("text").and_then(Value::as_str)?.to_string();
                let marks = n
                    .get("marks")
                    .and_then(Value::as_array)
                    .map(|ms| {
                        ms.iter()
                            .filter_map(|m| match m.get("type").and_then(Value::as_str)? {
                                "bold" => Some(Mark::Bold),
                                "italic" => Some(Mark::Italic),
                                "strike" => Some(Mark::Strike),
                                "code" => Some(Mark::Code),
                                "underline" => Some(Mark::Underline),
                                "link" => m
                                    .pointer("/attrs/href")
                                    .and_then(Value::as_str)
                                    .map(|h| Mark::Link(h.to_string())),
                                _ => None,
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                Some(Inline::Text { text, marks })
            }
            Some("hardBreak") => Some(Inline::Break),
            Some("pageMention") => n
                .pointer("/attrs/pageId")
                .and_then(Value::as_str)
                .map(|s| Inline::Mention(s.to_string())),
            _ => None,
        })
        .collect()
}

/// The text of inline content with no formatting.
pub fn plain_of(items: &[Inline]) -> String {
    items
        .iter()
        .map(|i| match i {
            Inline::Text { text, .. } => text.as_str(),
            Inline::Break => " ",
            Inline::Mention(_) => "",
            Inline::Image { alt, .. } => alt.as_str(),
        })
        .collect()
}

// ---- tables ----

fn table_json(rows: &Table) -> Value {
    let width = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
    let row_json = |cells: &Vec<Vec<Inline>>, header: bool| {
        let kind = if header { "tableHeader" } else { "tableCell" };
        let cells: Vec<Value> = (0..width)
            .map(|c| {
                let content = cells
                    .get(c)
                    .map(|i| inlines_to_json(i))
                    .unwrap_or_else(|| json!([]));
                let para = if content.as_array().is_some_and(|a| !a.is_empty()) {
                    json!({ "type": "paragraph", "content": content })
                } else {
                    json!({ "type": "paragraph" })
                };
                json!({ "type": kind, "content": [para] })
            })
            .collect();
        json!({ "type": "tableRow", "content": cells })
    };
    let rows_json: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| row_json(r, i == 0))
        .collect();
    json!({ "type": "table", "content": rows_json })
}

fn table_from_json(v: &Value) -> Table {
    v.get("content")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|r| {
                    r.get("content")
                        .and_then(Value::as_array)
                        .map(|cells| {
                            cells
                                .iter()
                                .map(|c| {
                                    c.get("content")
                                        .and_then(Value::as_array)
                                        .map(|paras| {
                                            let mut out: Vec<Inline> = Vec::new();
                                            for (i, p) in paras.iter().enumerate() {
                                                if i > 0 {
                                                    out.push(Inline::Break);
                                                }
                                                out.extend(inlines_from_json(
                                                    p.get("content").unwrap_or(&Value::Null),
                                                ));
                                            }
                                            out
                                        })
                                        .unwrap_or_default()
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---- block <-> data JSON ----

impl Blk {
    pub fn data(&self) -> Value {
        let content = || inlines_to_json(&self.inline);
        match self.kind.as_str() {
            "todo" => json!({ "content": content(), "checked": self.checked }),
            "toggle" => {
                let mut data = json!({ "content": content(), "open": self.open });
                if self.level > 0 {
                    data["level"] = json!(self.level);
                }
                data
            }
            "tabs" => json!({}),
            "tab_panel" => json!({ "label": self.label }),
            "callout" => json!({ "content": content(), "tone": self.tone }),
            "divider" => json!({}),
            "synced_block" | "database_view" => json!({ "pageId": self.target }),
            "code" => json!({ "language": self.language, "text": self.text }),
            "equation" => json!({ "latex": self.latex }),
            "simple_table" => {
                json!({ "table": table_json(self.table.as_ref().unwrap_or(&vec![vec![vec![]]])) })
            }
            k if is_media(k) => {
                let mut data =
                    json!({ "attachment": self.media.as_ref().and_then(|m| m.attachment.clone()) });
                if let Some(p) = self
                    .media
                    .as_ref()
                    .map(|m| &m.presentation)
                    .filter(|p| p.is_object() && !p.as_object().unwrap().is_empty())
                {
                    data["presentation"] = p.clone();
                }
                data
            }
            _ => json!({ "content": content() }),
        }
    }

    /// A block (without children) from a stored row.
    pub fn from_row(kind: &str, data_json: &str, schema_version: i64) -> Blk {
        let mut data: Value = serde_json::from_str(data_json).unwrap_or(Value::Null);
        if schema_version < 2 {
            let text = data
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            data = json!({ "content": if text.is_empty() { json!([]) } else { json!([{ "type": "text", "text": text }]) } });
        }
        let mut b = Blk::new(kind);
        b.inline = inlines_from_json(data.get("content").unwrap_or(&Value::Null));
        b.checked = data
            .get("checked")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        b.open = data.get("open").and_then(Value::as_bool).unwrap_or(false);
        b.level = data
            .get("level")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(4) as u8;
        b.label = data
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or("Tab")
            .to_string();
        if let Some(t) = data.get("tone").and_then(Value::as_str) {
            b.tone = t.to_string();
        }
        b.text = data
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        b.language = data
            .get("language")
            .and_then(Value::as_str)
            .filter(|l| !l.is_empty())
            .map(String::from);
        b.latex = data
            .get("latex")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if matches!(kind, "synced_block" | "database_view") {
            b.target = data.get("pageId").and_then(Value::as_str).map(String::from);
        }
        if kind == "simple_table" {
            b.table = Some(data.get("table").map(table_from_json).unwrap_or_default());
        }
        if is_media(kind) {
            let att = data.get("attachment").filter(|a| a.is_object()).cloned();
            let name = att
                .as_ref()
                .and_then(|a| a.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("file")
                .to_string();
            b.media = Some(Media {
                src: None,
                name,
                attachment: att,
                presentation: data.get("presentation").cloned().unwrap_or(Value::Null),
            });
        }
        b
    }
}

/// Stored rows as a tree, in reading order.
pub fn tree_from_rows(rows: &[Block]) -> Vec<Blk> {
    let ids: std::collections::HashSet<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    let mut by_parent: HashMap<Option<&str>, Vec<&Block>> = HashMap::new();
    for r in rows {
        let key = r.parent_block_id.as_deref().filter(|p| ids.contains(p));
        by_parent.entry(key).or_default().push(r);
    }
    for list in by_parent.values_mut() {
        list.sort_by(|a, b| a.position.total_cmp(&b.position).then(a.id.cmp(&b.id)));
    }
    fn build(
        by: &HashMap<Option<&str>, Vec<&Block>>,
        parent: Option<&str>,
        depth: usize,
    ) -> Vec<Blk> {
        if depth > 64 {
            return vec![];
        }
        by.get(&parent)
            .map(|list| {
                list.iter()
                    .map(|r| {
                        let mut b = Blk::from_row(&r.block_type, &r.data_json, r.schema_version);
                        b.children = build(by, Some(r.id.as_str()), depth + 1);
                        b
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    build(&by_parent, None, 0)
}

/// Turns a tree into block rows with fresh ids, in order.
pub fn flatten(blocks: &[Blk]) -> Vec<BlockUpsert> {
    fn walk(blocks: &[Blk], parent: Option<&str>, out: &mut Vec<BlockUpsert>, depth: usize) {
        if depth > 64 {
            return;
        }
        for (i, b) in blocks.iter().enumerate() {
            let id = new_id();
            out.push(BlockUpsert {
                id: id.clone(),
                parent_block_id: parent.map(String::from),
                block_type: b.kind.clone(),
                position: i as f64,
                data_json: b.data().to_string(),
                schema_version: BLOCK_SCHEMA_VERSION,
            });
            walk(&b.children, Some(&id), out, depth + 1);
        }
    }
    let mut out = Vec::new();
    walk(blocks, None, &mut out, 0);
    out
}

/// Calls `f` on every block in the tree.
pub fn visit_mut(blocks: &mut [Blk], f: &mut dyn FnMut(&mut Blk)) {
    for b in blocks {
        f(b);
        visit_mut(&mut b.children, f);
    }
}

pub fn visit(blocks: &[Blk], f: &mut dyn FnMut(&Blk)) {
    for b in blocks {
        f(b);
        visit(&b.children, f);
    }
}

/// Whether a link target may be kept: anything that could run code or read a local file when
/// followed is refused at the door, whatever the source format was.
pub fn safe_href(href: &str) -> bool {
    let l: String = href
        .chars()
        .filter(|c| !c.is_control() && !c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    !["javascript:", "data:", "vbscript:", "file:", "blob:"]
        .iter()
        .any(|p| l.starts_with(p))
}

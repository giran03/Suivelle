//! Notion's HTML export. Each page is an `<article class="page">` whose `<header>` holds the icon,
//! cover, title and (for a database row) a table of properties, and whose `div.page-body` holds
//! blocks marked with Notion's class names. A database is a `table.collection-content`, either on
//! a page of its own or inline on another page.

use super::super::blocks::*;
use super::super::html::{
    self as h, attr, blocks_of, find_tag, inline_of, text_content, trim_inline, Node,
};
use super::super::markdown;
use super::names;
use super::Doc;

/// Whether the text is a page from Notion's HTML export.
pub fn is_notion(text: &str) -> bool {
    let head: String = text.chars().take(200_000).collect();
    head.contains("<article")
        && (head.contains("class=\"page sans\"")
            || head.contains("class=\"page serif\"")
            || head.contains("class=\"page mono\"")
            || head.contains("class=\"page-body\"")
            || head.contains("class=\"page-title\""))
}

/// A database table as Notion exported it.
#[derive(Debug, Clone, Default)]
pub struct Collection {
    pub title: String,
    /// Column names and Notion property types ("title", "select", "relation"…).
    pub columns: Vec<(String, String)>,
    pub rows: Vec<CollectionRow>,
}

#[derive(Debug, Clone, Default)]
pub struct CollectionRow {
    /// The link to the row's own page.
    pub href: Option<String>,
    pub cells: Vec<String>,
    /// (column, option name, Notion colour)
    pub colors: Vec<(usize, String, String)>,
}

type Attrs = [(String, String)];
/// A test on an element's tag and attributes.
type Matcher<'f> = &'f dyn Fn(&str, &Attrs) -> bool;
/// An element found in the tree: its tag, attributes and children.
type Found<'a> = (&'a str, &'a Attrs, &'a [Node]);

fn classes(attrs: &Attrs) -> impl Iterator<Item = &str> {
    attr(attrs, "class").unwrap_or("").split_whitespace()
}

fn has_class(attrs: &[(String, String)], c: &str) -> bool {
    classes(attrs).any(|x| x == c)
}

fn text_of(nodes: &[Node]) -> String {
    let mut s = String::new();
    text_content(nodes, &mut s);
    h::collapse(&s).trim().to_string()
}

/// The first element below `nodes` (depth first) that matches.
fn find_el<'a>(nodes: &'a [Node], f: Matcher) -> Option<Found<'a>> {
    for n in nodes {
        if let Node::El { tag, attrs, kids } = n {
            if f(tag, attrs) {
                return Some((tag, attrs, kids));
            }
            if let Some(found) = find_el(kids, f) {
                return Some(found);
            }
        }
    }
    None
}

fn find_all<'a>(nodes: &'a [Node], f: Matcher, out: &mut Vec<(&'a Attrs, &'a [Node])>) {
    for n in nodes {
        if let Node::El { tag, attrs, kids } = n {
            if f(tag, attrs) {
                out.push((attrs, kids));
            } else {
                find_all(kids, f, out);
            }
        }
    }
}

/// A Notion property type from the type icon in a column header (`svg.typesSelect`) or the class
/// of a property row (`tr.property-row-select`).
pub fn property_type(raw: &str) -> &'static str {
    let k = raw
        .trim_start_matches("types")
        .to_ascii_lowercase()
        .replace(['_', '-'], "");
    match k.as_str() {
        "title" => "title",
        "text" | "richtext" => "text",
        "number" => "number",
        "select" => "select",
        "multipleselect" | "multiselect" => "multi_select",
        "status" => "status",
        "date" => "date",
        "person" | "people" => "person",
        "file" | "files" => "files",
        "checkbox" => "checkbox",
        "url" => "url",
        "email" => "email",
        "phonenumber" | "phone" => "phone",
        "formula" => "formula",
        "relation" => "relation",
        "rollup" => "rollup",
        "createdat" | "createdtime" => "created_time",
        "createdby" => "created_by",
        "lasteditedtime" | "updatedat" | "lasteditedat" => "updated_time",
        "lasteditedby" | "updatedby" => "updated_by",
        "uniqueid" | "autoincrementid" | "id" => "unique_id",
        _ => "text",
    }
}

/// The text a cell stands for, written the way Notion writes the same value in a CSV file.
fn cell_text(
    kind: &str,
    kids: &[Node],
    col: usize,
    colors: &mut Vec<(usize, String, String)>,
) -> String {
    match kind {
        "checkbox" => {
            let on = find_el(kids, &|_, a| has_class(a, "checkbox-on")).is_some();
            if on { "Yes" } else { "No" }.into()
        }
        "relation" => {
            let mut links = Vec::new();
            find_all(kids, &|t, _| t == "a", &mut links);
            links
                .iter()
                .map(|(a, k)| match attr(a, "href") {
                    Some(href) if !href.is_empty() => format!("{} ({href})", text_of(k)),
                    _ => text_of(k),
                })
                .collect::<Vec<_>>()
                .join(", ")
        }
        "select" | "multi_select" | "status" => {
            let mut values = Vec::new();
            find_all(
                kids,
                &|_, a| classes(a).any(|c| c == "selected-value" || c == "status-value"),
                &mut values,
            );
            if values.is_empty() {
                return text_of(kids);
            }
            values
                .iter()
                .map(|(a, k)| {
                    let name = text_of(k);
                    if let Some(color) =
                        classes(a).find_map(|c| c.strip_prefix("select-value-color-"))
                    {
                        colors.push((col, name.clone(), color.to_string()));
                    }
                    name
                })
                .collect::<Vec<_>>()
                .join(", ")
        }
        "date" | "created_time" | "updated_time" => {
            text_of(kids).trim_start_matches('@').trim().to_string()
        }
        _ => text_of(kids),
    }
}

fn parse_collection(kids: &[Node], title: String) -> Collection {
    let mut c = Collection {
        title,
        ..Default::default()
    };
    if let Some((_, _, head)) = find_el(kids, &|t, _| t == "thead") {
        let mut ths = Vec::new();
        find_all(head, &|t, _| t == "th", &mut ths);
        for (_, th) in ths {
            let kind = find_el(th, &|t, a| {
                t == "svg" && classes(a).any(|c| c.starts_with("types"))
            })
            .and_then(|(_, a, _)| {
                classes(a)
                    .find(|c| c.starts_with("types"))
                    .map(property_type)
            })
            .unwrap_or("text");
            c.columns.push((text_of(th), kind.to_string()));
        }
    }
    if c.columns.is_empty() {
        return c;
    }
    if !c.columns.iter().any(|(_, k)| k == "title") {
        c.columns[0].1 = "title".into();
    }
    let body = find_el(kids, &|t, _| t == "tbody")
        .map(|(_, _, k)| k)
        .unwrap_or(kids);
    for n in body {
        let Node::El { tag, kids: tr, .. } = n else {
            continue;
        };
        if tag != "tr" {
            continue;
        }
        let tds: Vec<&[Node]> = tr
            .iter()
            .filter_map(|n| match n {
                Node::El { tag, kids, .. } if tag == "td" => Some(kids.as_slice()),
                _ => None,
            })
            .collect();
        let mut row = CollectionRow::default();
        for (i, (_, kind)) in c.columns.iter().enumerate() {
            let cell = tds.get(i).copied().unwrap_or(&[]);
            if kind == "title" {
                row.href = find_el(cell, &|t, _| t == "a")
                    .and_then(|(_, a, _)| attr(a, "href"))
                    .map(String::from);
            }
            row.cells.push(cell_text(kind, cell, i, &mut row.colors));
        }
        c.rows.push(row);
    }
    // The title column comes first, as it does in a CSV file.
    if let Some(t) = c
        .columns
        .iter()
        .position(|(_, k)| k == "title")
        .filter(|t| *t > 0)
    {
        let col = c.columns.remove(t);
        c.columns.insert(0, col);
        for r in c.rows.iter_mut() {
            let cell = r.cells.remove(t);
            r.cells.insert(0, cell);
            for (i, _, _) in r.colors.iter_mut() {
                *i = if *i == t {
                    0
                } else if *i < t {
                    *i + 1
                } else {
                    *i
                };
            }
        }
    }
    c
}

/// Takes every database table out of the tree, leaving a `notion-db` marker in its place.
fn take_collections(nodes: &mut [Node], out: &mut Vec<Collection>) {
    let mut i = 0;
    while i < nodes.len() {
        let replace = match &nodes[i] {
            Node::El { tag, attrs, kids }
                if tag == "table" && has_class(attrs, "collection-content") =>
            {
                Some(parse_collection(kids, String::new()))
            }
            Node::El { tag, attrs, kids }
                if tag == "div" && has_class(attrs, "collection-content") =>
            {
                let title = find_el(kids, &|_, a| has_class(a, "collection-title"))
                    .map(|(_, _, k)| text_of(k))
                    .unwrap_or_default();
                find_el(kids, &|t, _| t == "table").map(|(_, _, k)| parse_collection(k, title))
            }
            _ => None,
        };
        if let Some(c) = replace {
            nodes[i] = Node::El {
                tag: "notion-db".into(),
                attrs: vec![("data-i".into(), out.len().to_string())],
                kids: vec![],
            };
            out.push(c);
        } else if let Node::El { kids, .. } = &mut nodes[i] {
            take_collections(kids, out);
        }
        i += 1;
    }
}

fn kids_blocks(kids: &[Node], depth: usize) -> Vec<Blk> {
    blocks_of(kids, depth + 1, Some(hook))
}

fn inline_blk_of(kind: &str, kids: &[Node]) -> Blk {
    let mut v = Vec::new();
    inline_of(kids, &[], &mut v, 0);
    Blk::with_inline(kind, trim_inline(v))
}

/// The Notion block classes; anything not claimed here falls to the generic HTML rules.
pub(crate) fn hook(
    tag: &str,
    attrs: &[(String, String)],
    kids: &[Node],
    depth: usize,
) -> Option<Vec<Blk>> {
    let is = |c: &str| has_class(attrs, c);
    match tag {
        "notion-db" => {
            let mut b = Blk::new("database_view");
            b.label = format!("notion-db:{}", attr(attrs, "data-i").unwrap_or("0"));
            Some(vec![b])
        }
        "header" => Some(vec![]),
        "ul" if is("to-do-list") => Some(
            kids.iter()
                .filter_map(|n| match n {
                    Node::El { tag, kids, .. } if tag == "li" => Some(kids.as_slice()),
                    _ => None,
                })
                .map(|li| {
                    let checked = find_el(li, &|_, a| has_class(a, "checkbox-on")).is_some();
                    let (head, rest): (Vec<Node>, Vec<Node>) = li.iter().cloned().partition(|n| {
                        !matches!(n, Node::El { tag, attrs, .. } if tag == "div" && (has_class(attrs, "indented") || classes(attrs).any(|c| c.starts_with("checkbox"))))
                    });
                    let mut b = inline_blk_of("todo", &head);
                    b.checked = checked;
                    b.children = kids_blocks(&rest, depth);
                    b
                })
                .collect(),
        ),
        "ul" if is("toggle") => Some(
            kids.iter()
                .filter_map(|n| match n {
                    Node::El { tag, kids, .. } if tag == "li" => Some(kids.as_slice()),
                    _ => None,
                })
                .filter_map(|li| find_el(li, &|t, _| t == "details"))
                .map(|(_, a, d)| toggle(a, d, depth))
                .collect(),
        ),
        "details" => Some(vec![toggle(attrs, kids, depth)]),
        "figure" if is("callout") => {
            let icon = find_el(kids, &|_, a| has_class(a, "icon"))
                .map(|(_, _, k)| text_of(k))
                .unwrap_or_default();
            let body: Vec<Node> = kids
                .iter()
                .filter(|n| find_el(std::slice::from_ref(*n), &|_, a| has_class(a, "icon")).is_none())
                .cloned()
                .collect();
            let blocks = kids_blocks(&body, depth);
            let mut inline = Vec::new();
            markdown::flatten_inline(&blocks, &mut inline);
            let mut b = Blk::with_inline("callout", inline);
            b.tone = names::callout_tone(&icon).into();
            Some(vec![b])
        }
        "figure" if is("equation") => {
            let tex = find_el(kids, &|t, a| t == "annotation" && attr(a, "encoding") == Some("application/x-tex"))
                .map(|(_, _, k)| {
                    let mut s = String::new();
                    text_content(k, &mut s);
                    s.trim().to_string()
                })
                .unwrap_or_else(|| text_of(kids));
            let mut b = Blk::new("equation");
            b.latex = tex;
            Some(vec![b])
        }
        "figure" | "div" if is("link-to-page") || find_el(kids, &|t, a| t == "a" && has_class(a, "bookmark")).is_some() && tag == "figure" => {
            let (a, k) = find_el(kids, &|t, _| t == "a").map(|(_, a, k)| (a, k))?;
            let href = attr(a, "href")?.to_string();
            let text = find_el(k, &|_, a| has_class(a, "bookmark-title"))
                .map(|(_, _, t)| text_of(t))
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| {
                    // A link to a page shows the page's icon before its title.
                    let without_icon: Vec<Node> = k
                        .iter()
                        .filter(|n| !matches!(n, Node::El { attrs, .. } if has_class(attrs, "icon")))
                        .cloned()
                        .collect();
                    text_of(&without_icon)
                });
            let text = if text.is_empty() { href.clone() } else { text };
            Some(vec![Blk::with_inline(
                "paragraph",
                vec![Inline::Text {
                    text,
                    marks: vec![Mark::Link(href)],
                }],
            )])
        }
        "nav" if is("table_of_contents") => Some(vec![Blk::new("table_of_contents")]),
        "div" if is("column-list") => {
            let mut cols = Blk::new("columns");
            for n in kids {
                if let Node::El { tag, attrs, kids } = n {
                    if tag == "div" && has_class(attrs, "column") {
                        let mut c = Blk::new("column");
                        c.children = kids_blocks(kids, depth);
                        cols.children.push(c);
                    }
                }
            }
            Some(if cols.children.len() > 1 {
                vec![cols]
            } else {
                cols.children.into_iter().flat_map(|c| c.children).collect()
            })
        }
        "pre" if is("code") => {
            let mut text = String::new();
            text_content(kids, &mut text);
            let lang = find_el(kids, &|t, _| t == "code")
                .and_then(|(_, a, _)| classes(a).find_map(|c| c.strip_prefix("language-")).map(String::from))
                .map(|l| l.to_ascii_lowercase().replace(' ', ""))
                .filter(|l| !l.is_empty() && l != "plaintext");
            let mut b = Blk::new("code");
            b.text = text.trim_end_matches('\n').to_string();
            b.language = lang;
            Some(vec![b])
        }
        _ => None,
    }
}

fn toggle(attrs: &[(String, String)], kids: &[Node], depth: usize) -> Blk {
    let summary = kids.iter().find_map(|k| match k {
        Node::El { tag, kids, .. } if tag == "summary" => Some(kids.as_slice()),
        _ => None,
    });
    let body: Vec<Node> = kids
        .iter()
        .filter(|k| !matches!(k, Node::El { tag, .. } if tag == "summary"))
        .cloned()
        .collect();
    let mut b = match summary {
        Some(s) => inline_blk_of("toggle", s),
        None => Blk::with_inline("toggle", vec![plain("Details")]),
    };
    if let Some(level) = summary.and_then(|s| {
        find_el(s, &|t, _| matches!(t, "h1" | "h2" | "h3"))
            .map(|(t, _, _)| t[1..].parse::<u8>().unwrap_or(1))
    }) {
        b.level = level;
    }
    b.open = attrs.iter().any(|(k, _)| k == "open");
    b.children = kids_blocks(&body, depth);
    b
}

/// A page of Notion's HTML export.
pub fn parse(src: &str) -> Doc {
    let mut dom = h::parse_dom(src);
    let mut doc = Doc::default();
    if src.contains("highlight-") || src.contains("block-color-") {
        doc.lossy = true;
    }
    let mut collections = Vec::new();
    take_collections(&mut dom, &mut collections);
    let article: Vec<Node> = find_tag(&dom, "article")
        .or_else(|| find_tag(&dom, "body"))
        .map(<[Node]>::to_vec)
        .unwrap_or(dom.clone());
    if let Some((_, _, header)) = find_el(&article, &|t, _| t == "header") {
        doc.title = find_el(header, &|_, a| has_class(a, "page-title"))
            .map(|(_, _, k)| text_of(k))
            .filter(|t| !t.is_empty());
        if let Some((_, _, icon)) = find_el(header, &|_, a| has_class(a, "page-header-icon")) {
            doc.icon = match find_el(icon, &|t, _| t == "img") {
                Some((_, a, _)) => attr(a, "src").map(|s| format!("file:{s}")),
                None => Some(text_of(icon)).filter(|t| !t.is_empty()),
            };
        }
        doc.cover = find_el(header, &|t, a| {
            t == "img" && has_class(a, "page-cover-image")
        })
        .and_then(|(_, a, _)| attr(a, "src"))
        .map(String::from);
        if let Some((_, _, table)) =
            find_el(header, &|t, a| t == "table" && has_class(a, "properties"))
        {
            let mut trs = Vec::new();
            find_all(table, &|t, _| t == "tr", &mut trs);
            for (a, tr) in trs {
                let kind = classes(a)
                    .find_map(|c| c.strip_prefix("property-row-"))
                    .map(property_type)
                    .unwrap_or("text");
                let th = tr.iter().find_map(|n| match n {
                    Node::El { tag, kids, .. } if tag == "th" => Some(kids.as_slice()),
                    _ => None,
                });
                let td = tr.iter().find_map(|n| match n {
                    Node::El { tag, kids, .. } if tag == "td" => Some(kids.as_slice()),
                    _ => None,
                });
                if let (Some(th), Some(td)) = (th, td) {
                    let mut colors = Vec::new();
                    doc.props
                        .push((text_of(th), cell_text(kind, td, 0, &mut colors)));
                    doc.prop_kinds.push(kind.to_string());
                }
            }
        }
    }
    let page_body =
        find_el(&article, &|_, a| has_class(a, "page-body")).map(|(_, _, k)| k.to_vec());
    let has_body = page_body.is_some();
    let body: Vec<Node> = page_body.unwrap_or_else(|| {
        article
            .iter()
            .filter(|n| !matches!(n, Node::El { tag, .. } if tag == "header"))
            .cloned()
            .collect()
    });
    let mut blocks = blocks_of(&body, 0, Some(hook));
    visit_mut(&mut blocks, &mut |b| {
        if let Some(n) = b
            .kind
            .strip_prefix("heading_")
            .and_then(|n| n.parse::<usize>().ok())
        {
            b.kind = format!("heading_{}", n.clamp(1, 3));
        }
    });
    // A database's own page is nothing but its table.
    let only_table = blocks.iter().all(|b| {
        b.kind == "database_view"
            || (b.kind == "paragraph" && plain_of(&b.inline).trim().is_empty())
    });
    doc.collection_page = !has_body && collections.len() == 1 && only_table;
    if doc.collection_page {
        blocks.clear();
        if collections[0].title.is_empty() {
            collections[0].title = doc.title.clone().unwrap_or_default();
        }
    }
    doc.blocks = blocks;
    doc.collections = collections;
    doc
}

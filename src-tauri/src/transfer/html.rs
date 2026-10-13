//! HTML to blocks and back. The parser is deliberately forgiving and deliberately small: it
//! builds a tree, drops everything that could run or load something (scripts, styles, frames,
//! forms, SVG) and maps the structural tags onto native blocks. Nothing from the source is ever
//! kept as markup.

use super::blocks::*;
use super::markdown::Ctx;

const MAX_DEPTH: usize = 120;

#[derive(Debug, Clone)]
enum Node {
    Text(String),
    El {
        tag: String,
        attrs: Vec<(String, String)>,
        kids: Vec<Node>,
    },
}

type Open = (String, Vec<(String, String)>, Vec<Node>);

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];
const RAW: &[&str] = &["script", "style", "textarea", "title"];
const BLOCKY: &[&str] = &[
    "p",
    "div",
    "ul",
    "ol",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "pre",
    "blockquote",
    "hr",
    "details",
    "section",
    "article",
    "li",
    "tr",
];

pub struct Parsed {
    pub title: Option<String>,
    pub blocks: Vec<Blk>,
    pub warnings: Vec<String>,
}

fn decode(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|e| *e <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..end];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some('\u{a0}'),
            "mdash" => Some('—'),
            "ndash" => Some('–'),
            "hellip" => Some('…'),
            "copy" => Some('©'),
            "reg" => Some('®'),
            "trade" => Some('™'),
            "lsquo" => Some('‘'),
            "rsquo" => Some('’'),
            "ldquo" => Some('“'),
            "rdquo" => Some('”'),
            "bull" => Some('•'),
            "times" => Some('×'),
            n if n.starts_with("#x") || n.starts_with("#X") => u32::from_str_radix(&n[2..], 16)
                .ok()
                .and_then(char::from_u32),
            n if n.starts_with('#') => n[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == '/') {
            i += 1;
        }
        let start = i;
        while i < chars.len() && !chars[i].is_whitespace() && !matches!(chars[i], '=' | '/' | '>') {
            i += 1;
        }
        if start == i {
            i += 1;
            continue;
        }
        let name: String = chars[start..i]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if chars.get(i) == Some(&'=') {
            i += 1;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            if let Some(q) = chars.get(i).filter(|c| matches!(c, '"' | '\'')) {
                let q = *q;
                i += 1;
                while i < chars.len() && chars[i] != q {
                    value.push(chars[i]);
                    i += 1;
                }
                i += 1;
            } else {
                while i < chars.len() && !chars[i].is_whitespace() {
                    value.push(chars[i]);
                    i += 1;
                }
            }
        }
        out.push((name, decode(&value)));
    }
    out
}

fn parse_dom(src: &str) -> Vec<Node> {
    let mut stack: Vec<Open> = vec![("#root".into(), vec![], vec![])];
    let bytes = src;
    let mut i = 0;
    fn push(stack: &mut [Open], n: Node) {
        stack.last_mut().expect("root").2.push(n);
    }
    fn close_to(stack: &mut Vec<Open>, tag: &str) {
        if !stack.iter().skip(1).any(|(t, _, _)| t == tag) {
            return;
        }
        while stack.len() > 1 {
            let (t, attrs, kids) = stack.pop().expect("non-empty");
            let done = t == tag;
            stack.last_mut().expect("root").2.push(Node::El {
                tag: t,
                attrs,
                kids,
            });
            if done {
                break;
            }
        }
    }
    while i < bytes.len() {
        let rest = &bytes[i..];
        let Some(lt) = rest.find('<') else {
            push(&mut stack, Node::Text(decode(rest)));
            break;
        };
        if lt > 0 {
            push(&mut stack, Node::Text(decode(&rest[..lt])));
        }
        let tag_start = &rest[lt..];
        if let Some(body) = tag_start.strip_prefix("<!--") {
            i += lt + 4 + body.find("-->").map_or(body.len(), |e| e + 3);
            continue;
        }
        let Some(end) = tag_start.find('>') else {
            push(&mut stack, Node::Text(decode(tag_start)));
            break;
        };
        let inner = &tag_start[1..end];
        i += lt + end + 1;
        if inner.starts_with('!') || inner.starts_with('?') {
            continue;
        }
        if let Some(name) = inner.strip_prefix('/') {
            close_to(&mut stack, name.trim().to_ascii_lowercase().as_str());
            continue;
        }
        let name_end = inner
            .find(|c: char| c.is_whitespace() || c == '/')
            .unwrap_or(inner.len());
        let tag = inner[..name_end].to_ascii_lowercase();
        if tag.is_empty() || !tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            push(&mut stack, Node::Text(format!("<{inner}>")));
            continue;
        }
        let attrs = parse_attrs(&inner[name_end..]);
        if RAW.contains(&tag.as_str()) && !inner.ends_with('/') {
            let close = format!("</{tag}");
            let lower = bytes[i..].to_ascii_lowercase();
            let stop = lower.find(&close).unwrap_or(lower.len());
            let raw = &bytes[i..i + stop];
            let after = lower[stop..]
                .find('>')
                .map_or(lower.len(), |g| stop + g + 1);
            let kids = if tag == "script" || tag == "style" {
                vec![]
            } else {
                vec![Node::Text(decode(raw))]
            };
            push(&mut stack, Node::El { tag, attrs, kids });
            i += after;
            continue;
        }
        // Implied end tags for the common cases: a new item closes the open one, and a block
        // closes an open paragraph.
        if tag == "li" {
            if let Some(pos) = stack
                .iter()
                .rposition(|(t, _, _)| t == "li" || t == "ul" || t == "ol")
            {
                if stack[pos].0 == "li" {
                    close_to(&mut stack, "li");
                }
            }
        }
        if BLOCKY.contains(&tag.as_str()) && stack.last().is_some_and(|(t, _, _)| t == "p") {
            close_to(&mut stack, "p");
        }
        if VOID.contains(&tag.as_str()) || inner.ends_with('/') {
            push(
                &mut stack,
                Node::El {
                    tag,
                    attrs,
                    kids: vec![],
                },
            );
        } else if stack.len() > MAX_DEPTH {
            continue;
        } else {
            stack.push((tag, attrs, vec![]));
        }
    }
    while stack.len() > 1 {
        let (t, attrs, kids) = stack.pop().expect("non-empty");
        stack.last_mut().expect("root").2.push(Node::El {
            tag: t,
            attrs,
            kids,
        });
    }
    stack.pop().map(|(_, _, k)| k).unwrap_or_default()
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

fn text_content(nodes: &[Node], out: &mut String) {
    for n in nodes {
        match n {
            Node::Text(t) => out.push_str(t),
            Node::El { tag, kids, .. } => {
                if tag == "br" {
                    out.push('\n');
                }
                text_content(kids, out);
            }
        }
    }
}

const SKIP: &[&str] = &[
    "script", "style", "head", "title", "meta", "link", "noscript", "iframe", "object", "embed",
    "svg", "form", "button", "select", "textarea", "canvas", "template", "audio", "video",
    "source", "math",
];

fn push_text(out: &mut Vec<Inline>, text: &str, marks: &[Mark]) {
    if text.is_empty() {
        return;
    }
    if let Some(Inline::Text {
        text: last,
        marks: m,
    }) = out.last_mut()
    {
        if m == marks {
            last.push_str(text);
            return;
        }
    }
    out.push(Inline::Text {
        text: text.to_string(),
        marks: marks.to_vec(),
    });
}

fn collapse(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if c.is_whitespace() && c != '\u{a0}' {
            space = true;
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
    }
    if space {
        out.push(' ');
    }
    out
}

fn inline_of(nodes: &[Node], marks: &[Mark], out: &mut Vec<Inline>, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    for n in nodes {
        match n {
            Node::Text(t) => {
                let c = collapse(t);
                let c = if out.is_empty() {
                    c.trim_start().to_string()
                } else {
                    c
                };
                let c = if matches!(out.last(), Some(Inline::Text { text, .. }) if text.ends_with(' '))
                {
                    c.trim_start().to_string()
                } else {
                    c
                };
                push_text(out, &c, marks);
            }
            Node::El { tag, attrs, kids } => {
                if SKIP.contains(&tag.as_str()) {
                    continue;
                }
                let mut m = marks.to_vec();
                match tag.as_str() {
                    "br" => {
                        out.push(Inline::Break);
                        continue;
                    }
                    "img" => {
                        if let Some(src) = attr(attrs, "src").filter(|s| !s.is_empty()) {
                            out.push(Inline::Image {
                                src: src.to_string(),
                                alt: attr(attrs, "alt").unwrap_or("").to_string(),
                            });
                        }
                        continue;
                    }
                    "strong" | "b" => m.push(Mark::Bold),
                    "em" | "i" | "cite" => m.push(Mark::Italic),
                    "del" | "s" | "strike" => m.push(Mark::Strike),
                    "code" | "kbd" | "samp" | "tt" => m.push(Mark::Code),
                    "u" | "ins" => m.push(Mark::Underline),
                    "a" => {
                        if let Some(h) =
                            attr(attrs, "href").filter(|h| !h.is_empty() && safe_href(h))
                        {
                            m.retain(|x| !matches!(x, Mark::Link(_)));
                            m.push(Mark::Link(h.to_string()));
                        }
                    }
                    t if (BLOCKY.contains(&t) || matches!(t, "figcaption" | "dt" | "dd"))
                        && !out.is_empty()
                        && !matches!(out.last(), Some(Inline::Break)) =>
                    {
                        out.push(Inline::Break);
                    }
                    _ => {}
                }
                inline_of(kids, &m, out, depth + 1);
            }
        }
    }
}

fn trim_inline(mut v: Vec<Inline>) -> Vec<Inline> {
    while matches!(v.last(), Some(Inline::Break)) {
        v.pop();
    }
    if let Some(Inline::Text { text, .. }) = v.last_mut() {
        *text = text.trim_end().to_string();
    }
    if let Some(Inline::Text { text, .. }) = v.first_mut() {
        *text = text.trim_start().to_string();
    }
    v.retain(|i| !matches!(i, Inline::Text { text, .. } if text.is_empty()));
    v
}

fn inline_blk(kind: &str, kids: &[Node]) -> Blk {
    let mut v = Vec::new();
    inline_of(kids, &[], &mut v, 0);
    Blk::with_inline(kind, trim_inline(v))
}

fn image_meta(nodes: &[Node], outer: &[(String, String)]) -> Option<Media> {
    fn find(nodes: &[Node], p: &mut serde_json::Value) -> Option<(String, String)> {
        for node in nodes {
            if let Node::El { tag, attrs, kids } = node {
                if let Some(align) =
                    attr(attrs, "align").filter(|v| matches!(*v, "left" | "center" | "right"))
                {
                    p["align"] = serde_json::json!(align);
                }
                if tag == "a" {
                    if let Some(href) = attr(attrs, "href").filter(|h| super::blocks::safe_href(h))
                    {
                        p["link"] = serde_json::json!(href);
                    }
                }
                if tag == "img" {
                    let src = attr(attrs, "src")?.to_string();
                    let alt = attr(attrs, "alt").unwrap_or("").to_string();
                    p["alt"] = serde_json::json!(alt);
                    if let Some(width) = attr(attrs, "width") {
                        let percent = width.ends_with('%');
                        if let Ok(n) = width.trim_end_matches('%').parse::<f64>() {
                            if n.is_finite()
                                && n > 0.0
                                && n <= if percent { 100.0 } else { 100000.0 }
                            {
                                p["width"] = serde_json::json!(n);
                                p["widthMode"] =
                                    serde_json::json!(if percent { "percent" } else { "px" });
                            }
                        }
                    }
                    return Some((src, alt));
                }
                if let Some(result) = find(kids, p) {
                    return Some(result);
                }
            }
        }
        None
    }
    let mut p = serde_json::json!({});
    if let Some(align) = attr(outer, "align").filter(|v| matches!(*v, "left" | "center" | "right"))
    {
        p["align"] = serde_json::json!(align);
    }
    let (src, name) = find(nodes, &mut p)?;
    Some(Media {
        src: Some(src),
        name,
        attachment: None,
        presentation: p,
    })
}

fn is_block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "p" | "div"
            | "ul"
            | "ol"
            | "li"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "table"
            | "pre"
            | "blockquote"
            | "hr"
            | "details"
            | "section"
            | "article"
            | "main"
            | "header"
            | "footer"
            | "aside"
            | "nav"
            | "figure"
            | "figcaption"
            | "dl"
            | "dt"
            | "dd"
            | "body"
            | "html"
            | "center"
            | "address"
    )
}

fn list_blocks(tag: &str, kids: &[Node], depth: usize) -> Vec<Blk> {
    let kind = if tag == "ol" {
        "numbered_list"
    } else {
        "bullet_list"
    };
    kids.iter()
        .filter_map(|k| match k {
            Node::El { tag: t, kids, .. } if t == "li" => Some(list_item(kind, kids, depth)),
            _ => None,
        })
        .collect()
}

fn list_item(kind: &str, kids: &[Node], depth: usize) -> Blk {
    // The item's own text runs up to its first block child.
    let split = kids
        .iter()
        .position(|k| matches!(k, Node::El { tag, .. } if matches!(tag.as_str(), "ul" | "ol" | "table" | "pre" | "blockquote" | "hr" | "details")))
        .unwrap_or(kids.len());
    let (head, rest) = kids.split_at(split);
    let mut checked = None;
    let mut head_nodes: Vec<Node> = Vec::new();
    for n in head {
        match n {
            Node::El { tag, attrs, .. }
                if tag == "input" && attr(attrs, "type") == Some("checkbox") =>
            {
                checked = Some(attrs.iter().any(|(k, _)| k == "checked"));
            }
            other => head_nodes.push(other.clone()),
        }
    }
    let mut b = inline_blk(if checked.is_some() { "todo" } else { kind }, &head_nodes);
    b.checked = checked.unwrap_or(false);
    b.children = blocks_of(rest, depth + 1);
    b
}

fn flatten_quote(blocks: &[Blk], out: &mut Vec<Inline>) {
    for b in blocks {
        if !out.is_empty() {
            out.push(Inline::Break);
        }
        out.extend(b.inline.iter().cloned());
        if b.kind == "code" {
            out.push(plain(b.text.clone()));
        }
        flatten_quote(&b.children, out);
    }
}

fn blocks_of(nodes: &[Node], depth: usize) -> Vec<Blk> {
    let mut out: Vec<Blk> = Vec::new();
    if depth > MAX_DEPTH {
        return out;
    }
    let mut run: Vec<Node> = Vec::new();
    fn flush(run: &mut Vec<Node>, out: &mut Vec<Blk>) {
        if run.is_empty() {
            return;
        }
        let mut b = inline_blk("paragraph", run);
        if matches!(b.inline.as_slice(), [Inline::Image { .. }]) {
            b.media = image_meta(run, &[]);
        }
        run.clear();
        if !b.inline.is_empty() {
            out.push(b);
        }
    }
    for n in nodes {
        let Node::El { tag, attrs, kids } = n else {
            run.push(n.clone());
            continue;
        };
        if SKIP.contains(&tag.as_str()) {
            continue;
        }
        if !is_block_tag(tag) {
            run.push(n.clone());
            continue;
        }
        flush(&mut run, &mut out);
        match tag.as_str() {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                // Levels are clamped after the whole document is known (see `parse`).
                let level = tag[1..].parse::<usize>().unwrap_or(1);
                let b = inline_blk(&format!("heading_{level}"), kids);
                if !b.inline.is_empty() {
                    out.push(b);
                }
            }
            "p" | "dt" | "dd" | "figcaption" | "address" => {
                let mut b = inline_blk("paragraph", kids);
                if matches!(b.inline.as_slice(), [Inline::Image { .. }]) {
                    b.media = image_meta(kids, attrs);
                }
                if !b.inline.is_empty() {
                    out.push(b);
                }
            }
            "figure" => {
                if let Some(mut media) = image_meta(kids, attrs) {
                    if let Some(caption) = find_tag(kids, "figcaption") {
                        let mut text = String::new();
                        text_content(caption, &mut text);
                        media.presentation["caption"] = serde_json::json!(text.trim());
                    }
                    let mut b = Blk::with_inline(
                        "paragraph",
                        vec![Inline::Image {
                            src: media.src.clone().unwrap_or_default(),
                            alt: media.name.clone(),
                        }],
                    );
                    b.media = Some(media);
                    out.push(b);
                } else {
                    out.extend(blocks_of(kids, depth + 1));
                }
            }
            "ul" | "ol" => out.extend(list_blocks(tag, kids, depth)),
            "li" => out.push(list_item("bullet_list", kids, depth)),
            "blockquote" => {
                let inner = blocks_of(kids, depth + 1);
                let mut inline = Vec::new();
                flatten_quote(&inner, &mut inline);
                if !inline.is_empty() {
                    out.push(Blk::with_inline("quote", inline));
                }
            }
            "pre"
                if attr(attrs, "class")
                    .is_some_and(|c| c.split_whitespace().any(|w| w == "equation")) =>
            {
                let mut text = String::new();
                text_content(kids, &mut text);
                let mut b = Blk::new("equation");
                b.latex = text.trim().to_string();
                out.push(b);
            }
            "aside"
                if attr(attrs, "class")
                    .is_some_and(|c| c.split_whitespace().any(|w| w == "callout")) =>
            {
                let mut b = inline_blk("callout", kids);
                if let Some(t) = attr(attrs, "class").and_then(|c| {
                    c.split_whitespace()
                        .find(|w| matches!(*w, "tip" | "warning" | "note"))
                }) {
                    b.tone = t.to_string();
                }
                out.push(b);
            }
            "pre" => {
                let mut text = String::new();
                text_content(kids, &mut text);
                let lang = kids.iter().find_map(|k| match k {
                    Node::El { tag, attrs, .. } if tag == "code" => {
                        attr(attrs, "class").and_then(|c| {
                            c.split_whitespace().find_map(|w| {
                                w.strip_prefix("language-")
                                    .or_else(|| w.strip_prefix("lang-"))
                            })
                        })
                    }
                    _ => None,
                });
                let mut b = Blk::new("code");
                b.text = text.trim_end_matches('\n').to_string();
                b.language = lang.filter(|l| !l.is_empty()).map(String::from);
                out.push(b);
            }
            "hr" => out.push(Blk::new("divider")),
            "table" => {
                let mut rows: Table = Vec::new();
                fn walk(nodes: &[Node], rows: &mut Table) {
                    for n in nodes {
                        if let Node::El { tag, kids, .. } = n {
                            match tag.as_str() {
                                "tr" => rows.push(
                                    kids.iter()
                                        .filter_map(|c| match c {
                                            Node::El { tag, kids, .. }
                                                if tag == "td" || tag == "th" =>
                                            {
                                                let mut v = Vec::new();
                                                inline_of(kids, &[], &mut v, 0);
                                                Some(trim_inline(v))
                                            }
                                            _ => None,
                                        })
                                        .collect(),
                                ),
                                "thead" | "tbody" | "tfoot" => walk(kids, rows),
                                _ => {}
                            }
                        }
                    }
                }
                walk(kids, &mut rows);
                rows.truncate(500);
                if !rows.is_empty() {
                    let mut b = Blk::new("simple_table");
                    b.table = Some(rows);
                    out.push(b);
                }
            }
            "details" => {
                let summary = kids
                    .iter()
                    .find(|k| matches!(k, Node::El { tag, .. } if tag == "summary"));
                let body: Vec<Node> = kids
                    .iter()
                    .filter(|k| !matches!(k, Node::El { tag, .. } if tag == "summary"))
                    .cloned()
                    .collect();
                let mut b = match summary {
                    Some(Node::El { kids, .. }) => inline_blk("toggle", kids),
                    _ => Blk::with_inline("toggle", vec![plain("Details")]),
                };
                b.open = attrs.iter().any(|(k, _)| k == "open");
                b.children = blocks_of(&body, depth + 1);
                out.push(b);
            }
            "div" => {
                let mut inner = blocks_of(kids, depth + 1);
                if let Some(align) =
                    attr(attrs, "align").filter(|v| matches!(*v, "left" | "center" | "right"))
                {
                    visit_mut(&mut inner, &mut |b| {
                        if let Some(m) = &mut b.media {
                            if m.presentation.get("align").is_none() {
                                m.presentation["align"] = serde_json::json!(align);
                            }
                        }
                    });
                }
                out.extend(inner);
            }
            "dl" => out.extend(blocks_of(kids, depth + 1)),
            _ => out.extend(blocks_of(kids, depth + 1)),
        }
    }
    flush(&mut run, &mut out);
    out
}

fn find_tag<'a>(nodes: &'a [Node], name: &str) -> Option<&'a [Node]> {
    for n in nodes {
        if let Node::El { tag, kids, .. } = n {
            if tag == name {
                return Some(kids);
            }
            if let Some(f) = find_tag(kids, name) {
                return Some(f);
            }
        }
    }
    None
}

pub fn parse(src: &str) -> Parsed {
    let dom = parse_dom(src);
    fn losses(nodes: &[Node], tags: &mut std::collections::BTreeSet<String>) {
        for node in nodes {
            if let Node::El { tag, attrs, kids } = node {
                if SKIP.contains(&tag.as_str())
                    || !matches!(
                        tag.as_str(),
                        "html"
                            | "head"
                            | "body"
                            | "title"
                            | "meta"
                            | "p"
                            | "div"
                            | "span"
                            | "section"
                            | "article"
                            | "figure"
                            | "figcaption"
                            | "h1"
                            | "h2"
                            | "h3"
                            | "h4"
                            | "h5"
                            | "h6"
                            | "br"
                            | "hr"
                            | "a"
                            | "img"
                            | "ul"
                            | "ol"
                            | "li"
                            | "pre"
                            | "code"
                            | "blockquote"
                            | "aside"
                            | "table"
                            | "thead"
                            | "tbody"
                            | "tfoot"
                            | "tr"
                            | "td"
                            | "th"
                            | "details"
                            | "summary"
                            | "strong"
                            | "b"
                            | "em"
                            | "i"
                            | "u"
                            | "s"
                            | "del"
                            | "strike"
                            | "input"
                            | "dt"
                            | "dd"
                            | "address"
                    )
                {
                    tags.insert(tag.clone());
                }
                if attrs
                    .iter()
                    .any(|(key, _)| key == "style" || key.starts_with("on"))
                {
                    tags.insert("inline styles/event handlers".into());
                }
                losses(kids, tags);
            }
        }
    }
    let mut omitted = std::collections::BTreeSet::new();
    losses(&dom, &mut omitted);
    let warnings = if omitted.is_empty() {
        vec![]
    } else {
        vec![format!(
            "Unsupported HTML formatting was converted or omitted: {}",
            omitted.into_iter().collect::<Vec<_>>().join(", ")
        )]
    };
    let mut title = find_tag(&dom, "title").map(|k| {
        let mut s = String::new();
        text_content(k, &mut s);
        collapse(&s).trim().to_string()
    });
    let body = find_tag(&dom, "body").unwrap_or(&dom);
    let mut blocks = blocks_of(body, 0);
    let mut h1s = 0;
    visit(&blocks, &mut |b| h1s += (b.kind == "heading_1") as usize);
    let mut shift = 0;
    if let Some(first) = blocks.first() {
        if first.kind == "heading_1" {
            let h = plain_of(&first.inline).trim().to_string();
            if title.as_deref().is_none_or(str::is_empty) || title.as_deref() == Some(h.as_str()) {
                title = Some(h);
                blocks.remove(0);
                // A page whose only <h1> is its title uses <h2> for its top-level headings.
                shift = usize::from(h1s == 1);
            }
        }
    }
    visit_mut(&mut blocks, &mut |b| {
        if let Some(n) = b
            .kind
            .strip_prefix("heading_")
            .and_then(|n| n.parse::<usize>().ok())
        {
            b.kind = format!("heading_{}", n.saturating_sub(shift).clamp(1, 3));
        }
    });
    Parsed {
        title: title.filter(|t| !t.is_empty()),
        blocks,
        warnings,
    }
}

// ---------------------------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------------------------

pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Portable image markup. Private notes and crop coordinates never enter public output.
pub fn image_html(m: &Media, path: &str, figure: bool) -> String {
    let p = &m.presentation;
    let alt = esc(p
        .get("alt")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&m.name));
    let width = p
        .get("width")
        .and_then(serde_json::Value::as_f64)
        .filter(|w| w.is_finite() && *w > 0.0)
        .map(|w| {
            format!(
                " width=\"{}{suffix}\"",
                w,
                suffix = if p["widthMode"] == "percent" { "%" } else { "" }
            )
        })
        .unwrap_or_default();
    let align = p
        .get("align")
        .and_then(serde_json::Value::as_str)
        .filter(|v| matches!(*v, "left" | "center" | "right"))
        .unwrap_or("left");
    let mut image = format!("<img src=\"{}\" alt=\"{alt}\"{width}>", esc(path));
    if let Some(link) = p
        .get("link")
        .and_then(serde_json::Value::as_str)
        .filter(|h| super::blocks::safe_href(h) && crate::legacy::page_target(h).is_none())
    {
        image = format!("<a href=\"{}\">{image}</a>", esc(link));
    }
    let caption = p
        .get("caption")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty());
    if figure {
        format!(
            "<figure align=\"{align}\">{image}{}</figure>",
            caption
                .map(|c| format!("<figcaption>{}</figcaption>", esc(c)))
                .unwrap_or_default()
        )
    } else {
        format!(
            "<p align=\"{align}\">\n  {image}\n</p>{}",
            caption
                .map(|c| format!("\n\n{}", esc(c)))
                .unwrap_or_default()
        )
    }
}

fn safe_href(h: &str) -> bool {
    let l = h.trim().to_ascii_lowercase();
    !(l.starts_with("javascript:") || l.starts_with("data:") || l.starts_with("vbscript:"))
}

fn inline_html(items: &[Inline], ctx: &Ctx) -> String {
    let mut out = String::new();
    for it in items {
        match it {
            Inline::Text { text, marks } => {
                let mut s = esc(text);
                for m in marks {
                    s = match m {
                        Mark::Bold => format!("<strong>{s}</strong>"),
                        Mark::Italic => format!("<em>{s}</em>"),
                        Mark::Strike => format!("<del>{s}</del>"),
                        Mark::Code => format!("<code>{s}</code>"),
                        Mark::Underline => format!("<u>{s}</u>"),
                        Mark::Link(h)
                            if safe_href(h) && crate::legacy::page_target(h).is_none() =>
                        {
                            format!("<a href=\"{}\">{s}</a>", esc(h))
                        }
                        Mark::Link(_) => s,
                    };
                }
                out.push_str(&s);
            }
            Inline::Break => out.push_str("<br>"),
            Inline::Mention(id) => out.push_str(&format!(
                "<span class=\"mention\">{}</span>",
                esc(&(ctx.title)(id).unwrap_or_else(|| "page".into()))
            )),
            Inline::Image { src, alt } => {
                out.push_str(&format!("<img src=\"{}\" alt=\"{}\">", esc(src), esc(alt)))
            }
        }
    }
    out
}

fn blocks_html(blocks: &[Blk], ctx: &Ctx, out: &mut String) {
    let mut i = 0;
    while i < blocks.len() {
        let b = &blocks[i];
        let list = |k: &str| matches!(k, "bullet_list" | "numbered_list" | "todo");
        if list(&b.kind) {
            // One <ul>/<ol> per run of the same kind.
            let ordered = b.kind == "numbered_list";
            let todo = b.kind == "todo";
            out.push_str(if ordered {
                "<ol>"
            } else if todo {
                "<ul class=\"todo\">"
            } else {
                "<ul>"
            });
            while i < blocks.len() && blocks[i].kind == b.kind {
                let it = &blocks[i];
                out.push_str("<li>");
                if todo {
                    out.push_str(&format!(
                        "<input type=\"checkbox\" disabled{}> ",
                        if it.checked { " checked" } else { "" }
                    ));
                }
                out.push_str(&inline_html(&it.inline, ctx));
                blocks_html(&it.children, ctx, out);
                out.push_str("</li>");
                i += 1;
            }
            out.push_str(if ordered { "</ol>" } else { "</ul>" });
            continue;
        }
        match b.kind.as_str() {
            "heading_1" => out.push_str(&format!("<h2>{}</h2>", inline_html(&b.inline, ctx))),
            "heading_2" => out.push_str(&format!("<h3>{}</h3>", inline_html(&b.inline, ctx))),
            "heading_3" => out.push_str(&format!("<h4>{}</h4>", inline_html(&b.inline, ctx))),
            "paragraph" => {
                let t = inline_html(&b.inline, ctx);
                if !t.is_empty() {
                    out.push_str(&format!("<p>{t}</p>"));
                }
                blocks_html(&b.children, ctx, out);
            }
            "quote" => out.push_str(&format!(
                "<blockquote>{}</blockquote>",
                inline_html(&b.inline, ctx)
            )),
            "callout" => out.push_str(&format!(
                "<aside class=\"callout {}\">{}</aside>",
                esc(&b.tone),
                inline_html(&b.inline, ctx)
            )),
            "divider" => out.push_str("<hr>"),
            "code" => out.push_str(&format!(
                "<pre><code{}>{}</code></pre>",
                b.language
                    .as_ref()
                    .map(|l| format!(" class=\"language-{}\"", esc(l)))
                    .unwrap_or_default(),
                esc(&b.text)
            )),
            "equation" => out.push_str(&format!("<pre class=\"equation\">{}</pre>", esc(&b.latex))),
            "toggle" => {
                out.push_str(&format!(
                    "<details{}><summary>{}</summary>",
                    if b.open { " open" } else { "" },
                    inline_html(&b.inline, ctx)
                ));
                blocks_html(&b.children, ctx, out);
                out.push_str("</details>");
            }
            "simple_table" => {
                if let Some(rows) = &b.table {
                    out.push_str("<table>");
                    for (n, r) in rows.iter().enumerate() {
                        out.push_str("<tr>");
                        for c in r {
                            let t = if n == 0 { "th" } else { "td" };
                            out.push_str(&format!("<{t}>{}</{t}>", inline_html(c, ctx)));
                        }
                        out.push_str("</tr>");
                    }
                    out.push_str("</table>");
                }
            }
            k if is_media(k) => {
                if let Some(m) = &b.media {
                    if let Some(path) = (ctx.asset)(m) {
                        let p = esc(&path.replace(' ', "%20"));
                        let name = esc(&m.name);
                        out.push_str(&match k {
                            "image" => image_html(m, &path, true),
                            "audio" => format!("<audio controls src=\"{p}\"></audio>"),
                            "video" => format!("<video controls src=\"{p}\"></video>"),
                            _ => format!("<p><a href=\"{p}\">{name}</a></p>"),
                        });
                    }
                }
            }
            "tabs" => {
                blocks_html(&b.children, ctx, out);
            }
            "tab_panel" => {
                out.push_str(&format!("<section><h3>{}</h3>", esc(&b.label)));
                blocks_html(&b.children, ctx, out);
                out.push_str("</section>");
            }
            "columns" => {
                out.push_str("<div class=\"columns\">");
                blocks_html(&b.children, ctx, out);
                out.push_str("</div>");
            }
            "column" => {
                out.push_str("<div class=\"column\">");
                blocks_html(&b.children, ctx, out);
                out.push_str("</div>");
            }
            _ => {}
        }
        i += 1;
    }
}

const STYLE: &str = "body{font:16px/1.6 system-ui,Segoe UI,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1f1f1f}h1{font-size:2rem}pre{background:#f6f5f4;padding:12px;overflow:auto;border-radius:4px}code{font-family:ui-monospace,Consolas,monospace}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}blockquote{margin:0;padding-left:12px;border-left:3px solid #ccc;color:#555}.callout{padding:10px 14px;border-radius:6px;background:#f6f5f4}ul.todo{list-style:none;padding-left:4px}img{max-width:100%}.mention{background:#e0def7;border-radius:3px;padding:0 4px}.columns{display:flex;gap:24px;flex-wrap:wrap}.column{flex:1 1 200px;min-width:0}";

/// A complete, self-contained HTML document for one page.
pub fn render_document(title: &str, blocks: &[Blk], ctx: &Ctx) -> String {
    let mut body = String::new();
    blocks_html(blocks, ctx, &mut body);
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{t}</title>\n<style>{STYLE}</style>\n</head>\n<body>\n<h1>{t}</h1>\n{body}\n</body>\n</html>\n",
        t = esc(title)
    )
}

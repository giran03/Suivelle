//! Markdown to blocks and back. A practical CommonMark/GFM subset: headings, paragraphs, bullet,
//! numbered and task lists with nesting, quotes and GitHub-style callouts, fenced code, `$$`
//! equations, tables, thematic breaks, `<details>` toggles, images and links, and the usual
//! inline marks. Anything else is kept as plain text rather than dropped.

use super::blocks::*;

/// A parsed document: its title (from front matter, or a leading `# Heading`) and its blocks.
pub struct Parsed {
    pub title: Option<String>,
    pub blocks: Vec<Blk>,
}

const MAX_NEST: usize = 24;

fn expand_tabs(line: &str) -> String {
    if line.contains('\t') {
        line.replace('\t', "    ")
    } else {
        line.to_string()
    }
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

pub fn parse(src: &str) -> Parsed {
    let text = src
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut lines: Vec<String> = text.lines().map(expand_tabs).collect();
    let mut title = None;
    if lines.first().is_some_and(|l| l.trim_end() == "---") {
        if let Some(end) = lines
            .iter()
            .skip(1)
            .take(60)
            .position(|l| matches!(l.trim_end(), "---" | "..."))
        {
            for l in &lines[1..=end] {
                if let Some(v) = l.strip_prefix("title:") {
                    let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
                    if !v.is_empty() {
                        title = Some(v.to_string());
                    }
                }
            }
            lines.drain(..=end + 1);
        }
    }
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let mut blocks = parse_blocks(&refs, 0);
    if title.is_none() {
        if let Some(first) = blocks.first() {
            if first.kind == "heading_1" && !first.inline.is_empty() {
                title = Some(plain_of(&first.inline).trim().to_string());
                blocks.remove(0);
            }
        }
    }
    Parsed { title, blocks }
}

fn fence_open(line: &str) -> Option<(char, usize, String)> {
    let t = line.trim_start();
    if indent_of(line) > 3 {
        return None;
    }
    let c = t.chars().next()?;
    if c != '`' && c != '~' {
        return None;
    }
    let n = t.chars().take_while(|x| *x == c).count();
    if n < 3 {
        return None;
    }
    let info = t[n..].trim();
    if c == '`' && info.contains('`') {
        return None;
    }
    let lang = info.split_whitespace().next().unwrap_or("").to_string();
    Some((c, n, lang))
}

fn heading(line: &str) -> Option<(usize, &str)> {
    if indent_of(line) > 3 {
        return None;
    }
    let t = line.trim_start();
    let n = t.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&n) {
        return None;
    }
    let rest = &t[n..];
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }
    let body = rest.trim();
    let body = body.trim_end_matches('#').trim_end();
    Some((n, body))
}

fn is_hr(line: &str) -> bool {
    if indent_of(line) > 3 {
        return false;
    }
    let t: String = line.chars().filter(|c| *c != ' ').collect();
    t.len() >= 3
        && (t.chars().all(|c| c == '-')
            || t.chars().all(|c| c == '*')
            || t.chars().all(|c| c == '_'))
}

struct Item<'a> {
    indent: usize,
    ordered: bool,
    content_col: usize,
    text: &'a str,
}

fn list_item(line: &str) -> Option<Item<'_>> {
    let indent = indent_of(line);
    let t = &line[indent..];
    let (ordered, marker_len) =
        if let Some(c) = t.chars().next().filter(|c| matches!(c, '-' | '*' | '+')) {
            (false, c.len_utf8())
        } else {
            let digits = t.chars().take_while(char::is_ascii_digit).count();
            if !(1..=9).contains(&digits) || !t[digits..].starts_with(['.', ')']) {
                return None;
            }
            (true, digits + 1)
        };
    let rest = &t[marker_len..];
    if !(rest.is_empty() || rest.starts_with(' ')) {
        return None;
    }
    let spaces = rest.len() - rest.trim_start_matches(' ').len();
    let spaces = if spaces == 0 || spaces > 4 { 1 } else { spaces };
    Some(Item {
        indent,
        ordered,
        content_col: indent + marker_len + spaces,
        text: rest.trim_start_matches(' '),
    })
}

fn is_table_delim(line: &str) -> bool {
    let t = line.trim();
    if !t.contains('-') || !t.contains('|') && !t.starts_with(':') && !t.starts_with('-') {
        return false;
    }
    let cells: Vec<&str> = t.trim_matches('|').split('|').collect();
    !cells.is_empty()
        && cells.iter().all(|c| {
            let c = c.trim();
            !c.is_empty() && c.trim_matches(':').chars().all(|x| x == '-') && c.contains('-')
        })
}

fn split_row(line: &str) -> Vec<String> {
    let t = line.trim();
    let t = t.strip_prefix('|').unwrap_or(t);
    let t = t.strip_suffix('|').unwrap_or(t);
    let mut cells = vec![String::new()];
    let mut chars = t.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'|') => {
                chars.next();
                cells.last_mut().expect("a cell").push('|');
            }
            '|' => cells.push(String::new()),
            c => cells.last_mut().expect("a cell").push(c),
        }
    }
    cells.into_iter().map(|c| c.trim().to_string()).collect()
}

fn starts_block(line: &str) -> bool {
    heading(line).is_some()
        || fence_open(line).is_some()
        || is_hr(line)
        || line.trim_start().starts_with('>')
        || list_item(line).is_some()
        || line.trim() == "$$"
        || line.trim_start().starts_with("<details")
}

fn callout_tone(tag: &str) -> Option<&'static str> {
    match tag.to_ascii_uppercase().as_str() {
        "NOTE" | "INFO" => Some("note"),
        "TIP" | "HINT" | "SUCCESS" => Some("tip"),
        "WARNING" | "CAUTION" | "IMPORTANT" | "DANGER" => Some("warning"),
        _ => None,
    }
}

/// Text of a block for use inside a quote, where only inline content is allowed.
fn flatten_inline(blocks: &[Blk], out: &mut Vec<Inline>) {
    for b in blocks {
        if !out.is_empty() {
            out.push(Inline::Break);
        }
        let prefix = match b.kind.as_str() {
            "bullet_list" => "• ",
            "todo" => {
                if b.checked {
                    "☑ "
                } else {
                    "☐ "
                }
            }
            _ => "",
        };
        if !prefix.is_empty() {
            out.push(plain(prefix));
        }
        out.extend(b.inline.iter().cloned());
        if b.kind == "code" {
            out.push(plain(b.text.clone()));
        }
        let mut kids = Vec::new();
        flatten_inline(&b.children, &mut kids);
        if !kids.is_empty() {
            out.push(Inline::Break);
            out.extend(kids);
        }
    }
}

#[allow(clippy::nonminimal_bool)]
fn parse_blocks(lines: &[&str], depth: usize) -> Vec<Blk> {
    let mut out: Vec<Blk> = Vec::new();
    if depth > MAX_NEST {
        let joined = lines.join(" ");
        if !joined.trim().is_empty() {
            out.push(Blk::with_inline("paragraph", vec![plain(joined.trim())]));
        }
        return out;
    }
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        if ["<p ", "<p>", "<div ", "<figure", "<img "]
            .iter()
            .any(|tag| line.trim_start().starts_with(tag))
        {
            let start = i;
            while i < lines.len() && !lines[i].trim().is_empty() {
                i += 1;
            }
            let parsed = super::html::parse(&lines[start..i].join("\n"));
            out.extend(parsed.blocks);
            continue;
        }
        if let Some((c, n, lang)) = fence_open(line) {
            let mut body = Vec::new();
            i += 1;
            while i < lines.len() {
                let l = lines[i].trim();
                if l.starts_with(&c.to_string().repeat(n)) && l.chars().all(|x| x == c) {
                    i += 1;
                    break;
                }
                body.push(lines[i]);
                i += 1;
            }
            let strip = indent_of(line).min(3);
            let text = body
                .iter()
                .map(|l| l.get(strip.min(indent_of(l))..).unwrap_or(l))
                .collect::<Vec<_>>()
                .join("\n");
            let mut b = Blk::new("code");
            b.text = text;
            b.language = (!lang.is_empty()).then_some(lang);
            out.push(b);
            continue;
        }
        if line.trim_start().starts_with("$$") {
            let t = line.trim();
            let mut b = Blk::new("equation");
            if t.len() > 4 && t.ends_with("$$") {
                b.latex = t[2..t.len() - 2].trim().to_string();
                i += 1;
            } else {
                let mut body = vec![t[2..].trim().to_string()];
                i += 1;
                while i < lines.len() {
                    let l = lines[i].trim();
                    i += 1;
                    if let Some(head) = l.strip_suffix("$$") {
                        body.push(head.trim().to_string());
                        break;
                    }
                    body.push(l.to_string());
                }
                b.latex = body
                    .iter()
                    .filter(|s| !s.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");
            }
            out.push(b);
            continue;
        }
        if let Some((level, body)) = heading(line) {
            out.push(Blk::with_inline(
                &format!("heading_{}", level.min(3)),
                parse_inline(body),
            ));
            i += 1;
            continue;
        }
        if is_hr(line) {
            out.push(Blk::new("divider"));
            i += 1;
            continue;
        }
        if line.trim_start().starts_with("<details") {
            let mut level = 0usize;
            let mut body: Vec<&str> = Vec::new();
            let start = i;
            while i < lines.len() {
                let l = lines[i].trim();
                level += l.matches("<details").count();
                let closes = l.matches("</details>").count();
                if i > start || closes == 0 {
                    body.push(lines[i]);
                }
                level = level.saturating_sub(closes);
                i += 1;
                if level == 0 {
                    break;
                }
            }
            let open = line.contains(" open");
            let mut summary = String::new();
            let mut rest: Vec<&str> = Vec::new();
            let mut seen_summary = false;
            for l in body.iter().skip(1) {
                let t = l.trim();
                if !seen_summary && t.starts_with("<summary") {
                    seen_summary = true;
                    let inner = t.trim_start_matches(|c| c != '>').trim_start_matches('>');
                    summary = inner
                        .split("</summary>")
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    continue;
                }
                if t == "</details>" && std::ptr::eq(*l, *body.last().unwrap_or(l)) {
                    continue;
                }
                rest.push(l);
            }
            if let Some(last) = rest.last() {
                if last.trim() == "</details>" {
                    rest.pop();
                }
            }
            let mut b = Blk::with_inline("toggle", parse_inline(&summary));
            b.open = open;
            b.children = parse_blocks(&rest, depth + 1);
            out.push(b);
            continue;
        }
        if line.trim_start().starts_with('>') {
            let mut quoted: Vec<String> = Vec::new();
            while i < lines.len() && lines[i].trim_start().starts_with('>') {
                let l = lines[i].trim_start()[1..]
                    .strip_prefix(' ')
                    .unwrap_or(&lines[i].trim_start()[1..]);
                quoted.push(l.to_string());
                i += 1;
            }
            let tone = quoted
                .first()
                .and_then(|f| f.trim().strip_prefix("[!"))
                .and_then(|f| f.strip_suffix(']'))
                .and_then(callout_tone);
            if tone.is_some() {
                quoted.remove(0);
            }
            let refs: Vec<&str> = quoted.iter().map(String::as_str).collect();
            let inner = parse_blocks(&refs, depth + 1);
            let mut inline = Vec::new();
            flatten_inline(&inner, &mut inline);
            let mut b = Blk::with_inline(if tone.is_some() { "callout" } else { "quote" }, inline);
            if let Some(t) = tone {
                b.tone = t.into();
            }
            out.push(b);
            continue;
        }
        if i + 1 < lines.len() && line.contains('|') && is_table_delim(lines[i + 1]) {
            let mut rows: Table = vec![split_row(line).iter().map(|c| parse_inline(c)).collect()];
            i += 2;
            while i < lines.len() && !lines[i].trim().is_empty() && lines[i].contains('|') {
                rows.push(
                    split_row(lines[i])
                        .iter()
                        .map(|c| parse_inline(c))
                        .collect(),
                );
                i += 1;
            }
            let mut b = Blk::new("simple_table");
            b.table = Some(rows);
            out.push(b);
            continue;
        }
        if let Some(first) = list_item(line) {
            let base = first.indent;
            while i < lines.len() {
                let Some(item) = list_item(lines[i]) else {
                    break;
                };
                if item.indent != base {
                    break;
                }
                let mut head = vec![item.text.to_string()];
                let mut body: Vec<String> = Vec::new();
                let col = item.content_col;
                i += 1;
                let mut in_body = false;
                while i < lines.len() {
                    let l = lines[i];
                    if l.trim().is_empty() {
                        // A blank line belongs to the item only if more indented content follows.
                        let next = lines[i + 1..].iter().find(|x| !x.trim().is_empty());
                        if next.is_some_and(|n| indent_of(n) >= col) {
                            body.push(String::new());
                            i += 1;
                            in_body = true;
                            continue;
                        }
                        break;
                    }
                    if indent_of(l) > base {
                        let strip = col.min(indent_of(l));
                        let rest = l[strip..].to_string();
                        if !in_body && !starts_block(&rest) {
                            head.push(rest.trim().to_string());
                        } else {
                            in_body = true;
                            body.push(rest);
                        }
                        i += 1;
                        continue;
                    }
                    break;
                }
                let mut text = head.join(" ");
                let mut kind = if item.ordered {
                    "numbered_list"
                } else {
                    "bullet_list"
                };
                let mut checked = false;
                {
                    let t = text.trim_start();
                    if let Some(r) = t
                        .strip_prefix("[ ] ")
                        .or_else(|| t.strip_prefix("[ ]").filter(|r| r.is_empty()))
                    {
                        kind = "todo";
                        text = r.to_string();
                    } else if let Some(r) =
                        t.strip_prefix("[x] ").or_else(|| t.strip_prefix("[X] "))
                    {
                        kind = "todo";
                        checked = true;
                        text = r.to_string();
                    }
                }
                let mut b = Blk::with_inline(kind, parse_inline(text.trim()));
                b.checked = checked;
                let refs: Vec<&str> = body.iter().map(String::as_str).collect();
                b.children = parse_blocks(&refs, depth + 1);
                out.push(b);
            }
            continue;
        }
        // A paragraph: consecutive lines until something else starts.
        let mut para = vec![line.trim().to_string()];
        i += 1;
        while i < lines.len()
            && !lines[i].trim().is_empty()
            && !starts_block(lines[i])
            && !(i + 1 < lines.len() && lines[i].contains('|') && is_table_delim(lines[i + 1]))
        {
            para.push(lines[i].trim_start().to_string());
            i += 1;
        }
        let mut text = String::new();
        for (n, l) in para.iter().enumerate() {
            text.push_str(l.trim_end_matches(' '));
            if n + 1 < para.len() {
                let hard = l.ends_with("  ") || l.ends_with('\\');
                if hard {
                    if text.ends_with('\\') {
                        text.pop();
                    }
                    text.push('\u{1}');
                } else {
                    text.push(' ');
                }
            }
        }
        out.push(Blk::with_inline("paragraph", parse_inline(&text)));
    }
    out
}

// ---------------------------------------------------------------------------------------------
// inline
// ---------------------------------------------------------------------------------------------

pub fn parse_inline(s: &str) -> Vec<Inline> {
    let mut out = Vec::new();
    inline_into(s, &[], &mut out, 0);
    merge(out)
}

fn merge(items: Vec<Inline>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::new();
    for it in items {
        match (&mut out.last_mut(), &it) {
            (
                Some(Inline::Text { text, marks }),
                Inline::Text {
                    text: t2,
                    marks: m2,
                },
            ) if marks == m2 => text.push_str(t2),
            _ => out.push(it),
        }
    }
    out
}

fn push_text(out: &mut Vec<Inline>, text: &str, marks: &[Mark]) {
    if text.is_empty() {
        return;
    }
    for (n, part) in text.split('\u{1}').enumerate() {
        if n > 0 {
            out.push(Inline::Break);
        }
        if !part.is_empty() {
            out.push(Inline::Text {
                text: part.to_string(),
                marks: marks.to_vec(),
            });
        }
    }
}

fn find_close(chars: &[char], from: usize, delim: &[char]) -> Option<usize> {
    let mut i = from;
    while i + delim.len() <= chars.len() {
        match chars[i] {
            '\\' => i += 2,
            '`' => {
                // Code spans protect their contents.
                let n = chars[i..].iter().take_while(|c| **c == '`').count();
                let mut j = i + n;
                let mut found = None;
                while j + n <= chars.len() {
                    if chars[j..j + n].iter().all(|c| *c == '`') && chars.get(j + n) != Some(&'`') {
                        found = Some(j + n);
                        break;
                    }
                    j += 1;
                }
                i = found.unwrap_or(i + n);
            }
            _ if chars[i..i + delim.len()] == *delim => {
                let prev_ws = i == from || chars[i - 1].is_whitespace();
                let more = chars.get(i + delim.len()) == Some(&delim[0]);
                let word_edge = delim[0] != '_'
                    || chars
                        .get(i + delim.len())
                        .is_none_or(|c| !c.is_alphanumeric());
                if !prev_ws && !more && word_edge {
                    return Some(i);
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    None
}

fn bracket_end(chars: &[char], open: usize) -> Option<usize> {
    let mut depth = 0;
    let mut i = open;
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 1,
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// `(url "title")` starting at `open`, returning the url and the index after `)`.
fn link_target(chars: &[char], open: usize) -> Option<(String, usize)> {
    if chars.get(open) != Some(&'(') {
        return None;
    }
    let mut i = open + 1;
    while chars.get(i) == Some(&' ') {
        i += 1;
    }
    let mut url = String::new();
    if chars.get(i) == Some(&'<') {
        i += 1;
        while i < chars.len() && chars[i] != '>' {
            url.push(chars[i]);
            i += 1;
        }
        i += 1;
    } else {
        let mut depth = 0;
        while i < chars.len() {
            match chars[i] {
                '\\' if i + 1 < chars.len() => {
                    url.push(chars[i + 1]);
                    i += 1;
                }
                '(' => {
                    depth += 1;
                    url.push('(');
                }
                ')' if depth == 0 => break,
                ')' => {
                    depth -= 1;
                    url.push(')');
                }
                c if c.is_whitespace() => break,
                c => url.push(c),
            }
            i += 1;
        }
    }
    while chars.get(i).is_some_and(|c| c.is_whitespace()) {
        i += 1;
    }
    if matches!(chars.get(i), Some('"' | '\'')) {
        let q = chars[i];
        i += 1;
        while i < chars.len() && chars[i] != q {
            i += 1;
        }
        i += 1;
        while chars.get(i).is_some_and(|c| c.is_whitespace()) {
            i += 1;
        }
    }
    (chars.get(i) == Some(&')')).then_some((url, i + 1))
}

fn inline_into(s: &str, marks: &[Mark], out: &mut Vec<Inline>, depth: usize) {
    let chars: Vec<char> = s.chars().collect();
    if depth > 12 {
        push_text(out, s, marks);
        return;
    }
    let mut buf = String::new();
    let mut i = 0;
    macro_rules! flush {
        () => {
            push_text(out, &std::mem::take(&mut buf), marks);
        };
    }
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' if i + 1 < chars.len() && chars[i + 1].is_ascii_punctuation() => {
                buf.push(chars[i + 1]);
                i += 2;
            }
            '`' => {
                let n = chars[i..].iter().take_while(|x| **x == '`').count();
                let mut j = i + n;
                let mut close = None;
                while j + n <= chars.len() {
                    if chars[j..j + n].iter().all(|x| *x == '`') && chars.get(j + n) != Some(&'`') {
                        close = Some(j);
                        break;
                    }
                    j += 1;
                }
                if let Some(j) = close {
                    flush!();
                    let code: String = chars[i + n..j].iter().collect();
                    let mut m = marks.to_vec();
                    m.push(Mark::Code);
                    push_text(out, code.trim_matches(' '), &m);
                    i = j + n;
                } else {
                    buf.push_str(&"`".repeat(n));
                    i += n;
                }
            }
            '!' if chars.get(i + 1) == Some(&'[') => {
                if let Some(end) = bracket_end(&chars, i + 1) {
                    if let Some((url, next)) = link_target(&chars, end + 1) {
                        flush!();
                        out.push(Inline::Image {
                            src: url,
                            alt: chars[i + 2..end].iter().collect(),
                        });
                        i = next;
                        continue;
                    }
                }
                buf.push('!');
                i += 1;
            }
            '[' => {
                if let Some(end) = bracket_end(&chars, i) {
                    if let Some((url, next)) = link_target(&chars, end + 1) {
                        flush!();
                        let inner: String = chars[i + 1..end].iter().collect();
                        let mut m = marks.to_vec();
                        m.retain(|x| !matches!(x, Mark::Link(_)));
                        if safe_href(&url) {
                            m.push(Mark::Link(url));
                        }
                        inline_into(&inner, &m, out, depth + 1);
                        i = next;
                        continue;
                    }
                }
                buf.push('[');
                i += 1;
            }
            '<' => {
                let rest: String = chars[i..].iter().take(300).collect();
                if let Some(end) = rest.find('>') {
                    let inner = &rest[1..end];
                    if inner.starts_with("http://")
                        || inner.starts_with("https://")
                        || inner.starts_with("mailto:")
                    {
                        flush!();
                        let mut m = marks.to_vec();
                        m.push(Mark::Link(inner.to_string()));
                        push_text(out, inner, &m);
                        i += rest[..=end].chars().count();
                        continue;
                    }
                    if inner == "br" || inner == "br/" || inner == "br /" {
                        flush!();
                        out.push(Inline::Break);
                        i += rest[..=end].chars().count();
                        continue;
                    }
                    if inner == "u" || inner == "/u" {
                        // underline, handled below by scanning for the pair
                    }
                    if inner == "u" {
                        let tail: Vec<char> = chars[i + end + 1..].to_vec();
                        let close: Vec<char> = "</u>".chars().collect();
                        if let Some(j) = tail.windows(4).position(|w| w == close.as_slice()) {
                            flush!();
                            let body: String = tail[..j].iter().collect();
                            let mut m = marks.to_vec();
                            m.push(Mark::Underline);
                            inline_into(&body, &m, out, depth + 1);
                            i += end + 1 + j + 4;
                            continue;
                        }
                    }
                }
                buf.push('<');
                i += 1;
            }
            '*' | '_' | '~' => {
                let n = chars[i..].iter().take_while(|x| **x == c).count();
                let (len, mark) = match (c, n) {
                    ('~', 2..) => (2, Some(Mark::Strike)),
                    ('~', _) => (0, None),
                    (_, 2..) => (2, Some(Mark::Bold)),
                    _ => (1, Some(Mark::Italic)),
                };
                let opens = chars.get(i + len).is_some_and(|x| !x.is_whitespace());
                let intraword = c == '_' && i > 0 && chars[i - 1].is_alphanumeric();
                if let (Some(mark), true, false) = (mark, opens, intraword) {
                    let delim: Vec<char> = vec![c; len];
                    if let Some(close) = find_close(&chars, i + len, &delim) {
                        flush!();
                        let inner: String = chars[i + len..close].iter().collect();
                        let mut m = marks.to_vec();
                        m.push(mark);
                        inline_into(&inner, &m, out, depth + 1);
                        i = close + len;
                        continue;
                    }
                }
                buf.push(c);
                i += 1;
            }
            'h' if chars[i..].starts_with(&['h', 't', 't', 'p'])
                && (chars[i..].starts_with(&"http://".chars().collect::<Vec<_>>())
                    || chars[i..].starts_with(&"https://".chars().collect::<Vec<_>>()))
                && (i == 0 || !chars[i - 1].is_alphanumeric())
                && !marks
                    .iter()
                    .any(|m| matches!(m, Mark::Link(_) | Mark::Code)) =>
            {
                let mut j = i;
                while j < chars.len()
                    && !chars[j].is_whitespace()
                    && !matches!(chars[j], '<' | '>' | '"')
                {
                    j += 1;
                }
                while j > i
                    && matches!(chars[j - 1], '.' | ',' | ';' | ':' | '!' | '?' | ')' | '\'')
                {
                    j -= 1;
                }
                flush!();
                let url: String = chars[i..j].iter().collect();
                let mut m = marks.to_vec();
                m.push(Mark::Link(url.clone()));
                push_text(out, &url, &m);
                i = j;
            }
            _ => {
                buf.push(c);
                i += 1;
            }
        }
    }
    flush!();
}

// ---------------------------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------------------------

pub struct Ctx<'a> {
    /// The path to write for a media block's file (relative to the Markdown file).
    pub asset: &'a dyn Fn(&Media) -> Option<String>,
    /// The title of a mentioned page.
    pub title: &'a dyn Fn(&str) -> Option<String>,
}

fn escape(text: &str, in_table: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' | '*' | '_' | '`' | '[' | ']' | '<' | '>' | '~' => {
                out.push('\\');
                out.push(c);
            }
            '|' if in_table => out.push_str("\\|"),
            '\n' if in_table => out.push_str("<br>"),
            c => out.push(c),
        }
    }
    out
}

fn wrap_text(text: &str, marks: &[Mark], in_table: bool) -> String {
    let lead = text.len() - text.trim_start().len();
    let trail = text.len() - text.trim_end().len();
    if lead == text.len() {
        return text.to_string();
    }
    let core = &text[lead..text.len() - trail];
    let mut s = if marks.contains(&Mark::Code) {
        let fence = "`".repeat(longest_run(core, '`') + 1);
        format!("{fence}{core}{fence}")
    } else {
        escape(core, in_table)
    };
    for m in marks {
        s = match m {
            Mark::Bold => format!("**{s}**"),
            Mark::Italic => format!("*{s}*"),
            Mark::Strike => format!("~~{s}~~"),
            Mark::Underline => format!("<u>{s}</u>"),
            _ => s,
        };
    }
    if let Some(Mark::Link(href)) = marks.iter().find(|m| matches!(m, Mark::Link(_))) {
        s = format!("[{s}]({})", href.replace(' ', "%20").replace(')', "%29"));
    }
    format!("{}{}{}", &text[..lead], s, &text[text.len() - trail..])
}

fn longest_run(s: &str, c: char) -> usize {
    let mut best = 0;
    let mut cur = 0;
    for x in s.chars() {
        if x == c {
            cur += 1;
            best = best.max(cur);
        } else {
            cur = 0;
        }
    }
    best
}

pub fn render_inline(items: &[Inline], ctx: &Ctx, in_table: bool) -> String {
    let mut out = String::new();
    for it in items {
        match it {
            Inline::Text { text, marks } => out.push_str(&wrap_text(text, marks, in_table)),
            Inline::Break => out.push_str(if in_table { "<br>" } else { "  \n" }),
            Inline::Mention(id) => {
                let title = (ctx.title)(id).unwrap_or_else(|| "page".into());
                out.push_str(&format!(
                    "[{}](suivelle://page/{id})",
                    escape(&title, in_table)
                ));
            }
            Inline::Image { src, alt } => {
                out.push_str(&format!("![{}]({src})", escape(alt, in_table)))
            }
        }
    }
    out
}

fn indent_lines(s: &str, pad: &str) -> String {
    s.lines()
        .map(|l| {
            if l.is_empty() {
                String::new()
            } else {
                format!("{pad}{l}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn render(blocks: &[Blk], ctx: &Ctx) -> String {
    let mut parts: Vec<(bool, String)> = Vec::new();
    let mut number = 0usize;
    for b in blocks {
        if b.kind == "numbered_list" {
            number += 1;
        } else {
            number = 0;
        }
        if let Some(s) = render_block(b, ctx, number) {
            let is_list = matches!(b.kind.as_str(), "bullet_list" | "numbered_list" | "todo");
            parts.push((is_list, s));
        }
    }
    let mut out = String::new();
    for (i, (is_list, s)) in parts.iter().enumerate() {
        if i > 0 {
            out.push_str(if *is_list && parts[i - 1].0 {
                "\n"
            } else {
                "\n\n"
            });
        }
        out.push_str(s);
    }
    out
}

fn render_block(b: &Blk, ctx: &Ctx, number: usize) -> Option<String> {
    let text = || render_inline(&b.inline, ctx, false);
    let kids = |pad: &str| -> String {
        if b.children.is_empty() {
            return String::new();
        }
        let inner = render(&b.children, ctx);
        format!("\n{}", indent_lines(&inner, pad))
    };
    Some(match b.kind.as_str() {
        "heading_1" => format!("# {}", text()),
        "heading_2" => format!("## {}", text()),
        "heading_3" => format!("### {}", text()),
        "paragraph" => {
            let t = text();
            if t.trim().is_empty() && b.children.is_empty() {
                return None;
            }
            format!("{t}{}", kids("    "))
        }
        "bullet_list" => format!("- {}{}", text(), kids("    ")),
        "numbered_list" => format!("{number}. {}{}", text(), kids("    ")),
        "todo" => format!(
            "- [{}] {}{}",
            if b.checked { "x" } else { " " },
            text(),
            kids("    ")
        ),
        "quote" => indent_lines(&text().replace("  \n", "\n"), "> ").replace("\n\n", "\n>\n"),
        "callout" => {
            let tag = match b.tone.as_str() {
                "tip" => "TIP",
                "warning" => "WARNING",
                _ => "NOTE",
            };
            format!(
                "> [!{tag}]\n{}",
                indent_lines(&text().replace("  \n", "\n"), "> ")
            )
        }
        "divider" => "---".into(),
        "code" => {
            let fence = "`".repeat((longest_run(&b.text, '`') + 1).max(3));
            format!(
                "{fence}{}\n{}\n{fence}",
                b.language.clone().unwrap_or_default(),
                b.text
            )
        }
        "equation" => format!("$$\n{}\n$$", b.latex),
        "toggle" => {
            let inner = render(&b.children, ctx);
            format!(
                "<details{}>\n<summary>{}</summary>\n\n{}{}\n</details>",
                if b.open { " open" } else { "" },
                render_inline(&b.inline, ctx, true),
                inner,
                if inner.is_empty() { "" } else { "\n" }
            )
        }
        "simple_table" => {
            let rows = b.table.as_ref()?;
            let width = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
            let line = |cells: &Vec<Vec<Inline>>| {
                let cells: Vec<String> = (0..width)
                    .map(|c| {
                        cells
                            .get(c)
                            .map(|x| render_inline(x, ctx, true))
                            .unwrap_or_default()
                    })
                    .collect();
                format!("| {} |", cells.join(" | "))
            };
            let mut lines = vec![line(rows.first()?)];
            lines.push(format!("|{}|", vec![" --- "; width].join("|")));
            lines.extend(rows.iter().skip(1).map(line));
            lines.join("\n")
        }
        k if is_media(k) => {
            let m = b.media.as_ref()?;
            let path = (ctx.asset)(m)?;
            let path = path.replace(' ', "%20");
            if k == "image" {
                if m.presentation.as_object().is_some_and(|p| {
                    p.keys()
                        .any(|k| matches!(k.as_str(), "width" | "align" | "caption" | "link"))
                }) {
                    super::html::image_html(m, &path, false)
                } else {
                    format!(
                        "![{}]({path})",
                        escape(
                            m.presentation
                                .get("alt")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or(&m.name),
                            false
                        )
                    )
                }
            } else {
                format!("[{}]({path})", escape(&m.name, false))
            }
        }
        // Markdown has no columns: their content is written one column after another.
        "tab_panel" => format!(
            "### {}\n\n{}",
            b.label.replace('\n', " "),
            render(&b.children, ctx)
        ),
        "tabs" | "columns" | "column" => {
            let inner = render(&b.children, ctx);
            if inner.is_empty() {
                return None;
            }
            inner
        }
        _ => return None,
    })
}

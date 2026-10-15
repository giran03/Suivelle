//! Edits one member of a JSON or JSONC file (comments, trailing commas) by splicing text, so
//! everything else (comments, key order, indentation, line endings) stays byte for byte.

use serde_json::Value;

#[derive(Debug)]
pub enum Kind {
    Object(Vec<Member>),
    Array(Vec<Node>),
    Str(String),
    Num(String),
    Bool(bool),
    Null,
}

#[derive(Debug)]
pub struct Node {
    pub start: usize,
    pub end: usize,
    pub kind: Kind,
}

#[derive(Debug)]
pub struct Member {
    pub key: String,
    pub key_start: usize,
    pub value: Node,
    /// The comma after the value, when there is one.
    pub comma: Option<usize>,
}

struct Parser<'a> {
    s: &'a [u8],
    text: &'a str,
    i: usize,
    depth: usize,
}

impl Parser<'_> {
    fn err<T>(&self, what: &str) -> Result<T, String> {
        let line = self.text[..self.i.min(self.text.len())].matches('\n').count() + 1;
        Err(format!("{what} on line {line}"))
    }

    /// Skips whitespace and comments.
    fn ws(&mut self) -> Result<(), String> {
        loop {
            while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
                self.i += 1;
            }
            if self.s[self.i..].starts_with(b"//") {
                while self.i < self.s.len() && self.s[self.i] != b'\n' {
                    self.i += 1;
                }
            } else if self.s[self.i..].starts_with(b"/*") {
                match self.text[self.i + 2..].find("*/") {
                    Some(at) => self.i += 2 + at + 2,
                    None => return self.err("Unclosed comment"),
                }
            } else {
                return Ok(());
            }
        }
    }

    fn string(&mut self) -> Result<String, String> {
        // At the opening quote.
        self.i += 1;
        let mut out = String::new();
        loop {
            let Some(&c) = self.s.get(self.i) else {
                return self.err("Unclosed string");
            };
            match c {
                b'"' => {
                    self.i += 1;
                    return Ok(out);
                }
                b'\\' => {
                    let Some(&e) = self.s.get(self.i + 1) else {
                        return self.err("Unclosed string");
                    };
                    self.i += 2;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let ch = if (0xD800..0xDC00).contains(&hi) && self.s[self.i..].starts_with(b"\\u") {
                                self.i += 2;
                                let lo = self.hex4()?;
                                char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo.wrapping_sub(0xDC00) & 0x3FF))
                            } else {
                                char::from_u32(hi)
                            };
                            out.push(ch.unwrap_or('\u{FFFD}'));
                        }
                        _ => return self.err("Bad escape in a string"),
                    }
                }
                _ => {
                    // Copy one UTF-8 character.
                    let ch = self.text[self.i..].chars().next().unwrap_or('\u{FFFD}');
                    out.push(ch);
                    self.i += ch.len_utf8();
                }
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let Some(h) = self.text.get(self.i..self.i + 4) else {
            return self.err("Bad unicode escape");
        };
        let v = u32::from_str_radix(h, 16).or_else(|_| self.err("Bad unicode escape"))?;
        self.i += 4;
        Ok(v)
    }

    fn value(&mut self) -> Result<Node, String> {
        self.ws()?;
        let start = self.i;
        let Some(&c) = self.s.get(self.i) else {
            return self.err("Unexpected end of file");
        };
        let kind = match c {
            b'{' => {
                self.depth += 1;
                if self.depth > 200 {
                    return self.err("Nested too deeply");
                }
                self.i += 1;
                let mut members: Vec<Member> = Vec::new();
                loop {
                    self.ws()?;
                    match self.s.get(self.i) {
                        Some(b'}') => {
                            self.i += 1;
                            break;
                        }
                        Some(b'"') => {}
                        _ => return self.err("Expected a key or }"),
                    }
                    if members.last().is_some_and(|m| m.comma.is_none()) {
                        return self.err("Expected , between members");
                    }
                    let key_start = self.i;
                    let key = self.string()?;
                    self.ws()?;
                    if self.s.get(self.i) != Some(&b':') {
                        return self.err("Expected :");
                    }
                    self.i += 1;
                    let value = self.value()?;
                    self.ws()?;
                    let comma = if self.s.get(self.i) == Some(&b',') {
                        self.i += 1;
                        Some(self.i - 1)
                    } else {
                        None
                    };
                    members.push(Member { key, key_start, value, comma });
                }
                self.depth -= 1;
                Kind::Object(members)
            }
            b'[' => {
                self.depth += 1;
                if self.depth > 200 {
                    return self.err("Nested too deeply");
                }
                self.i += 1;
                let mut items = Vec::new();
                let mut need_comma = false;
                loop {
                    self.ws()?;
                    match self.s.get(self.i) {
                        Some(b']') => {
                            self.i += 1;
                            break;
                        }
                        Some(b',') if need_comma => {
                            self.i += 1;
                            need_comma = false;
                            continue;
                        }
                        None => return self.err("Unclosed array"),
                        _ if need_comma => return self.err("Expected , between items"),
                        _ => {}
                    }
                    items.push(self.value()?);
                    need_comma = true;
                }
                self.depth -= 1;
                Kind::Array(items)
            }
            b'"' => Kind::Str(self.string()?),
            b't' if self.s[self.i..].starts_with(b"true") => {
                self.i += 4;
                Kind::Bool(true)
            }
            b'f' if self.s[self.i..].starts_with(b"false") => {
                self.i += 5;
                Kind::Bool(false)
            }
            b'n' if self.s[self.i..].starts_with(b"null") => {
                self.i += 4;
                Kind::Null
            }
            b'-' | b'0'..=b'9' => {
                while self.i < self.s.len() && matches!(self.s[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                    self.i += 1;
                }
                Kind::Num(self.text[start..self.i].to_string())
            }
            _ => return self.err("Unexpected character"),
        };
        Ok(Node { start, end: self.i, kind })
    }
}

/// Parses a JSON/JSONC document. `Ok(None)` when it holds nothing but whitespace and comments.
pub fn parse(text: &str) -> Result<Option<Node>, String> {
    let mut p = Parser { s: text.as_bytes(), text, i: 0, depth: 0 };
    p.ws()?;
    if p.i >= text.len() {
        return Ok(None);
    }
    let root = p.value()?;
    p.ws()?;
    if p.i < text.len() {
        return p.err("Unexpected text after the end");
    }
    if !matches!(root.kind, Kind::Object(_)) {
        return Err("The file is not a JSON object".into());
    }
    Ok(Some(root))
}

pub fn to_value(n: &Node) -> Value {
    match &n.kind {
        Kind::Object(m) => Value::Object(m.iter().map(|m| (m.key.clone(), to_value(&m.value))).collect()),
        Kind::Array(items) => Value::Array(items.iter().map(to_value).collect()),
        Kind::Str(s) => Value::String(s.clone()),
        Kind::Num(n) => serde_json::from_str(n).unwrap_or(Value::Null),
        Kind::Bool(b) => Value::Bool(*b),
        Kind::Null => Value::Null,
    }
}

fn members(n: &Node) -> Option<&[Member]> {
    match &n.kind {
        Kind::Object(m) => Some(m),
        _ => None,
    }
}

/// The object at `path` below `root`, if every step exists and is an object.
pub fn find<'a>(root: &'a Node, path: &[String]) -> Option<&'a Node> {
    let mut at = root;
    for key in path {
        at = &members(at)?.iter().find(|m| &m.key == key)?.value;
        members(at)?;
    }
    Some(at)
}

pub fn member<'a>(obj: &'a Node, name: &str) -> Option<&'a Member> {
    members(obj)?.iter().find(|m| m.key == name)
}

// ---------------------------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------------------------

pub struct Style {
    pub nl: &'static str,
    pub unit: String,
}

impl Style {
    pub fn of(text: &str, root: Option<&Node>) -> Style {
        let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let unit = root
            .and_then(members)
            .and_then(|m| m.first())
            .map(|m| line_indent(text, m.key_start))
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| "  ".into());
        Style { nl, unit }
    }
}

/// The whitespace a position's line starts with.
fn line_indent(text: &str, at: usize) -> String {
    let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    text[line_start..].chars().take_while(|c| *c == ' ' || *c == '\t').collect()
}

fn starts_line(text: &str, at: usize) -> bool {
    text[..at].trim_end_matches([' ', '\t']).ends_with('\n') || text[..at].trim_end_matches([' ', '\t']).is_empty()
}

/// Ordered fields so written entries read naturally (`type`, `command`, `args`, `env`).
pub type Fields = Vec<(String, Value)>;

fn pretty(v: &Value, unit: &str) -> String {
    use serde::Serialize;
    let mut buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(unit.as_bytes());
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    let _ = v.serialize(&mut ser);
    String::from_utf8(buf).unwrap_or_default()
}

/// `fields` as a pretty object whose first line starts at `base` indentation.
pub fn render(fields: &Fields, style: &Style, base: &str) -> String {
    if fields.is_empty() {
        return "{}".into();
    }
    let inner = format!("{base}{}", style.unit);
    let mut out = String::from("{");
    for (i, (k, v)) in fields.iter().enumerate() {
        let value = pretty(v, &style.unit).replace('\n', &format!("{}{inner}", style.nl));
        out.push_str(&format!(
            "{}{inner}{}: {value}{}",
            style.nl,
            Value::String(k.clone()),
            if i + 1 < fields.len() { "," } else { "" }
        ));
    }
    out.push_str(&format!("{}{base}}}", style.nl));
    out
}

// ---------------------------------------------------------------------------------------------
// edits
// ---------------------------------------------------------------------------------------------

fn splice(text: &str, start: usize, end: usize, with: &str) -> String {
    format!("{}{with}{}", &text[..start], &text[end..])
}

/// Inserts `"name": <value>` as the last member of `obj`, where `value(base)` renders the value
/// for a member whose line starts at indentation `base`.
fn insert(text: &str, obj: &Node, name: &str, style: &Style, value: &dyn Fn(&str) -> String) -> String {
    let list = members(obj).unwrap_or(&[]);
    let key = Value::String(name.to_string());
    match list.last() {
        Some(last) => {
            let ind = if starts_line(text, list[0].key_start) {
                line_indent(text, list[0].key_start)
            } else {
                format!("{}{}", line_indent(text, obj.start), style.unit)
            };
            let member = format!("{}{ind}{key}: {}", style.nl, value(&ind));
            match last.comma {
                // Keep a trailing comma style: the new member gets one too.
                Some(c) => splice(text, c + 1, c + 1, &format!("{member},")),
                None => splice(text, last.value.end, last.value.end, &format!(",{member}")),
            }
        }
        None => {
            let close = line_indent(text, obj.start);
            let ind = format!("{close}{}", style.unit);
            let interior = &text[obj.start + 1..obj.end - 1];
            let member = format!("{}{ind}{key}: {}", style.nl, value(&ind));
            if interior.trim().is_empty() {
                splice(text, obj.start + 1, obj.end - 1, &format!("{member}{}{close}", style.nl))
            } else {
                // Only comments inside: put the member first and keep them.
                splice(text, obj.start + 1, obj.start + 1, &member)
            }
        }
    }
}

/// Removes member `name` from `obj` together with its line and the comma that went with it.
fn remove(text: &str, obj: &Node, name: &str) -> String {
    let Some(list) = members(obj) else { return text.to_string() };
    let Some(idx) = list.iter().position(|m| m.key == name) else { return text.to_string() };
    let m = &list[idx];
    let mut a = m.key_start;
    while a > 0 && matches!(text.as_bytes()[a - 1], b' ' | b'\t') {
        a -= 1;
    }
    let line_mode = a > 0 && text.as_bytes()[a - 1] == b'\n';
    if line_mode {
        a -= 1;
        if a > 0 && text.as_bytes()[a - 1] == b'\r' {
            a -= 1;
        }
    }
    let out = if let Some(c) = m.comma {
        let mut b = c + 1;
        if !line_mode {
            a = m.key_start;
            while b < text.len() && matches!(text.as_bytes()[b], b' ' | b'\t') {
                b += 1;
            }
        }
        splice(text, a, b, "")
    } else if idx > 0 {
        let prev = list[idx - 1].comma.unwrap_or(m.key_start);
        // Remove the member first (it comes later in the text), then the previous comma.
        let t = splice(text, a, m.value.end, "");
        splice(&t, prev, prev + 1, "")
    } else {
        splice(text, a, m.value.end, "")
    };
    // An object left with only whitespace inside closes up: `{}`.
    if list.len() == 1 {
        if let Ok(Some(root)) = parse(&out) {
            if let Some(span) = locate_same_object(&root, obj.start) {
                let interior = &out[span.0 + 1..span.1 - 1];
                if interior.trim().is_empty() && !interior.is_empty() {
                    return splice(&out, span.0 + 1, span.1 - 1, "");
                }
            }
        }
    }
    out
}

/// The span of the object that starts at `start` (spans before it do not move when editing later text).
fn locate_same_object(n: &Node, start: usize) -> Option<(usize, usize)> {
    if n.start == start {
        return Some((n.start, n.end));
    }
    match &n.kind {
        Kind::Object(m) => m.iter().find_map(|m| locate_same_object(&m.value, start)),
        Kind::Array(items) => items.iter().find_map(|i| locate_same_object(i, start)),
        _ => None,
    }
}

/// The text with `container.../name` set to `fields`. Returns whether the container had to be created.
pub fn set(text: &str, container: &[String], name: &str, fields: &Fields) -> Result<(String, bool), String> {
    let root = parse(text)?;
    let style = Style::of(text, root.as_ref());
    let Some(root) = root else {
        // An empty (or missing) file: start a fresh document.
        let (doc, _) = set("{}", container, name, fields)?;
        return Ok((format!("{doc}{}", style.nl), true));
    };
    // Walk down, creating the first missing step with the rest nested inside.
    let mut obj = &root;
    for (depth, key) in container.iter().enumerate() {
        match member(obj, key) {
            Some(m) if matches!(m.value.kind, Kind::Object(_)) => obj = &m.value,
            Some(_) => return Err(format!("\"{key}\" is not an object")),
            None => {
                let rest = &container[depth + 1..];
                let value = |base: &str| {
                    // `{ rest...: { name: fields } }` rendered at `base`.
                    let mut levels: Vec<String> = rest.to_vec();
                    levels.push(name.into());
                    let mut ind = base.to_string();
                    let mut open = String::new();
                    let mut close = String::new();
                    for (i, k) in levels.iter().enumerate() {
                        let inner = format!("{ind}{}", style.unit);
                        if i + 1 == levels.len() {
                            open.push_str(&format!("{{{}{inner}{}: {}", style.nl, Value::String(k.clone()), render(fields, &style, &inner)));
                        } else {
                            open.push_str(&format!("{{{}{inner}{}: ", style.nl, Value::String(k.clone())));
                        }
                        close = format!("{}{ind}}}{close}", style.nl);
                        ind = inner;
                    }
                    format!("{open}{close}")
                };
                return Ok((insert(text, obj, key, &style, &value), true));
            }
        }
    }
    let out = match member(obj, name) {
        Some(m) => {
            let base = line_indent(text, m.key_start);
            splice(text, m.value.start, m.value.end, &render(fields, &style, &base))
        }
        None => insert(text, obj, name, &style, &|base| render(fields, &style, base)),
    };
    Ok((out, false))
}

/// The text without `container.../name`. With `drop_empty_container`, an emptied container goes too.
pub fn unset(text: &str, container: &[String], name: &str, drop_empty_container: bool) -> Result<String, String> {
    let Some(root) = parse(text)? else { return Ok(text.to_string()) };
    let Some(obj) = find(&root, container) else { return Ok(text.to_string()) };
    let out = remove(text, obj, name);
    if drop_empty_container && !container.is_empty() {
        if let Some(root) = parse(&out)? {
            let (last, parents) = container.split_last().unwrap_or((&container[0], &[]));
            if let (Some(parent), Some(obj)) = (find(&root, parents), find(&root, container)) {
                if members(obj).is_some_and(|m| m.is_empty()) {
                    return Ok(remove(&out, parent, last));
                }
            }
        }
    }
    Ok(out)
}

/// The value at `container.../name`, if present.
pub fn get(text: &str, container: &[String], name: &str) -> Result<Option<Value>, String> {
    let Some(root) = parse(text)? else { return Ok(None) };
    Ok(find(&root, container).and_then(|o| member(o, name)).map(|m| to_value(&m.value)))
}

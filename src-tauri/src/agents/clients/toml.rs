//! Edits the `[<container>.suivelle]` table of a TOML file (Codex's `config.toml`) by splicing
//! whole tables, so comments and every other table stay byte for byte.
//!
//! Only the shapes Suivelle and the Codex CLI write are understood: `command`, `args` and `env`
//! (inline or as a `.env` sub-table). A `suivelle` server written in another form (dotted keys,
//! an inline table) is reported rather than rewritten.

use super::Entry;
use std::collections::BTreeMap;

struct Section {
    start: usize,
    end: usize,
    path: Vec<String>,
}

fn nl_of(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// `a."b c".d` → ["a", "b c", "d"].
fn split_key(s: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = s.trim().chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        match chars.peek() {
            Some('"') | Some('\'') => {
                let q = chars.next()?;
                for c in chars.by_ref() {
                    if c == q {
                        break;
                    }
                    cur.push(c);
                }
            }
            _ => {
                while let Some(&c) = chars.peek() {
                    if c == '.' || c.is_whitespace() {
                        break;
                    }
                    cur.push(c);
                    chars.next();
                }
            }
        }
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        out.push(std::mem::take(&mut cur));
        match chars.next() {
            Some('.') => continue,
            None => return Some(out),
            Some(_) => return None,
        }
    }
}

/// Lines as (start offset, text without the line ending), skipping multi-line strings.
fn lines(text: &str) -> Vec<(usize, &str, bool)> {
    let mut out = Vec::new();
    let mut at = 0;
    let mut in_multi: Option<&str> = None;
    for raw in text.split_inclusive('\n') {
        let line = raw.trim_end_matches(['\n', '\r']);
        let starts_in_string = in_multi.is_some();
        for q in ["\"\"\"", "'''"] {
            let n = line.matches(q).count();
            if n % 2 == 1 {
                in_multi = match in_multi {
                    Some(open) if open == q => None,
                    None => Some(q),
                    other => other,
                };
            }
        }
        out.push((at, line, starts_in_string));
        at += raw.len();
    }
    out
}

fn sections(text: &str) -> Vec<Section> {
    let mut out: Vec<Section> = Vec::new();
    for (start, line, in_string) in lines(text) {
        let t = line.trim_start();
        if in_string || !t.starts_with('[') {
            continue;
        }
        let inner = t.trim_start_matches('[');
        let Some(close) = inner.find(']') else {
            continue;
        };
        let Some(path) = split_key(&inner[..close]) else {
            continue;
        };
        if let Some(prev) = out.last_mut() {
            prev.end = start;
        }
        out.push(Section {
            start,
            end: text.len(),
            path,
        });
    }
    out
}

fn is_ours(path: &[String], container: &[String]) -> bool {
    path.len() > container.len()
        && path[..container.len()] == *container
        && path[container.len()] == "suivelle"
}

/// Refuses layouts where `suivelle` is defined without its own table header.
fn check_layout(text: &str, container: &[String]) -> Result<(), String> {
    let secs = sections(text);
    let first = secs.first().map_or(text.len(), |s| s.start);
    let dotted = format!("{}.suivelle", container.join("."));
    let unusual = || {
        Err("Codex's config defines the suivelle server in a form Suivelle does not edit. Remove it there, or use Copy config.".to_string())
    };
    for (_, line, in_string) in lines(&text[..first]) {
        let compact: String = line
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '"' && *c != '\'')
            .collect();
        if !in_string
            && (compact.starts_with(&format!("{dotted}."))
                || compact.starts_with(&format!("{dotted}="))
                || compact.starts_with(&format!("{}=", container.join("."))))
        {
            return unusual();
        }
    }
    for s in &secs {
        if s.path == container {
            for (_, line, in_string) in lines(&text[s.start..s.end]).into_iter().skip(1) {
                let compact: String = line
                    .chars()
                    .filter(|c| !c.is_whitespace() && *c != '"' && *c != '\'')
                    .collect();
                if !in_string
                    && (compact.starts_with("suivelle.") || compact.starts_with("suivelle="))
                {
                    return unusual();
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

struct Cursor<'a> {
    s: &'a str,
    i: usize,
}

impl Cursor<'_> {
    fn ws(&mut self) {
        while let Some(c) = self.s[self.i..].chars().next() {
            if c.is_whitespace() {
                self.i += c.len_utf8();
            } else if c == '#' {
                self.i += self.s[self.i..].find('\n').unwrap_or(self.s.len() - self.i);
            } else {
                break;
            }
        }
    }
    fn peek(&self) -> Option<char> {
        self.s[self.i..].chars().next()
    }
    fn string(&mut self) -> Option<String> {
        let q = self.peek()?;
        self.i += 1;
        let mut out = String::new();
        loop {
            let c = self.peek()?;
            self.i += c.len_utf8();
            if c == q {
                return Some(out);
            }
            if c == '\\' && q == '"' {
                let e = self.peek()?;
                self.i += e.len_utf8();
                match e {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    'u' | 'U' => {
                        let n = if e == 'u' { 4 } else { 8 };
                        let h = self.s.get(self.i..self.i + n)?;
                        self.i += n;
                        out.push(char::from_u32(u32::from_str_radix(h, 16).ok()?)?);
                    }
                    _ => return None,
                }
            } else {
                out.push(c);
            }
        }
    }
    fn strings(&mut self) -> Option<Vec<String>> {
        self.i += 1; // [
        let mut out = Vec::new();
        loop {
            self.ws();
            match self.peek()? {
                ']' => {
                    self.i += 1;
                    return Some(out);
                }
                ',' => self.i += 1,
                '"' | '\'' => out.push(self.string()?),
                _ => return None,
            }
        }
    }
    fn table(&mut self) -> Option<BTreeMap<String, String>> {
        self.i += 1; // {
        let mut out = BTreeMap::new();
        loop {
            self.ws();
            match self.peek()? {
                '}' => {
                    self.i += 1;
                    return Some(out);
                }
                ',' => self.i += 1,
                _ => {
                    let eq = self.s[self.i..].find('=')? + self.i;
                    let key = split_key(&self.s[self.i..eq])?.join(".");
                    self.i = eq + 1;
                    self.ws();
                    out.insert(key, self.string()?);
                }
            }
        }
    }
}

/// `key = value` pairs of one table's body (values may span lines).
fn pairs(body: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut c = Cursor { s: body, i: 0 };
    loop {
        c.ws();
        if c.i >= body.len() {
            return out;
        }
        let Some(eq) = body[c.i..].find('=').map(|e| e + c.i) else {
            return out;
        };
        let key = split_key(&body[c.i..eq])
            .map(|k| k.join("."))
            .unwrap_or_default();
        c.i = eq + 1;
        c.ws();
        let start = c.i;
        let ok = match c.peek() {
            Some('"') | Some('\'') => c.string().is_some(),
            Some('[') => c.strings().is_some(),
            Some('{') => c.table().is_some(),
            _ => {
                c.i += body[c.i..].find('\n').unwrap_or(body.len() - c.i);
                true
            }
        };
        if !ok {
            return out;
        }
        out.push((key, body[start..c.i].to_string()));
    }
}

fn str_value(raw: &str) -> Option<String> {
    Cursor { s: raw, i: 0 }.string()
}

/// The suivelle entry, if the file has one.
pub fn get(text: &str, container: &[String]) -> Result<Option<Entry>, String> {
    let mut found = false;
    let mut entry = Entry::default();
    for s in sections(text)
        .into_iter()
        .filter(|s| is_ours(&s.path, container))
    {
        found = true;
        let header_end = text[s.start..s.end]
            .find('\n')
            .map_or(s.end, |i| s.start + i + 1);
        let body = &text[header_end..s.end];
        let sub = &s.path[container.len() + 1..];
        for (k, raw) in pairs(body) {
            match (sub, k.as_str()) {
                ([], "command") => entry.command = str_value(&raw).unwrap_or_default(),
                ([], "args") => entry.args = Cursor { s: &raw, i: 0 }.strings().unwrap_or_default(),
                ([], "env") => entry.env = Cursor { s: &raw, i: 0 }.table().unwrap_or_default(),
                ([e], key) if e == "env" => {
                    if let Some(v) = str_value(&raw) {
                        entry.env.insert(key.to_string(), v);
                    }
                }
                _ => {}
            }
        }
    }
    Ok(found.then_some(entry))
}

fn quote(s: &str) -> String {
    if !s.contains('\'') && !s.chars().any(char::is_control) {
        format!("'{s}'")
    } else {
        serde_json::to_string(s).unwrap_or_default()
    }
}

fn bare_key(k: &str) -> String {
    if !k.is_empty()
        && k.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        k.to_string()
    } else {
        serde_json::to_string(k).unwrap_or_default()
    }
}

/// The table text Suivelle writes for an entry.
pub fn render(entry: &Entry, container: &[String], nl: &str) -> String {
    let head = container
        .iter()
        .map(|k| bare_key(k))
        .collect::<Vec<_>>()
        .join(".");
    let mut out = format!(
        "[{head}.suivelle]{nl}command = {}{nl}",
        quote(&entry.command)
    );
    let args: Vec<String> = entry.args.iter().map(|a| quote(a)).collect();
    out.push_str(&format!("args = [{}]{nl}", args.join(", ")));
    if !entry.env.is_empty() {
        out.push_str(&format!("{nl}[{head}.suivelle.env]{nl}"));
        for (k, v) in &entry.env {
            out.push_str(&format!("{} = {}{nl}", bare_key(k), quote(v)));
        }
    }
    out
}

/// The text without the suivelle tables. A blank line left before them at the end goes too.
pub fn unset(text: &str, container: &[String]) -> Result<String, String> {
    check_layout(text, container)?;
    let mut out = text.to_string();
    let ours: Vec<Section> = sections(text)
        .into_iter()
        .filter(|s| is_ours(&s.path, container))
        .collect();
    let at_end = ours.last().is_some_and(|s| s.end == text.len());
    for s in ours.iter().rev() {
        out.replace_range(s.start..s.end, "");
    }
    if at_end {
        let nl = nl_of(text);
        if out.ends_with(&format!("{nl}{nl}")) {
            out.truncate(out.len() - nl.len());
        }
    }
    Ok(out)
}

/// The text with the suivelle tables replaced by `entry`, appended at the end.
pub fn set(text: &str, container: &[String], entry: &Entry) -> Result<String, String> {
    let mut out = unset(text, container)?;
    let nl = nl_of(text);
    if !out.is_empty() {
        if !out.ends_with('\n') {
            out.push_str(nl);
        }
        out.push_str(nl);
    }
    out.push_str(&render(entry, container, nl));
    Ok(out)
}

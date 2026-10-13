//! Notion's naming and value conventions: the 32-character id on every exported file and folder,
//! percent-encoded links, and the way dates, checkboxes, numbers and relations are written in
//! its CSV files and HTML tables.

use chrono::{NaiveDate, NaiveDateTime};
use serde_json::{json, Value};

/// Whether `s` is a Notion id: 32 hexadecimal digits, with or without the dashes of a UUID.
pub fn as_id(s: &str) -> Option<String> {
    let compact: String = s.chars().filter(|c| *c != '-').collect();
    (compact.len() == 32 && compact.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| compact.to_ascii_lowercase())
}

/// Splits a file stem or folder name into its title and Notion id: `"Plans 0123…cdef"` →
/// `("Plans", Some("0123…cdef"))`. Names without an id come back unchanged.
pub fn split_id(name: &str) -> (String, Option<String>) {
    let name = name.trim();
    if let Some(id) = as_id(name) {
        return (String::new(), Some(id));
    }
    if name.len() > 33 && name.is_char_boundary(name.len() - 32) {
        let (head, tail) = name.split_at(name.len() - 32);
        if let Some(id) = as_id(tail) {
            if let Some(title) = head.strip_suffix([' ', '-', '_']) {
                return (title.trim().to_string(), Some(id));
            }
        }
    }
    (name.to_string(), None)
}

/// A file's stem without the `_all` that marks Notion's every-row CSV.
pub fn csv_stem(stem: &str) -> (&str, bool) {
    match stem.strip_suffix("_all") {
        Some(s) => (s, true),
        None => (stem, false),
    }
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
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

/// The Notion id a link points at, from the last part of its path: `../A%20abc…/B%20def….md`.
pub fn id_in_href(href: &str) -> Option<String> {
    let clean = href.split(['#', '?']).next().unwrap_or("");
    let decoded = percent_decode(clean);
    let last = decoded.rsplit(['/', '\\']).next()?;
    let stem = match last.rsplit_once('.') {
        Some((stem, ext)) if ext.len() <= 5 && !ext.contains(' ') => stem,
        _ => last,
    };
    split_id(csv_stem(stem).0).1
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

const DATE_FORMATS: &[&str] = &[
    "%B %d, %Y",
    "%b %d, %Y",
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%m/%d/%Y",
    "%d/%m/%Y",
    "%d %B %Y",
    "%d %b %Y",
];
const TIME_FORMATS: &[&str] = &["%I:%M %p", "%H:%M", "%I:%M%p"];

fn one_date(s: &str) -> Option<String> {
    let mut t = s.trim().trim_start_matches('@').trim().to_string();
    // "October 12, 2026 3:00 PM (GMT+8)": the time zone is dropped.
    if let Some(open) = t.find(" (") {
        if t.ends_with(')') {
            t.truncate(open);
        }
    }
    let t = t.trim();
    if t.is_empty() {
        return None;
    }
    for d in DATE_FORMATS {
        if let Ok(day) = NaiveDate::parse_from_str(t, d) {
            return Some(day.format("%Y-%m-%d").to_string());
        }
        for tf in TIME_FORMATS {
            if let Ok(at) = NaiveDateTime::parse_from_str(t, &format!("{d} {tf}")) {
                return Some(at.format("%Y-%m-%dT%H:%M").to_string());
            }
        }
    }
    super::super::csvio::parse_date(t)
}

/// A date cell (`October 12, 2026`, `October 12, 2026 3:00 PM`, `A → B`) as a date value.
pub fn date_value(s: &str) -> Option<Value> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let (start, end) = match t.split_once('→').or_else(|| t.split_once(" -> ")) {
        Some((a, b)) => (a, Some(b)),
        None => (t, None),
    };
    let start = one_date(start)?;
    let mut v = json!({ "start": start });
    if let Some(end) = end.and_then(one_date) {
        if end >= start {
            v["end"] = json!(end);
        }
    }
    Some(v)
}

pub fn is_date(s: &str) -> bool {
    date_value(s).is_some()
}

/// A number as Notion shows it: `1,200.50`, `$1,200`, `45%`, `€ 3`.
pub fn number(s: &str) -> Option<f64> {
    let t = s.trim();
    if let Some(n) = super::super::csvio::parse_number(t) {
        return Some(n);
    }
    let percent = t.ends_with('%');
    let core: String = t
        .trim_end_matches('%')
        .chars()
        .filter(|c| !matches!(c, '$' | '€' | '£' | '¥' | '₩' | '₹' | ' ' | '\u{a0}'))
        .collect();
    let n = super::super::csvio::parse_number(&core)?;
    Some(if percent { n / 100.0 } else { n })
}

/// A stored date (`2026-10-12`, `2026-10-12T15:00`, or an RFC 3339 timestamp) the way Notion
/// writes it: `October 12, 2026` or `October 12, 2026 3:00 PM`.
pub fn notion_date(iso: &str) -> String {
    let t = iso.trim();
    if let Ok(d) = NaiveDate::parse_from_str(t, "%Y-%m-%d") {
        return d.format("%B %-d, %Y").to_string();
    }
    let at = NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M")
        .or_else(|_| NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S"))
        .ok()
        .or_else(|| {
            chrono::DateTime::parse_from_rfc3339(t)
                .ok()
                .map(|d| d.with_timezone(&chrono::Local).naive_local())
        });
    match at {
        Some(at) => at.format("%B %-d, %Y %-I:%M %p").to_string(),
        None => t.to_string(),
    }
}

/// A date value (`{start, end}`) the way Notion writes it.
pub fn notion_date_value(v: &Value) -> String {
    let start = v.get("start").and_then(Value::as_str).map(notion_date);
    let end = v.get("end").and_then(Value::as_str).map(notion_date);
    match (start, end) {
        (Some(s), Some(e)) => format!("{s} → {e}"),
        (Some(s), None) => s,
        _ => String::new(),
    }
}

/// A Suivelle tone as the Notion colour name.
pub fn notion_color(tone: &str) -> &'static str {
    match tone {
        "violet" => "purple",
        "red" => "red",
        "orange" => "orange",
        "green" => "green",
        "blue" => "blue",
        _ => "gray",
    }
}

/// One item of a relation cell: the related page's title and, when Notion wrote it, its path.
#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    pub title: String,
    pub href: Option<String>,
}

fn looks_like_page(inner: &str) -> bool {
    // Notion percent-encodes the paths it writes, so a path never holds a space.
    let l = inner.to_ascii_lowercase();
    !l.contains(' ') && (l.ends_with(".md") || l.ends_with(".html") || l.ends_with(".htm"))
}

/// Splits a relation cell: `A (Other%20abc/A%20def.md), B (Other%20abc/B%20012.md)`.
/// Cells without paths (older exports) are split on commas.
pub fn links(cell: &str) -> Vec<Link> {
    let mut out = Vec::new();
    let mut rest = cell.trim();
    'items: while !rest.is_empty() {
        let mut from = 0;
        while let Some(p) = rest[from..].find(" (") {
            let open = from + p;
            let mut search = open + 2;
            while let Some(c) = rest[search..].find(')') {
                let close = search + c;
                let inner = &rest[open + 2..close];
                let after = &rest[close + 1..];
                if looks_like_page(inner)
                    && (after.trim().is_empty() || after.trim_start().starts_with(','))
                {
                    out.push(Link {
                        title: rest[..open].trim().to_string(),
                        href: Some(inner.to_string()),
                    });
                    rest = after.trim_start().trim_start_matches(',').trim_start();
                    continue 'items;
                }
                search = close + 1;
            }
            from = open + 2;
        }
        for t in rest.split(", ").map(str::trim).filter(|t| !t.is_empty()) {
            out.push(Link {
                title: t.to_string(),
                href: None,
            });
        }
        break;
    }
    out
}

/// Whether a whole column is written as relation links with paths.
pub fn is_relation_column(cells: &[&str]) -> bool {
    let filled: Vec<&&str> = cells.iter().filter(|c| !c.trim().is_empty()).collect();
    !filled.is_empty()
        && filled.iter().all(|c| {
            let l = links(c);
            !l.is_empty() && l.iter().all(|x| x.href.is_some())
        })
}

/// Notion's option colours, as the nearest Suivelle tone.
pub fn tone(color: &str) -> &'static str {
    match color.trim_end_matches("_background") {
        "purple" | "pink" => "violet",
        "red" => "red",
        "orange" | "yellow" | "brown" => "orange",
        "green" => "green",
        "blue" => "blue",
        _ => "gray",
    }
}

/// The status group a Notion status option most likely belongs to.
pub fn status_group(name: &str) -> &'static str {
    let l = name.to_lowercase();
    if [
        "done", "complete", "finished", "closed", "shipped", "archived", "resolved",
    ]
    .iter()
    .any(|w| l.contains(w))
    {
        "done"
    } else if [
        "progress", "doing", "active", "started", "review", "blocked", "testing",
    ]
    .iter()
    .any(|w| l.contains(w))
        && !l.contains("not started")
    {
        "doing"
    } else {
        "todo"
    }
}

/// The emoji Notion puts on a callout, as the nearest callout tone.
pub fn callout_tone(icon: &str) -> &'static str {
    let warning = ["⚠", "❗", "‼", "🚨", "⛔", "🛑", "❌", "🔥", "📛", "❕"];
    let tip = ["💡", "✅", "✔", "🌟", "⭐", "🎉", "👍", "🚀", "✨", "🌱"];
    if warning.iter().any(|w| icon.contains(w)) {
        "warning"
    } else if tip.iter().any(|w| icon.contains(w)) {
        "tip"
    } else {
        "note"
    }
}

/// The emoji written for a callout of `tone` when exporting, so Notion keeps it a callout.
pub fn callout_icon(tone: &str) -> &'static str {
    match tone {
        "tip" => "💡",
        "warning" => "⚠️",
        _ => "📝",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn ids_come_off_names() {
        assert_eq!(
            split_id(&format!("Plans {ID}")),
            ("Plans".into(), Some(ID.into()))
        );
        assert_eq!(
            split_id(&format!("Q3 – plan {}", ID.to_uppercase()))
                .1
                .as_deref(),
            Some(ID)
        );
        assert_eq!(split_id("Plans"), ("Plans".into(), None));
        assert_eq!(split_id(ID), (String::new(), Some(ID.into())));
        assert_eq!(
            split_id(&format!("Plans{ID}")).1,
            None,
            "an id needs a separator"
        );
        assert_eq!(
            as_id("01234567-89ab-cdef-0123-456789abcdef").as_deref(),
            Some(ID)
        );
        assert_eq!(
            csv_stem(&format!("Tasks {ID}_all")),
            (format!("Tasks {ID}").as_str(), true)
        );
        assert_eq!(
            id_in_href(&format!("../Tasks%20{ID}/Write%20it%20{ID}.md#x")).as_deref(),
            Some(ID)
        );
        assert_eq!(
            id_in_href(&format!("Tasks%20{ID}_all.csv")).as_deref(),
            Some(ID)
        );
    }

    #[test]
    fn dates_are_written_as_notion_writes_them() {
        assert_eq!(notion_date("2026-10-02"), "October 2, 2026");
        assert_eq!(notion_date("2026-10-12T15:05"), "October 12, 2026 3:05 PM");
        let v = json!({"start":"2026-10-12","end":"2026-10-14"});
        assert_eq!(notion_date_value(&v), "October 12, 2026 → October 14, 2026");
        assert_eq!(
            date_value(&notion_date_value(&v)).unwrap(),
            v,
            "and read back"
        );
    }

    #[test]
    fn dates_in_notion_formats() {
        assert_eq!(
            date_value("October 12, 2026").unwrap(),
            json!({"start":"2026-10-12"})
        );
        assert_eq!(
            date_value("Oct 2, 2026 3:05 PM").unwrap(),
            json!({"start":"2026-10-02T15:05"})
        );
        assert_eq!(
            date_value("October 12, 2026 → October 14, 2026").unwrap(),
            json!({"start":"2026-10-12","end":"2026-10-14"})
        );
        assert_eq!(
            date_value("@October 12, 2026 9:00 AM (GMT+8)").unwrap()["start"],
            "2026-10-12T09:00"
        );
        assert_eq!(date_value("2026/10/12").unwrap()["start"], "2026-10-12");
        assert!(date_value("Someday").is_none());
    }

    #[test]
    fn numbers_and_relation_cells() {
        assert_eq!(number("$1,200.50"), Some(1200.5));
        assert_eq!(number("45%"), Some(0.45));
        assert_eq!(number("abc"), None);
        let cell = format!(
            "Write (it) (Tasks%20{ID}/Write%20(it)%20{ID}.md), Ship (Tasks%20{ID}/Ship%20{ID}.md)"
        );
        let l = links(&cell);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].title, "Write (it)");
        assert_eq!(id_in_href(l[0].href.as_ref().unwrap()).as_deref(), Some(ID));
        assert_eq!(l[1].title, "Ship");
        assert!(is_relation_column(&[cell.as_str(), ""]));
        assert_eq!(links("A, B").len(), 2);
        assert!(!is_relation_column(&["A, B"]));
    }
}

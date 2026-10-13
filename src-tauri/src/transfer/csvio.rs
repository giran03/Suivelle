//! CSV: reading a file into a typed plan for a new database, and writing a database out.

use crate::errors::{AppError, AppResult};
use serde::Serialize;
use serde_json::{json, Value};

pub const MAX_ROWS: usize = 10_000;
pub const MAX_COLUMNS: usize = 50;
const MAX_CELL: usize = 2_000;

/// The column types an import can create, in the order the preview offers them.
pub const KINDS: &[&str] = &[
    "text",
    "number",
    "select",
    "multi_select",
    "date",
    "checkbox",
    "url",
    "email",
    "phone",
    "skip",
];

pub struct Csv {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// More rows existed than the import limit.
    pub truncated: bool,
}

fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        // Not UTF-8: Latin-1 is the usual culprit for old exports.
        Err(_) => bytes.iter().map(|b| char::from(*b)).collect(),
    }
}

fn sniff(text: &str) -> u8 {
    let sample: String = text.lines().take(5).collect::<Vec<_>>().join("\n");
    (*b",;\t|")
        .into_iter()
        .max_by_key(|d| sample.bytes().filter(|b| b == d).count())
        .filter(|d| sample.bytes().any(|b| b == *d))
        .unwrap_or(b',')
}

fn clean_header(h: &str, n: usize, seen: &mut Vec<String>) -> String {
    let mut name: String = h.trim().chars().take(60).collect();
    if name.is_empty() {
        name = format!("Column {}", n + 1);
    }
    let base = name.clone();
    let mut k = 2;
    while seen.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
        name = format!("{base} {k}");
        k += 1;
    }
    seen.push(name.clone());
    name
}

pub fn read(bytes: &[u8]) -> AppResult<Csv> {
    read_with(bytes, MAX_CELL)
}

/// [`read`] with a different limit on each cell's length (Notion relation cells hold long paths).
pub fn read_with(bytes: &[u8], max_cell: usize) -> AppResult<Csv> {
    let text = decode_text(bytes);
    if text.trim().is_empty() {
        return Err(AppError::Validation("the file is empty".into()));
    }
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(sniff(&text))
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut records = reader.records();
    let first = records
        .next()
        .ok_or_else(|| AppError::Validation("the file is empty".into()))?
        .map_err(|e| AppError::Validation(format!("this is not a readable CSV file: {e}")))?;
    let width = first.len().min(MAX_COLUMNS);
    if width == 0 {
        return Err(AppError::Validation("the file has no columns".into()));
    }
    let mut seen = Vec::new();
    let headers: Vec<String> = first
        .iter()
        .take(width)
        .enumerate()
        .map(|(i, h)| clean_header(h, i, &mut seen))
        .collect();
    let mut rows = Vec::new();
    let mut truncated = false;
    for rec in records {
        let rec =
            rec.map_err(|e| AppError::Validation(format!("this is not a readable CSV file: {e}")))?;
        if rec.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        if rows.len() >= MAX_ROWS {
            truncated = true;
            break;
        }
        rows.push(
            (0..width)
                .map(|i| rec.get(i).unwrap_or("").chars().take(max_cell).collect())
                .collect(),
        );
    }
    Ok(Csv {
        headers,
        rows,
        truncated,
    })
}

const YES: &[&str] = &["true", "yes", "y", "checked", "x", "✓", "✔", "1"];
const NO: &[&str] = &["false", "no", "n", "unchecked", "0", ""];

pub fn parse_bool(s: &str) -> Option<bool> {
    let l = s.trim().to_lowercase();
    if YES.contains(&l.as_str()) {
        Some(true)
    } else if NO.contains(&l.as_str()) {
        Some(false)
    } else {
        None
    }
}

pub fn parse_number(s: &str) -> Option<f64> {
    let t = s.trim();
    let grouped = t.contains(',')
        && t.split('.').next().is_some_and(|int| {
            let digits = int.trim_start_matches('-');
            let parts: Vec<&str> = digits.split(',').collect();
            parts.len() > 1
                && parts[0].len() <= 3
                && !parts[0].is_empty()
                && parts[1..].iter().all(|p| p.len() == 3)
        });
    let cleaned = if grouped {
        t.replace(',', "")
    } else {
        t.to_string()
    };
    cleaned.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// `YYYY-MM-DD`, optionally with a time; slashes are accepted. Returns the canonical form.
pub fn parse_date(s: &str) -> Option<String> {
    let t = s.trim().replace('/', "-");
    let (d, rest) = match t.split_once(['T', ' ']) {
        Some((d, r)) => (d.to_string(), Some(r.to_string())),
        None => (t.clone(), None),
    };
    chrono::NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok()?;
    match rest {
        None => Some(d),
        Some(r) => {
            let r = r.trim_end_matches('Z');
            let hm = r.get(..5)?;
            chrono::NaiveTime::parse_from_str(hm, "%H:%M").ok()?;
            Some(format!("{d}T{hm}"))
        }
    }
}

fn is_email(s: &str) -> bool {
    let t = s.trim();
    t.contains('@') && !t.contains(char::is_whitespace) && !t.starts_with('@') && !t.ends_with('@')
}

/// The best type for a column of values (empty ones ignored).
pub fn detect(values: &[&str], total_rows: usize) -> &'static str {
    let v: Vec<&str> = values
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if v.is_empty() {
        return "text";
    }
    let words = |s: &&str| {
        matches!(
            s.to_lowercase().as_str(),
            "true" | "false" | "yes" | "no" | "y" | "n" | "checked" | "unchecked" | "x" | "✓" | "✔"
        )
    };
    if v.iter().all(words) {
        return "checkbox";
    }
    if v.iter().all(|s| parse_number(s).is_some()) {
        return "number";
    }
    if v.iter().all(|s| parse_date(s).is_some()) {
        return "date";
    }
    if v.iter()
        .all(|s| s.starts_with("http://") || s.starts_with("https://"))
    {
        return "url";
    }
    if v.iter().all(|s| is_email(s)) {
        return "email";
    }
    let mut distinct: Vec<&str> = v.clone();
    distinct.sort_unstable();
    distinct.dedup();
    if total_rows >= 6
        && (2..=20).contains(&distinct.len())
        && distinct.len() * 2 <= v.len()
        && distinct.iter().all(|d| d.chars().count() <= 40)
    {
        return "select";
    }
    "text"
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnPlan {
    pub name: String,
    /// One of [`KINDS`]; the first column is always the record title.
    pub kind: String,
    pub samples: Vec<String>,
    pub distinct: usize,
    /// What the column was in the source, when the import keeps or loses something special
    /// ("Relation to Tasks", "Formula results"); shown next to the type in the preview.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub fn plan(csv: &Csv) -> Vec<ColumnPlan> {
    (0..csv.headers.len())
        .map(|c| {
            let col: Vec<&str> = csv.rows.iter().map(|r| r[c].as_str()).collect();
            let mut distinct: Vec<&str> = col
                .iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            distinct.sort_unstable();
            distinct.dedup();
            ColumnPlan {
                name: csv.headers[c].clone(),
                kind: if c == 0 {
                    "title".into()
                } else {
                    detect(&col, csv.rows.len()).into()
                },
                samples: col
                    .iter()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .take(3)
                    .map(|s| s.chars().take(60).collect())
                    .collect(),
                distinct: distinct.len(),
                note: None,
            }
        })
        .collect()
}

/// A cell as the value stored for a property of `kind`; `None` when it is empty or does not fit
/// (so a stray bad cell leaves the cell empty instead of failing the import).
pub fn cell_value(kind: &str, raw: &str) -> Option<Value> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    match kind {
        "number" => parse_number(t).map(|n| json!(n)),
        "checkbox" => parse_bool(t).filter(|b| *b).map(Value::Bool),
        "date" => parse_date(t).map(|d| json!({ "start": d })),
        "url" => Some(json!(t)),
        "email" => is_email(t).then(|| json!(t)),
        "phone" => (t.chars().count() <= 40
            && t.chars()
                .all(|c| c.is_ascii_digit() || " +-().x#*,".contains(c)))
        .then(|| json!(t)),
        _ => Some(json!(raw)),
    }
}

/// CSV text (UTF-8 with a byte order mark so spreadsheets read it correctly).
pub fn write(headers: &[String], rows: &[Vec<String>]) -> AppResult<Vec<u8>> {
    let mut w = csv::WriterBuilder::new()
        .terminator(csv::Terminator::CRLF)
        .from_writer(vec![0xEF, 0xBB, 0xBF]);
    w.write_record(headers)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    for r in rows {
        w.write_record(r)
            .map_err(|e| AppError::Internal(e.to_string()))?;
    }
    w.into_inner()
        .map_err(|e| AppError::Internal(e.to_string()))
}

/// Spreadsheets run text that starts with these as a formula; a leading apostrophe stops that.
pub fn neutralize(cell: String) -> String {
    match cell.chars().next() {
        Some('=' | '+' | '@' | '\t' | '\r') => format!("'{cell}"),
        Some('-') if parse_number(&cell).is_none() => format!("'{cell}"),
        _ => cell,
    }
}

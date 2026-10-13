//! Databases from a Notion export: a CSV file (Markdown export) or a `collection-content` table
//! (HTML export), plus a page per row. Column types come from the HTML type icons when there are
//! some, and are inferred from Notion's way of writing values otherwise.

use super::super::blocks::Blk;
use super::super::csvio::{self, ColumnPlan};
use super::names;
use std::collections::HashMap;

/// A database ready to create.
#[derive(Debug, Clone, Default)]
pub struct DbModel {
    /// The id its page is planned with (the real one comes from the database service).
    pub id: String,
    /// Column 0 is the title.
    pub plan: Vec<ColumnPlan>,
    pub rows: Vec<RowModel>,
    /// Relation columns, by column.
    pub relations: Vec<(usize, RelCol)>,
    /// Option colours: (column, option name) → tone.
    pub colors: HashMap<(usize, String), String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RowModel {
    /// The id the row's page is planned with.
    pub id: String,
    /// One per column, as text; relation cells hold the related titles.
    pub cells: Vec<String>,
    pub body: Vec<Blk>,
    pub icon: Option<String>,
    pub cover: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RelCol {
    /// The planned page id of the database it points to.
    pub target: String,
    /// (row id, related row ids)
    pub links: Vec<(String, Vec<String>)>,
}

/// A column's type: one Suivelle can store, and a note when something about it changes.
pub fn kind_for(notion: &str) -> (&'static str, Option<&'static str>) {
    match notion {
        "title" => ("title", None),
        "number" => ("number", None),
        "select" => ("select", None),
        "multi_select" => ("multi_select", None),
        "status" => ("status", None),
        "date" => ("date", None),
        "checkbox" => ("checkbox", None),
        "url" => ("url", None),
        "email" => ("email", None),
        "phone" => ("phone", None),
        "relation" => ("relation", Some("Relation")),
        "person" | "created_by" | "updated_by" => ("text", Some("People, as names")),
        "files" => ("text", Some("Files, as names")),
        "formula" => ("text", Some("Formula results, as values")),
        "rollup" => ("text", Some("Rollup results, as values")),
        "created_time" => ("date", Some("Created time, as a date")),
        "updated_time" => ("date", Some("Last edited time, as a date")),
        "unique_id" => ("text", Some("Notion ID, as text")),
        _ => ("text", None),
    }
}

/// The best type for a CSV column of a Notion database.
pub fn infer(header: &str, cells: &[&str]) -> &'static str {
    let v: Vec<&str> = cells
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if v.is_empty() {
        return "text";
    }
    if names::is_relation_column(cells) {
        return "relation";
    }
    if v.iter()
        .all(|s| matches!(s.to_lowercase().as_str(), "yes" | "no"))
    {
        return "checkbox";
    }
    if v.iter().all(|s| names::number(s).is_some())
        && v.iter().any(|s| s.chars().any(|c| c.is_ascii_digit()))
    {
        return "number";
    }
    if v.iter().all(|s| names::is_date(s)) {
        return "date";
    }
    if let k @ ("url" | "email") = csvio::detect(&v, v.len().max(6)) {
        return k;
    }
    let short = |s: &&str| s.chars().count() <= 40 && !s.contains('\n');
    let items: Vec<&str> = v
        .iter()
        .flat_map(|c| c.split(", "))
        .map(str::trim)
        .collect();
    let mut distinct = items.clone();
    distinct.sort_unstable();
    distinct.dedup();
    let h = header.to_lowercase();
    let listy = matches!(
        h.as_str(),
        "tags" | "labels" | "categories" | "topics" | "skills"
    );
    if items.len() > v.len() || listy {
        if items.iter().all(short)
            && distinct.len() <= 50
            && (listy || distinct.len() < items.len())
        {
            return "multi_select";
        }
        return "text";
    }
    // Labels: short, word-like values that repeat, or a small table of them (Notion's CSV has no
    // types, and a select is easy to change back in the preview).
    let label = |s: &&str| s.chars().count() <= 25 && s.split_whitespace().count() <= 3;
    if v.iter().all(label)
        && distinct.len() <= 20
        && (distinct.len() < v.len() || v.len() <= 10)
        && !v.iter().any(|s| s.ends_with('.'))
    {
        return if h == "status" { "status" } else { "select" };
    }
    if h == "status" && v.iter().all(short) && distinct.len() <= 20 {
        return "status";
    }
    "text"
}

/// A column plan entry.
pub fn column(name: &str, kind: &str, note: Option<String>, cells: &[&str]) -> ColumnPlan {
    let mut distinct: Vec<&str> = cells
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let samples = distinct
        .iter()
        .take(3)
        .map(|s| s.chars().take(60).collect())
        .collect();
    distinct.sort_unstable();
    distinct.dedup();
    ColumnPlan {
        name: name.chars().take(60).collect::<String>().trim().to_string(),
        kind: kind.into(),
        samples,
        distinct: distinct.len(),
        note,
    }
}

/// Whether a column holds titles of another database's rows: a relation exported without paths.
pub fn titles_column(cells: &[&str], titles: &std::collections::HashSet<String>) -> bool {
    let items: Vec<&str> = cells
        .iter()
        .flat_map(|c| c.split(", "))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    items.len() >= 2 && items.iter().all(|i| titles.contains(*i))
}

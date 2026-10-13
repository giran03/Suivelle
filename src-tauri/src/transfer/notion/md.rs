//! Notion's Markdown: ordinary Markdown (its `<aside>` callouts are read by the Markdown parser)
//! where a database row's page starts with `Property: value` lines that repeat the row's cells.

use super::super::markdown;
use super::Doc;
use std::collections::HashSet;

/// A Notion Markdown page. `row_keys` are the property names of the database the page is a row
/// of: lines starting with them right after the title are the row's cells, not its content.
pub fn parse(src: &str, row_keys: Option<&HashSet<String>>) -> Doc {
    let text = src
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut lines: Vec<&str> = text.lines().collect();
    let mut title = None;
    if let Some(f) = lines.iter().position(|l| !l.trim().is_empty()) {
        if let Some(t) = lines[f].trim().strip_prefix("# ") {
            title = Some(t.trim().to_string());
            lines.drain(..=f);
        }
    }
    let mut props = Vec::new();
    if let Some(keys) = row_keys {
        let start = lines
            .iter()
            .position(|l| !l.trim().is_empty())
            .unwrap_or(lines.len());
        let mut i = start;
        while let Some((k, v)) = lines.get(i).and_then(|l| l.split_once(": ")) {
            if !keys.contains(k.trim()) {
                break;
            }
            props.push((k.trim().to_string(), v.trim().to_string()));
            i += 1;
        }
        if i > start {
            lines.drain(..i);
        }
    }
    Doc {
        title: title.filter(|t| !t.is_empty()),
        blocks: markdown::fragment(&lines.join("\n")),
        props,
        ..Doc::default()
    }
}

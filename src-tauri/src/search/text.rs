//! Pure helpers: what text a block contributes to search, which pages it references, and how a
//! user's query becomes a safe FTS5 expression.

use serde_json::Value;

pub const INTERNAL_PAGE_LINK: &str = "suivelle://page/";

fn collect_text(v: &Value, out: &mut String) {
    match v {
        Value::Object(o) => {
            match o.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(t) = o.get("text").and_then(Value::as_str) {
                        out.push_str(t);
                    }
                }
                Some("hardBreak") => out.push(' '),
                // Mentions render the target's live title; their id is not searchable text.
                Some("pageMention") => {}
                _ => {}
            }
            if let Some(content) = o.get("content") {
                collect_text(content, out);
                out.push(' ');
            }
        }
        Value::Array(a) => {
            for item in a {
                collect_text(item, out);
            }
        }
        _ => {}
    }
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The searchable text of a block. Code and equations are deliberately not indexed.
pub fn plain_text(block_type: &str, schema_version: i64, data_json: &str) -> String {
    let Ok(data) = serde_json::from_str::<Value>(data_json) else {
        return String::new();
    };
    match block_type {
        "code" | "equation" | "divider" => String::new(),
        "calendar_event" => squash(
            &["start", "end", "location"]
                .iter()
                .filter_map(|k| data.get(k).and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" "),
        ),
        "embed" => squash(
            &["title", "caption", "url"]
                .iter()
                .filter_map(|key| data.get(key).and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" "),
        ),
        "image" | "audio" | "video" | "pdf" | "file" => data
            .pointer("/attachment/name")
            .and_then(Value::as_str)
            .map(squash)
            .unwrap_or_default(),
        "simple_table" => {
            let mut out = String::new();
            if let Some(t) = data.get("table") {
                collect_text(t, &mut out);
            }
            squash(&out)
        }
        _ => {
            if schema_version < 2 {
                return data
                    .get("text")
                    .and_then(Value::as_str)
                    .map(squash)
                    .unwrap_or_default();
            }
            let mut out = String::new();
            if let Some(c) = data.get("content") {
                collect_text(c, &mut out);
            }
            squash(&out)
        }
    }
}

fn looks_like_id(s: &str) -> bool {
    s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn walk_refs(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("pageMention") {
                if let Some(id) = v.pointer("/attrs/pageId").and_then(Value::as_str) {
                    if looks_like_id(id) {
                        out.push(id.to_ascii_lowercase());
                    }
                }
            }
            if o.get("type").and_then(Value::as_str) == Some("link") {
                if let Some(rest) = v
                    .pointer("/attrs/href")
                    .and_then(Value::as_str)
                    .and_then(crate::legacy::page_target)
                {
                    if looks_like_id(rest) {
                        out.push(rest.to_ascii_lowercase());
                    }
                }
            }
            for child in o.values() {
                walk_refs(child, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|c| walk_refs(c, out)),
        _ => {}
    }
}

/// Page ids a block mentions (`pageMention` nodes) or links to (`suivelle://page/<id>`), deduplicated.
pub fn extract_refs(data_json: &str) -> Vec<String> {
    let Ok(data) = serde_json::from_str::<Value>(data_json) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(links) = data.get("links").and_then(Value::as_array) {
        for link in links {
            if let Some(id) = link
                .get("pageId")
                .and_then(Value::as_str)
                .filter(|s| looks_like_id(s))
            {
                out.push(id.to_ascii_lowercase());
            }
        }
    }
    walk_refs(&data, &mut out);
    out.sort();
    out.dedup();
    out
}

/// Builds an FTS5 expression from free text: every word becomes a quoted prefix term, so user
/// input can never be parsed as FTS syntax (`AND`, `NEAR`, `-`, `:` or stray quotes are literal).
pub fn fts_query(input: &str, titles_only: bool) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .filter(|t| t.chars().any(char::is_alphanumeric))
        .take(8)
        .map(|t| {
            let t: String = t.chars().take(64).collect();
            format!("\"{}\"*", t.replace('"', "\"\""))
        })
        .collect();
    if terms.is_empty() {
        return None;
    }
    let joined = terms.join(" ");
    Some(if titles_only {
        format!("title : ({joined})")
    } else {
        joined
    })
}

/// Longest tag kept, in characters; anything longer is cut there.
const MAX_TAG_CHARS: usize = 48;

/// The #tags in `text`, lowercased, in first-seen order. A tag starts with a letter after `#`
/// that does not follow a word character (so `C#`, URL fragments and `#1` are not tags) and
/// runs over letters, digits, `_`, `-` and `/`.
pub fn extract_tags(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    for i in 0..chars.len() {
        if chars[i] != '#' {
            continue;
        }
        let after_word = i > 0
            && (chars[i - 1].is_alphanumeric() || matches!(chars[i - 1], '#' | '/' | '&' | '_'));
        if after_word || !chars.get(i + 1).is_some_and(|c| c.is_alphabetic()) {
            continue;
        }
        let tag: String = chars[i + 1..]
            .iter()
            .take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
            .take(MAX_TAG_CHARS)
            .collect::<String>()
            .trim_end_matches(['-', '/', '_'])
            .to_lowercase();
        if !tag.is_empty() && !out.contains(&tag) {
            out.push(tag);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_rich_text_and_ignores_non_text() {
        let json = r#"{"content":[{"type":"text","text":"Hello "},{"type":"text","text":"world","marks":[{"type":"bold"}]},{"type":"hardBreak"},{"type":"pageMention","attrs":{"pageId":"x"}},{"type":"text","text":"again"}]}"#;
        assert_eq!(plain_text("paragraph", 2, json), "Hello world again");
        assert_eq!(
            plain_text("code", 2, r#"{"text":"secret()","language":"rust"}"#),
            ""
        );
        assert_eq!(plain_text("equation", 2, r#"{"latex":"x^2"}"#), "");
        assert_eq!(plain_text("divider", 2, "{}"), "");
    }

    #[test]
    fn handles_legacy_tables_media_and_bad_json() {
        assert_eq!(
            plain_text("paragraph", 1, r#"{"text":"  legacy   text "}"#),
            "legacy text"
        );
        assert_eq!(
            plain_text("image", 2, r#"{"attachment":{"name":"arena map.png"}}"#),
            "arena map.png"
        );
        assert_eq!(plain_text("image", 2, r#"{"attachment":null}"#), "");
        assert_eq!(plain_text("paragraph", 2, "not json"), "");
        let table = r#"{"table":{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"cell"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"two"}]}]}]}]}}"#;
        assert_eq!(plain_text("simple_table", 2, table), "cell two");
    }

    #[test]
    fn extracts_mentions_and_internal_links_once() {
        let a = "0190a000-0000-7000-8000-000000000001";
        let b = "0190A000-0000-7000-8000-000000000002";
        let json = format!(
            r#"{{"content":[{{"type":"pageMention","attrs":{{"pageId":"{a}"}}}},{{"type":"pageMention","attrs":{{"pageId":"{a}"}}}},{{"type":"text","text":"x","marks":[{{"type":"link","attrs":{{"href":"suivelle://page/{b}"}}}},{{"type":"link","attrs":{{"href":"https://example.com"}}}}]}},{{"type":"pageMention","attrs":{{"pageId":"not-an-id"}}}}]}}"#
        );
        let refs = extract_refs(&json);
        assert_eq!(refs, vec![a.to_string(), b.to_ascii_lowercase()]);
        assert!(extract_refs("garbage").is_empty());
    }

    #[test]
    fn builds_safe_fts_queries() {
        assert_eq!(
            fts_query("parry timing", false).as_deref(),
            Some("\"parry\"* \"timing\"*")
        );
        assert_eq!(
            fts_query("parry", true).as_deref(),
            Some("title : (\"parry\"*)")
        );
        // Operators and punctuation are literal.
        assert_eq!(
            fts_query("cats AND dogs", false).as_deref(),
            Some("\"cats\"* \"AND\"* \"dogs\"*")
        );
        assert_eq!(
            fts_query("say \"hi\"", false).as_deref(),
            Some("\"say\"* \"\"\"hi\"\"\"*")
        );
        assert_eq!(fts_query("- : ( )", false), None);
        assert_eq!(fts_query("   ", false), None);
        assert_eq!(
            fts_query("a b c d e f g h i j", false)
                .unwrap()
                .matches("\"*")
                .count(),
            8
        );
    }
}

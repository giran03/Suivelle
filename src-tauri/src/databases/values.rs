//! Property configuration and cell value validation.

use super::{Property, MAX_OPTIONS};
use crate::domain::new_id;
use crate::errors::{AppError, AppResult};
use chrono::{NaiveDate, NaiveDateTime};
use serde_json::{json, Value};

pub const TONES: [&str; 6] = ["gray", "violet", "red", "orange", "green", "blue"];
const STATUS_GROUPS: [&str; 3] = ["todo", "doing", "done"];
pub const MAX_TEXT: usize = 10_000;
const MAX_URL: usize = 2_048;

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

pub fn is_text_like(t: &str) -> bool {
    matches!(t, "title" | "text" | "url" | "email" | "phone")
}

/// Properties whose value the app computes; they can be filtered and sorted but never edited.
pub fn is_computed(t: &str) -> bool {
    matches!(
        t,
        "created_time" | "updated_time" | "unique_id" | "rollup" | "formula" | "button"
    )
}

pub fn default_config(property_type: &str) -> Value {
    match property_type {
        "select" | "multi_select" => json!({ "options": [] }),
        "status" => json!({ "options": [
            { "id": new_id(), "name": "Not started", "color": "gray", "group": "todo" },
            { "id": new_id(), "name": "In progress", "color": "blue", "group": "doing" },
            { "id": new_id(), "name": "Done", "color": "green", "group": "done" },
        ]}),
        "unique_id" => json!({ "prefix": "" }),
        "button" => json!({ "label": "Run" }),
        _ => json!({}),
    }
}

/// Validates and normalizes a property's config for its type, including data checks and default.
pub fn normalize_config(property_type: &str, config: &Value) -> AppResult<Value> {
    let out = normalize_core(property_type, config)?;
    with_checks(property_type, out, config)
}

fn normalize_core(property_type: &str, config: &Value) -> AppResult<Value> {
    match property_type {
        "select" | "multi_select" | "status" => {
            let options = config
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if options.len() > MAX_OPTIONS {
                return bad(format!("a property can have at most {MAX_OPTIONS} options"));
            }
            let mut seen_ids = std::collections::HashSet::new();
            let mut seen_names = std::collections::HashSet::new();
            let mut out = Vec::new();
            for o in options {
                let name = o
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if name.is_empty() || name.chars().count() > 60 {
                    return bad("option names must be 1-60 characters");
                }
                if !seen_names.insert(name.to_lowercase()) {
                    return bad(format!("duplicate option '{name}'"));
                }
                let id = match o.get("id").and_then(Value::as_str) {
                    Some(id) if !id.is_empty() && id.len() <= 64 => id.to_string(),
                    _ => new_id(),
                };
                if !seen_ids.insert(id.clone()) {
                    return bad("duplicate option id");
                }
                let color = o.get("color").and_then(Value::as_str).unwrap_or("gray");
                if !TONES.contains(&color) {
                    return bad(format!("unknown colour '{color}'"));
                }
                let mut entry = json!({ "id": id, "name": name, "color": color });
                if property_type == "status" {
                    let group = o.get("group").and_then(Value::as_str).unwrap_or("todo");
                    if !STATUS_GROUPS.contains(&group) {
                        return bad(format!("unknown status group '{group}'"));
                    }
                    entry["group"] = json!(group);
                }
                out.push(entry);
            }
            Ok(json!({ "options": out }))
        }
        "unique_id" => {
            let prefix = config
                .get("prefix")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if prefix.chars().count() > 10
                || !prefix
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-')
            {
                return bad("the ID prefix can be up to 10 letters, digits or dashes");
            }
            Ok(json!({ "prefix": prefix }))
        }
        "button" => {
            let label = config
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .unwrap_or("Run");
            if label.chars().count() > 40 {
                return bad("a button label can be at most 40 characters");
            }
            Ok(json!({ "label": label }))
        }
        "number" => with_format(json!({}), config),
        _ => Ok(json!({})),
    }
}

/// Copies a validated `format` (display only: decimals, separators, percent, currency, unit,
/// progress bar) from `input` into a normalized number, rollup or formula config.
pub fn with_format(mut out: Value, input: &Value) -> AppResult<Value> {
    let Some(f) = input.get("format").and_then(Value::as_object) else {
        return Ok(out);
    };
    let mut clean = serde_json::Map::new();
    if let Some(d) = f.get("decimals").filter(|v| !v.is_null()) {
        match d.as_u64() {
            Some(n) if n <= 10 => clean.insert("decimals".into(), json!(n)),
            _ => return bad("decimals must be a whole number from 0 to 10"),
        };
    }
    for key in ["thousands", "percent", "bar"] {
        if let Some(b) = f.get(key).filter(|v| !v.is_null()) {
            let Some(b) = b.as_bool() else {
                return bad(format!("format option '{key}' must be true or false"));
            };
            if b {
                clean.insert(key.into(), json!(true));
            }
        }
    }
    for (key, max) in [("currency", 4), ("unit", 12)] {
        if let Some(t) = f.get(key).and_then(Value::as_str) {
            let t = t.trim();
            if t.chars().count() > max {
                return bad(format!("the {key} text can be at most {max} characters"));
            }
            if !t.is_empty() {
                clean.insert(key.into(), json!(t));
            }
        }
    }
    if let Some(m) = f.get("barMax").filter(|v| !v.is_null()) {
        match m.as_f64() {
            Some(n) if n.is_finite() && n > 0.0 => clean.insert("barMax".into(), json!(n)),
            _ => return bad("the progress bar maximum must be a positive number"),
        };
    }
    if !clean.is_empty() {
        out["format"] = Value::Object(clean);
    }
    Ok(out)
}

/// Types whose cells can carry data checks (`validation`) and a default value (`default`).
pub fn supports_checks(t: &str) -> bool {
    matches!(
        t,
        "title"
            | "text"
            | "url"
            | "email"
            | "phone"
            | "number"
            | "select"
            | "multi_select"
            | "status"
            | "date"
            | "checkbox"
    )
}

/// Copies validated data checks and a default value from `input` into a normalized config.
/// Checks only mark cells (they never reject a write), so imports and pastes keep working.
/// The marking itself happens in the app (`validation.ts`); a pattern check is left out because
/// the backend has no regular-expression engine.
pub fn with_checks(property_type: &str, mut out: Value, input: &Value) -> AppResult<Value> {
    if !supports_checks(property_type) {
        return Ok(out);
    }
    let text = matches!(property_type, "title" | "text" | "url" | "email" | "phone");
    if let Some(v) = input.get("validation").and_then(Value::as_object) {
        let mut clean = serde_json::Map::new();
        for key in ["required", "unique"] {
            match v.get(key).filter(|x| !x.is_null()) {
                None | Some(Value::Bool(false)) => {}
                Some(Value::Bool(true)) => {
                    if key == "unique"
                        && !(text || matches!(property_type, "number" | "select" | "status"))
                    {
                        return bad("this property type cannot be required to be unique");
                    }
                    clean.insert(key.into(), json!(true));
                }
                Some(_) => return bad(format!("'{key}' must be true or false")),
            }
        }
        for key in ["min", "max"] {
            if let Some(n) = v.get(key).filter(|x| !x.is_null()) {
                if !(text || property_type == "number") {
                    return bad("minimum and maximum apply to text and number properties");
                }
                match n.as_f64() {
                    Some(f) if f.is_finite() && (property_type == "number" || f >= 0.0) => {
                        clean.insert(key.into(), json!(f));
                    }
                    _ => return bad(format!("'{key}' must be a number")),
                }
            }
        }
        if let (Some(lo), Some(hi)) = (
            clean.get("min").and_then(Value::as_f64),
            clean.get("max").and_then(Value::as_f64),
        ) {
            if lo > hi {
                return bad("the minimum is larger than the maximum");
            }
        }
        if let Some(f) = v
            .get("format")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            if !matches!(property_type, "text" | "title") || !matches!(f, "email" | "url") {
                return bad("a format check must be email or url, on a text property");
            }
            clean.insert("format".into(), json!(f));
        }
        if !clean.is_empty() {
            out["validation"] = Value::Object(clean);
        }
    }
    if let Some(d) = input.get("default").filter(|d| !d.is_null()) {
        if property_type == "title" {
            return bad("a title cannot have a default value");
        }
        let probe = Property {
            id: String::new(),
            database_id: String::new(),
            name: String::new(),
            property_type: property_type.to_string(),
            config: out.clone(),
            position: 0.0,
        };
        match normalize_value(&probe, d) {
            Ok(Some(v)) => out["default"] = v,
            Ok(None) => {}
            // A default option that was deleted is dropped rather than blocking the edit.
            Err(_) if matches!(property_type, "select" | "multi_select" | "status") => {}
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

/// The default value a new record gets for this property, if one is set and still valid.
pub fn default_of(prop: &Property) -> Option<Value> {
    let d = prop.config.get("default")?;
    normalize_value(prop, d).ok().flatten()
}

pub fn option_ids(prop: &Property) -> Vec<String> {
    prop.config
        .get("options")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|o| o.get("id").and_then(Value::as_str).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_when(s: &str) -> Option<NaiveDateTime> {
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return d.and_hms_opt(0, 0, 0);
    }
    for fmt in [
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%.f",
    ] {
        if let Ok(d) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(d);
        }
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.naive_utc())
}

/// Validates a cell value for a property. `Ok(None)` means "clear the cell".
pub fn normalize_value(prop: &Property, value: &Value) -> AppResult<Option<Value>> {
    let t = prop.property_type.as_str();
    if is_computed(t) {
        return bad(format!(
            "'{}' is calculated and cannot be edited",
            prop.name
        ));
    }
    if value.is_null() {
        return Ok(None);
    }
    match t {
        "text" | "url" | "email" | "phone" => {
            let Some(s) = value.as_str() else {
                return bad("expected text");
            };
            let limit = if t == "url" { MAX_URL } else { MAX_TEXT };
            if s.chars().count() > limit {
                return bad(format!("text is longer than {limit} characters"));
            }
            let s = if t == "text" {
                s.to_string()
            } else {
                s.trim().to_string()
            };
            if s.is_empty() {
                return Ok(None);
            }
            if t == "email" && (!s.contains('@') || s.contains(char::is_whitespace)) {
                return bad("enter a valid email address");
            }
            if t == "phone"
                && (s.chars().count() > 40
                    || !s
                        .chars()
                        .all(|c| c.is_ascii_digit() || " +-().x#*,".contains(c)))
            {
                return bad("enter a valid phone number");
            }
            Ok(Some(json!(s)))
        }
        "number" => match value.as_f64() {
            Some(n) if n.is_finite() => Ok(Some(json!(n))),
            _ => bad("expected a number"),
        },
        "checkbox" => match value.as_bool() {
            Some(true) => Ok(Some(json!(true))),
            Some(false) => Ok(None),
            None => bad("expected true or false"),
        },
        "select" | "status" => {
            let Some(id) = value.as_str() else {
                return bad("expected an option");
            };
            if !option_ids(prop).iter().any(|o| o == id) {
                return bad("unknown option");
            }
            Ok(Some(json!(id)))
        }
        "multi_select" => {
            let Some(arr) = value.as_array() else {
                return bad("expected a list of options");
            };
            let valid = option_ids(prop);
            let mut out: Vec<String> = Vec::new();
            for v in arr {
                let Some(id) = v.as_str() else {
                    return bad("expected option ids");
                };
                if !valid.iter().any(|o| o == id) {
                    return bad("unknown option");
                }
                if !out.iter().any(|o| o == id) {
                    out.push(id.to_string());
                }
            }
            Ok(if out.is_empty() {
                None
            } else {
                Some(json!(out))
            })
        }
        "date" => {
            let Some(obj) = value.as_object() else {
                return bad("expected a date");
            };
            let Some(start) = obj.get("start").and_then(Value::as_str) else {
                return bad("a date needs a start");
            };
            let Some(s) = parse_when(start) else {
                return bad("invalid start date");
            };
            let mut out = json!({ "start": start });
            if let Some(end) = obj
                .get("end")
                .and_then(Value::as_str)
                .filter(|e| !e.is_empty())
            {
                let Some(e) = parse_when(end) else {
                    return bad("invalid end date");
                };
                if e < s {
                    return bad("the end date is before the start date");
                }
                out["end"] = json!(end);
            }
            Ok(Some(out))
        }
        other => bad(format!("unsupported property type '{other}'")),
    }
}

/// Plain text of a text-like value, for the search index.
pub fn searchable_text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

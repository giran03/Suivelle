//! Finding and fixing data: groups of duplicate records, and copying a property with its values.

use super::service::{self, load_database, load_properties, load_property};
use super::values::{self, is_computed, is_text_like};
use super::{Property, PropertyCreate};
use crate::errors::{AppError, AppResult};
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// The most groups one report returns; the counts still cover every group.
pub const MAX_GROUPS: usize = 500;
const MAX_KEY_PROPERTIES: usize = 5;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateQuery {
    pub database_id: String,
    /// Records are duplicates when every one of these properties matches.
    pub property_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateRecord {
    pub id: String,
    pub page_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    /// The shared values, as text.
    pub label: String,
    /// Oldest first: the first is the one to keep.
    pub records: Vec<DuplicateRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateReport {
    pub groups: Vec<DuplicateGroup>,
    /// Groups found, which may be more than were returned.
    pub group_count: usize,
    /// Records that would be removed, keeping the oldest of each group.
    pub extra_count: usize,
    pub truncated: bool,
}

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

fn comparable(t: &str) -> bool {
    values::supports_checks(t)
}

/// The text a value is compared by: case and surrounding spaces do not matter for text.
fn key_part(prop: &Property, title: &str, raw: Option<&str>) -> String {
    if prop.property_type == "title" {
        return title.trim().to_lowercase();
    }
    let Some(raw) = raw else {
        return String::new();
    };
    let v: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    match (&v, prop.property_type.as_str()) {
        (Value::String(s), t) if is_text_like(t) => s.trim().to_lowercase(),
        (Value::Array(a), _) => {
            let mut ids: Vec<String> = a.iter().map(|x| x.to_string()).collect();
            ids.sort();
            ids.join(",")
        }
        (Value::Bool(false) | Value::Null, _) => String::new(),
        _ => v.to_string(),
    }
}

/// A value as people read it, for labelling a group.
fn display(prop: &Property, title: &str, raw: Option<&str>) -> String {
    if prop.property_type == "title" {
        return title.to_string();
    }
    let Some(v) = raw.and_then(|r| serde_json::from_str::<Value>(r).ok()) else {
        return String::new();
    };
    let option_name = |id: &str| {
        prop.config
            .get("options")
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find(|o| o.get("id").and_then(Value::as_str) == Some(id)))
            .and_then(|o| o.get("name").and_then(Value::as_str))
            .unwrap_or("?")
            .to_string()
    };
    match (&v, prop.property_type.as_str()) {
        (Value::String(s), "select" | "status") => option_name(s),
        (Value::String(s), _) => s.clone(),
        (Value::Number(n), _) => n.to_string(),
        (Value::Bool(true), _) => "Checked".into(),
        (Value::Array(a), _) => a
            .iter()
            .filter_map(Value::as_str)
            .map(option_name)
            .collect::<Vec<_>>()
            .join(", "),
        (Value::Object(o), _) => o.get("start").and_then(Value::as_str).unwrap_or("").into(),
        _ => String::new(),
    }
}

/// Groups of live records that share the same values in the chosen properties.
pub fn find_duplicates(conn: &Connection, input: &DuplicateQuery) -> AppResult<DuplicateReport> {
    let db = load_database(conn, &input.database_id)?;
    let all = load_properties(conn, &db.id)?;
    if input.property_ids.is_empty() || input.property_ids.len() > MAX_KEY_PROPERTIES {
        return bad(format!(
            "choose between 1 and {MAX_KEY_PROPERTIES} properties to compare"
        ));
    }
    let mut chosen: Vec<&Property> = Vec::new();
    for id in &input.property_ids {
        let Some(p) = all.iter().find(|p| &p.id == id) else {
            return bad("unknown property");
        };
        if !comparable(&p.property_type) {
            return bad(format!("'{}' cannot be compared for duplicates", p.name));
        }
        if !chosen.iter().any(|c| c.id == p.id) {
            chosen.push(p);
        }
    }

    // Stored values of the chosen properties, by record.
    let marks = vec!["?"; chosen.len()].join(",");
    let mut stmt = conn.prepare(&format!(
        "SELECT record_id, property_id, value_json FROM db_value WHERE property_id IN ({marks})"
    ))?;
    let mut stored: HashMap<String, HashMap<String, String>> = HashMap::new();
    let rows = stmt.query_map(params_from_iter(chosen.iter().map(|p| p.id.as_str())), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })?;
    for row in rows {
        let (record, prop, json) = row?;
        stored.entry(record).or_default().insert(prop, json);
    }

    let mut stmt = conn.prepare(
        "SELECT r.id, r.page_id, p.title FROM db_record r JOIN page p ON p.id = r.page_id \
         WHERE r.database_id = ?1 AND p.deleted_at IS NULL ORDER BY r.created_at, r.unique_id",
    )?;
    let records = stmt
        .query_map(params![db.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, DuplicateGroup> = HashMap::new();
    for (id, page_id, title) in records {
        let values = stored.get(&id);
        let parts: Vec<String> = chosen
            .iter()
            .map(|p| key_part(p, &title, values.and_then(|v| v.get(&p.id)).map(String::as_str)))
            .collect();
        // A record with nothing in any compared property is not a duplicate of the next one.
        if parts.iter().all(String::is_empty) {
            continue;
        }
        let key = parts.join("\u{1f}");
        let entry = groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            let label = chosen
                .iter()
                .map(|p| display(p, &title, values.and_then(|v| v.get(&p.id)).map(String::as_str)))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" / ");
            DuplicateGroup { label, records: Vec::new() }
        });
        entry.records.push(DuplicateRecord { id, page_id, title });
    }

    let mut found: Vec<DuplicateGroup> = order
        .into_iter()
        .filter_map(|k| groups.remove(&k))
        .filter(|g| g.records.len() > 1)
        .collect();
    // Biggest groups first; the sort is stable so equal sizes keep their oldest-first order.
    found.sort_by(|a, b| b.records.len().cmp(&a.records.len()));
    let group_count = found.len();
    let extra_count = found.iter().map(|g| g.records.len() - 1).sum();
    let truncated = group_count > MAX_GROUPS;
    found.truncate(MAX_GROUPS);
    Ok(DuplicateReport { groups: found, group_count, extra_count, truncated })
}

/// Adds a copy of a property (same type and settings) to the database, with every value copied.
/// Relations cannot be copied: they pair two databases.
pub fn duplicate_property(conn: &mut Connection, id: &str) -> AppResult<Property> {
    let tx = conn.transaction()?;
    let source = load_property(&tx, id)?;
    if matches!(source.property_type.as_str(), "title" | "relation") {
        return bad(format!(
            "a {} property cannot be duplicated",
            source.property_type
        ));
    }
    let existing = load_properties(&tx, &source.database_id)?;
    let base: String = source.name.chars().take(50).collect();
    let mut name = format!("{base} copy");
    let mut n = 2;
    while existing.iter().any(|p| p.name.eq_ignore_ascii_case(&name)) {
        name = format!("{base} copy {n}");
        n += 1;
    }
    let copy = service::add_property_in(
        &tx,
        PropertyCreate {
            database_id: source.database_id.clone(),
            name,
            property_type: source.property_type.clone(),
            config: Some(source.config.clone()),
        },
    )?;
    if !is_computed(&source.property_type) {
        tx.execute(
            "INSERT INTO db_value (record_id, property_id, value_json) \
             SELECT record_id, ?1, value_json FROM db_value WHERE property_id = ?2",
            params![copy.id, source.id],
        )?;
        if is_text_like(&copy.property_type) {
            let db = load_database(&tx, &copy.database_id)?;
            let mut stmt = tx.prepare(
                "SELECT v.record_id, r.page_id, v.value_json FROM db_value v \
                 JOIN db_record r ON r.id = v.record_id WHERE v.property_id = ?1",
            )?;
            let rows = stmt
                .query_map([&copy.id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            for (record_id, page_id, json) in rows {
                let value: Value = serde_json::from_str(&json).unwrap_or(Value::Null);
                service::index_value(&tx, &db.workspace_id, &page_id, &record_id, &copy, Some(&value))?;
            }
        }
    }
    let out = load_property(&tx, &copy.id)?;
    tx.commit()?;
    Ok(out)
}

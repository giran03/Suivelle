//! Relations and rollups.
//!
//! A relation links records of one database to records of another (or the same) database. A
//! two-way relation has a reverse property in the target database; links are stored once per
//! direction so both sides read, filter and count identically. A rollup summarizes a property of
//! the linked records. Rollup values are computed whenever rows are loaded, never stored.

use super::service::{
    attach_columns, ensure_unique_name, insert_property, load_database, load_properties,
    load_property,
};
use super::*;
use crate::domain::now;
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

pub fn is_link_type(t: &str) -> bool {
    matches!(t, "relation" | "rollup")
}

fn str_of<'a>(config: &'a Value, key: &str) -> Option<&'a str> {
    config
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

// ---------------------------------------------------------------------------------------------
// creating and configuring
// ---------------------------------------------------------------------------------------------

/// Creates a relation property (and its reverse in the target database when two-way).
/// `config` is `{ targetDatabaseId, twoWay? }`; two-way is the default.
pub fn create_relation(
    conn: &Connection,
    db: &Database,
    name: &str,
    config: &Value,
) -> AppResult<Property> {
    let Some(target_id) = str_of(config, "targetDatabaseId") else {
        return bad("choose the database to relate to");
    };
    let two_way = config
        .get("twoWay")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let target = load_database(conn, target_id)?;
    if target.workspace_id != db.workspace_id {
        return bad("a relation can only point to a database in the same workspace");
    }
    let target_page = repo::page::get(conn, &target.page_id)?
        .filter(|p| p.deleted_at.is_none())
        .ok_or_else(|| AppError::NotFound("database".into()))?;

    let props = load_properties(conn, &db.id)?;
    let position = props.iter().map(|p| p.position).fold(0.0, f64::max) + 1.0;
    let forward = insert_property(
        conn,
        &db.id,
        name,
        "relation",
        &json!({ "targetDatabaseId": target.id, "reverseId": null }),
        position,
    )?;
    attach_columns(conn, &db.id, &forward)?;
    if !two_way {
        return Ok(forward);
    }

    let target_props = load_properties(conn, &target.id)?;
    if target_props.len() >= MAX_PROPERTIES {
        return bad(format!(
            "the target database already has {MAX_PROPERTIES} properties, so it cannot hold the reverse relation"
        ));
    }
    let source_title = repo::page::get(conn, &db.page_id)?
        .map(|p| p.title)
        .unwrap_or_default();
    let custom =
        str_of(config, "reverseName").map(|n| n.trim().chars().take(60).collect::<String>());
    let base = if let Some(n) = custom.filter(|n| !n.is_empty()) {
        n
    } else if target.id == db.id {
        format!("Related to {name}")
    } else if source_title.trim().is_empty() {
        "Related".to_string()
    } else {
        source_title.trim().chars().take(50).collect()
    };
    let mut reverse_name = base.clone();
    let mut n = 2;
    while ensure_unique_name(&target_props, &reverse_name, None).is_err() {
        reverse_name = format!("{base} ({n})");
        n += 1;
    }
    let _ = target_page;
    let target_pos = target_props.iter().map(|p| p.position).fold(0.0, f64::max) + 1.0;
    let reverse = insert_property(
        conn,
        &target.id,
        &reverse_name,
        "relation",
        &json!({ "targetDatabaseId": db.id, "reverseId": forward.id }),
        target_pos,
    )?;
    attach_columns(conn, &target.id, &reverse)?;
    let config = json!({ "targetDatabaseId": target.id, "reverseId": reverse.id });
    conn.execute(
        "UPDATE db_property SET config_json = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?1",
        params![forward.id, config.to_string(), now()],
    )?;
    Ok(Property { config, ..forward })
}

/// The database a relation property points to, and its reverse property if any.
pub fn relation_parts(prop: &Property) -> Option<(String, Option<String>)> {
    let target = str_of(&prop.config, "targetDatabaseId")?.to_string();
    Some((target, str_of(&prop.config, "reverseId").map(String::from)))
}

/// Validates a rollup's config against the database's properties and normalizes it.
pub fn normalize_rollup(conn: &Connection, props: &[Property], config: &Value) -> AppResult<Value> {
    let (Some(rel_id), Some(target_id), Some(function)) = (
        str_of(config, "relationPropertyId"),
        str_of(config, "targetPropertyId"),
        str_of(config, "function"),
    ) else {
        return bad("a rollup needs a relation, a property and a calculation");
    };
    if !ROLLUP_FUNCTIONS.contains(&function) {
        return bad(format!("unknown rollup calculation '{function}'"));
    }
    let Some(rel) = props
        .iter()
        .find(|p| p.id == rel_id && p.property_type == "relation")
    else {
        return bad("choose one of this database's relation properties");
    };
    let Some((target_db, _)) = relation_parts(rel) else {
        return bad("that relation is not set up");
    };
    let target = load_property(conn, target_id)?;
    if target.database_id != target_db {
        return bad("that property is not in the related database");
    }
    if is_link_type(&target.property_type) {
        return bad("a rollup cannot summarize another relation or rollup");
    }
    let t = target.property_type.as_str();
    let ok = match function {
        "sum" | "average" | "min" | "max" => matches!(t, "number" | "unique_id"),
        "earliest" | "latest" => matches!(t, "date" | "created_time" | "updated_time"),
        "percent_checked" => t == "checkbox",
        "percent_done" => t == "status",
        _ => true,
    };
    if !ok {
        return bad(format!("'{function}' cannot be used with a {t} property"));
    }
    Ok(json!({ "relationPropertyId": rel_id, "targetPropertyId": target_id, "function": function }))
}

/// Called before a relation property is removed: its reverse (if any) becomes one-way.
pub fn detach_relation(conn: &Connection, prop: &Property) -> AppResult<()> {
    let Some((_, Some(reverse_id))) = relation_parts(prop) else {
        return Ok(());
    };
    if let Ok(rev) = load_property(conn, &reverse_id) {
        let mut config = rev.config.clone();
        config["reverseId"] = Value::Null;
        conn.execute(
            "UPDATE db_property SET config_json = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?1",
            params![rev.id, config.to_string(), now()],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------------------------

/// Replaces the links of one relation cell, keeping the reverse side in step.
pub fn set_links(
    conn: &Connection,
    prop: &Property,
    record_id: &str,
    ids: &[String],
) -> AppResult<()> {
    let Some((target_db, reverse)) = relation_parts(prop) else {
        return bad("that relation is not set up");
    };
    if ids.len() > MAX_RELATION_LINKS {
        return bad(format!(
            "a relation can link at most {MAX_RELATION_LINKS} records"
        ));
    }
    let mut seen = HashSet::new();
    for id in ids {
        if id == record_id {
            return bad("a record cannot be related to itself");
        }
        if !seen.insert(id.as_str()) {
            continue;
        }
        let ok: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM db_record r JOIN page p ON p.id = r.page_id WHERE r.id = ?1 AND r.database_id = ?2 AND p.deleted_at IS NULL",
                params![id, target_db],
                |r| r.get(0),
            )
            .optional()?;
        if ok.is_none() {
            return bad("one of the linked records does not exist");
        }
    }
    // Links to records that are in the trash are not shown, so they are kept as they are.
    let hidden: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT rel.to_record_id FROM db_relation rel JOIN db_record tr ON tr.id = rel.to_record_id JOIN page tp ON tp.id = tr.page_id
             WHERE rel.property_id = ?1 AND rel.from_record_id = ?2 AND tp.deleted_at IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![prop.id, record_id], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut ordered: Vec<&String> = Vec::new();
    for id in ids {
        if !ordered.contains(&id) {
            ordered.push(id);
        }
    }

    conn.execute(
        "DELETE FROM db_relation WHERE property_id = ?1 AND from_record_id = ?2 AND to_record_id NOT IN (SELECT value FROM json_each(?3))",
        params![prop.id, record_id, serde_json::to_string(&hidden).unwrap_or_else(|_| "[]".into())],
    )?;
    if let Some(rev) = &reverse {
        conn.execute(
            "DELETE FROM db_relation WHERE property_id = ?1 AND to_record_id = ?2 AND from_record_id NOT IN (SELECT value FROM json_each(?3))",
            params![rev, record_id, serde_json::to_string(&hidden).unwrap_or_else(|_| "[]".into())],
        )?;
    }
    for (i, id) in ordered.iter().enumerate() {
        conn.execute(
            "INSERT OR REPLACE INTO db_relation (property_id, from_record_id, to_record_id, position) VALUES (?1, ?2, ?3, ?4)",
            params![prop.id, record_id, id, i as i64],
        )?;
        if let Some(rev) = &reverse {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM db_relation WHERE property_id = ?1 AND from_record_id = ?2 AND to_record_id <> ?3",
                params![rev, id, record_id],
                |r| r.get(0),
            )?;
            if count as usize >= MAX_RELATION_LINKS {
                return bad(format!(
                    "a linked record already has {MAX_RELATION_LINKS} related records"
                ));
            }
            conn.execute(
                "INSERT OR REPLACE INTO db_relation (property_id, from_record_id, to_record_id, position) VALUES (?1, ?2, ?3, ?4)",
                params![rev, id, record_id, count],
            )?;
        }
    }
    Ok(())
}

/// The workspace's live databases, for choosing a relation target.
pub fn list_databases(conn: &Connection, workspace_id: &str) -> AppResult<Vec<DatabaseRef>> {
    crate::domain::validate_id(workspace_id, "workspace")?;
    let mut stmt = conn.prepare(
        "SELECT d.id, d.page_id, p.title FROM db_database d JOIN page p ON p.id = d.page_id
         WHERE d.workspace_id = ?1 AND p.deleted_at IS NULL ORDER BY p.title COLLATE NOCASE, p.created_at",
    )?;
    let rows = stmt.query_map([workspace_id], |r| {
        Ok(DatabaseRef {
            id: r.get(0)?,
            page_id: r.get(1)?,
            title: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn lookup(conn: &Connection, input: &RecordLookup) -> AppResult<Vec<RecordRef>> {
    crate::domain::validate_id(&input.database_id, "database")?;
    load_database(conn, &input.database_id)?;
    let limit = input.limit.unwrap_or(20).clamp(1, 50);
    let q = format!(
        "%{}%",
        input
            .query
            .trim()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let mut stmt = conn.prepare(
        "SELECT r.id, r.page_id, p.title FROM db_record r JOIN page p ON p.id = r.page_id
         WHERE r.database_id = ?1 AND p.deleted_at IS NULL AND p.title LIKE ?2 ESCAPE '\\'
         ORDER BY p.title COLLATE NOCASE, r.unique_id LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![input.database_id, q, limit], |r| {
        Ok(RecordRef {
            id: r.get(0)?,
            page_id: r.get(1)?,
            title: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

// ---------------------------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------------------------

/// Adds relation links and rollup results to freshly loaded rows.
pub fn decorate(conn: &Connection, rows: &mut [RecordRow]) -> AppResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let dbs: HashSet<&str> = rows.iter().map(|r| r.database_id.as_str()).collect();
    let mut link_props: Vec<Property> = Vec::new();
    for db in dbs {
        link_props.extend(
            load_properties(conn, db)?
                .into_iter()
                .filter(|p| is_link_type(&p.property_type)),
        );
    }
    if link_props.is_empty() {
        return apply_formulas(conn, rows);
    }
    let ids: Vec<&String> = rows.iter().map(|r| &r.id).collect();
    let marks = vec!["?"; ids.len()].join(",");
    let index: HashMap<&str, usize> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| (r.id.as_str(), i))
        .collect();
    let all_props: HashMap<String, Property> = {
        let mut m = HashMap::new();
        for p in &link_props {
            m.insert(p.id.clone(), p.clone());
        }
        m
    };

    let mut updates: Vec<(usize, String, Value)> = Vec::new();

    // relation cells
    let relations: Vec<&Property> = link_props
        .iter()
        .filter(|p| p.property_type == "relation")
        .collect();
    if !relations.is_empty() {
        let pmarks = vec!["?"; relations.len()].join(",");
        let mut stmt = conn.prepare(&format!(
            "SELECT rel.from_record_id, rel.property_id, tr.id, tr.page_id, tp.title
             FROM db_relation rel JOIN db_record tr ON tr.id = rel.to_record_id JOIN page tp ON tp.id = tr.page_id
             WHERE rel.property_id IN ({pmarks}) AND rel.from_record_id IN ({marks}) AND tp.deleted_at IS NULL
             ORDER BY rel.position"
        ))?;
        let args: Vec<&str> = relations
            .iter()
            .map(|p| p.id.as_str())
            .chain(ids.iter().map(|s| s.as_str()))
            .collect();
        let mut cells: HashMap<(usize, String), Vec<Value>> = HashMap::new();
        let mapped = stmt.query_map(params_from_iter(args.iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        for m in mapped {
            let (from, pid, id, page_id, title) = m?;
            if let Some(&i) = index.get(from.as_str()) {
                cells
                    .entry((i, pid))
                    .or_default()
                    .push(json!({ "id": id, "pageId": page_id, "title": title }));
            }
        }
        for ((i, pid), v) in cells {
            updates.push((i, pid, Value::Array(v)));
        }
    }

    // rollups
    for prop in link_props.iter().filter(|p| p.property_type == "rollup") {
        let (Some(rel_id), Some(target_id), Some(function)) = (
            str_of(&prop.config, "relationPropertyId"),
            str_of(&prop.config, "targetPropertyId"),
            str_of(&prop.config, "function"),
        ) else {
            continue;
        };
        let Some(rel) = all_props.get(rel_id) else {
            continue;
        };
        if rel.database_id != prop.database_id {
            continue;
        }
        let Ok(target) = load_property(conn, target_id) else {
            continue;
        };
        let mut stmt = conn.prepare(&format!(
            "SELECT rel.from_record_id, tp.title, tr.unique_id, tr.created_at, tp.updated_at, v.value_json
             FROM db_relation rel JOIN db_record tr ON tr.id = rel.to_record_id JOIN page tp ON tp.id = tr.page_id
             LEFT JOIN db_value v ON v.record_id = tr.id AND v.property_id = ?1
             WHERE rel.property_id = ?2 AND rel.from_record_id IN ({marks}) AND tp.deleted_at IS NULL"
        ))?;
        let args: Vec<&str> = [target.id.as_str(), rel.id.as_str()]
            .into_iter()
            .chain(ids.iter().map(|s| s.as_str()))
            .collect();
        let mapped = stmt.query_map(params_from_iter(args.iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })?;
        let mut grouped: HashMap<usize, Vec<Option<Value>>> = HashMap::new();
        for m in mapped {
            let (from, title, unique, created, updated, json_text) = m?;
            let value = match target.property_type.as_str() {
                "title" => (!title.is_empty()).then(|| json!(title)),
                "unique_id" => Some(json!(unique)),
                "created_time" => Some(json!(created)),
                "updated_time" => Some(json!(updated)),
                _ => json_text.and_then(|s| serde_json::from_str(&s).ok()),
            };
            // "Percent done" counts a task as done when its status option sits in the Done group.
            let value = if function == "percent_done" {
                let id = value.as_ref().and_then(Value::as_str);
                let done = target
                    .config
                    .get("options")
                    .and_then(Value::as_array)
                    .and_then(|o| o.iter().find(|o| o.get("id").and_then(Value::as_str) == id))
                    .is_some_and(|o| o.get("group").and_then(Value::as_str) == Some("done"));
                Some(json!(done))
            } else {
                value
            };
            if let Some(&i) = index.get(from.as_str()) {
                grouped.entry(i).or_default().push(value);
            }
        }
        for (i, vals) in grouped {
            if let Some(v) = compute_rollup(function, &target.property_type, &vals) {
                updates.push((i, prop.id.clone(), v));
            }
        }
        // Records with no links still get zero for counts and sums.
        if matches!(function, "count" | "count_unique" | "sum") {
            for (i, row) in rows.iter().enumerate() {
                if row.database_id == prop.database_id
                    && !updates.iter().any(|(j, p, _)| *j == i && *p == prop.id)
                {
                    updates.push((i, prop.id.clone(), json!(0)));
                }
            }
        }
    }

    for (i, pid, v) in updates {
        rows[i].values.insert(pid, v);
    }
    apply_formulas(conn, rows)
}

/// Formulas read the relation and rollup values, so they are computed last.
fn apply_formulas(conn: &Connection, rows: &mut [RecordRow]) -> AppResult<()> {
    let dbs: HashSet<String> = rows.iter().map(|r| r.database_id.clone()).collect();
    let now = chrono::Local::now().naive_local();
    for db in dbs {
        let props = load_properties(conn, &db)?;
        if props.iter().any(|p| p.property_type == "formula") {
            super::calc::apply_formulas(rows, &props, now);
        }
    }
    Ok(())
}

/// Summarizes the values of a rollup's target property across the linked records.
pub fn compute_rollup(function: &str, target_type: &str, vals: &[Option<Value>]) -> Option<Value> {
    let present: Vec<&Value> = vals.iter().flatten().collect();
    let numbers = || present.iter().filter_map(|v| v.as_f64());
    match function {
        "count" => Some(json!(vals.len())),
        "count_unique" => {
            let set: HashSet<String> = present.iter().map(|v| v.to_string()).collect();
            Some(json!(set.len()))
        }
        "sum" => Some(json!(numbers().sum::<f64>())),
        "average" => {
            let n: Vec<f64> = numbers().collect();
            (!n.is_empty()).then(|| json!(n.iter().sum::<f64>() / n.len() as f64))
        }
        "min" => numbers().reduce(f64::min).map(|n| json!(n)),
        "max" => numbers().reduce(f64::max).map(|n| json!(n)),
        "earliest" | "latest" => {
            let days: Vec<String> = present
                .iter()
                .filter_map(|v| {
                    if target_type == "date" {
                        v.get("start").and_then(Value::as_str).map(String::from)
                    } else {
                        v.as_str().map(String::from)
                    }
                })
                .collect();
            let pick = if function == "earliest" {
                days.into_iter().min()
            } else {
                days.into_iter().max()
            };
            pick.map(|d| json!(d))
        }
        "percent_checked" | "percent_done" => {
            if vals.is_empty() {
                return None;
            }
            let checked = present.iter().filter(|v| v.as_bool() == Some(true)).count();
            Some(json!(checked as f64 * 100.0 / vals.len() as f64))
        }
        _ => None,
    }
}

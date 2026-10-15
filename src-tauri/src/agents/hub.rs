//! The Agent Hub: one ordinary page per workspace holding the Memory and Agent tasks databases
//! and the agents' instruction pages. It is created the first time something needs it, and the
//! user can rename, move or extend it like anything else.

use crate::databases::service::{load_database, load_properties};
use crate::databases::{templates, Property};
use crate::domain::validate_id;
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone)]
pub struct Hub {
    pub page_id: String,
    pub memory_database_id: String,
    pub tasks_database_id: String,
}

fn live_database(conn: &Connection, id: &str) -> bool {
    load_database(conn, id)
        .ok()
        .and_then(|d| repo::page::get(conn, &d.page_id).ok().flatten())
        .is_some_and(|p| p.deleted_at.is_none())
}

pub fn get(conn: &Connection, workspace_id: &str) -> AppResult<Option<Hub>> {
    let hub = conn
        .query_row(
            "SELECT page_id, memory_database_id, tasks_database_id FROM agent_hub WHERE workspace_id = ?1",
            [workspace_id],
            |r| {
                Ok(Hub {
                    page_id: r.get(0)?,
                    memory_database_id: r.get(1)?,
                    tasks_database_id: r.get(2)?,
                })
            },
        )
        .optional()?;
    // A hub whose databases were deleted is rebuilt rather than half-used.
    Ok(hub.filter(|h| live_database(conn, &h.memory_database_id) && live_database(conn, &h.tasks_database_id)))
}

/// The workspace's hub, created inside the caller's transaction when it has none.
pub fn ensure(tx: &Connection, workspace_id: &str) -> AppResult<Hub> {
    validate_id(workspace_id, "workspace")?;
    if let Some(h) = get(tx, workspace_id)? {
        return Ok(h);
    }
    if repo::workspace::get(tx, workspace_id)?.is_none() {
        return Err(AppError::NotFound("workspace".into()));
    }
    let page = crate::transfer::insert_page(tx, None, workspace_id, None, "Agent Hub", None, "page", false)?;
    let (memory, tasks) = templates::build_agent_hub(tx, workspace_id, &page.id)?;
    let intro = "Shared memory, tasks and instructions for the local AI agents connected to this workspace. Agents write here through Settings > Agents; everything they change is listed in the Review inbox and can be reverted.";
    super::content::write_markdown(tx, &page, intro, super::content::WriteMode::Replace)?;
    tx.execute(
        "INSERT INTO agent_hub (workspace_id, page_id, memory_database_id, tasks_database_id) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(workspace_id) DO UPDATE SET page_id = excluded.page_id, memory_database_id = excluded.memory_database_id, tasks_database_id = excluded.tasks_database_id",
        params![workspace_id, page.id, memory, tasks],
    )?;
    Ok(Hub {
        page_id: page.id,
        memory_database_id: memory,
        tasks_database_id: tasks,
    })
}

// ---------------------------------------------------------------------------------------------
// values by name
// ---------------------------------------------------------------------------------------------

pub fn property<'a>(props: &'a [Property], name: &str) -> AppResult<&'a Property> {
    props
        .iter()
        .find(|p| p.name.eq_ignore_ascii_case(name.trim()) || p.id == name)
        .ok_or_else(|| AppError::Validation(format!("No property named '{name}'.")))
}

pub fn option_id(prop: &Property, name: &str) -> Option<String> {
    prop.config
        .get("options")
        .and_then(Value::as_array)?
        .iter()
        .find(|o| {
            o["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name.trim()))
                || o["id"].as_str() == Some(name)
        })
        .and_then(|o| o["id"].as_str().map(String::from))
}

pub fn option_name(prop: &Property, id: &str) -> Option<String> {
    prop.config
        .get("options")
        .and_then(Value::as_array)?
        .iter()
        .find(|o| o["id"].as_str() == Some(id))
        .and_then(|o| o["name"].as_str().map(String::from))
}

/// Turns a value as a person (or agent) writes it into the stored form: option names to ids,
/// "2026-10-20" to a date, page ids or titles to relation targets.
pub fn to_stored(conn: &Connection, prop: &Property, v: &Value) -> AppResult<Value> {
    if v.is_null() {
        return Ok(Value::Null);
    }
    let unknown = |name: &str| AppError::Validation(format!("'{}' has no option '{name}'.", prop.name));
    Ok(match prop.property_type.as_str() {
        "select" | "status" => {
            let s = v.as_str().unwrap_or_default();
            json!(option_id(prop, s).ok_or_else(|| unknown(s))?)
        }
        "multi_select" => {
            let names: Vec<String> = match v {
                Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
                Value::String(s) => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
                _ => vec![],
            };
            let mut ids = Vec::new();
            for n in names {
                ids.push(option_id(prop, &n).ok_or_else(|| unknown(&n))?);
            }
            json!(ids)
        }
        "date" => match v {
            Value::String(s) => json!({ "start": s }),
            other => other.clone(),
        },
        "number" => match v {
            Value::String(s) => s
                .trim()
                .parse::<f64>()
                .map(|n| json!(n))
                .map_err(|_| AppError::Validation(format!("'{}' needs a number.", prop.name)))?,
            other => other.clone(),
        },
        "checkbox" => match v {
            Value::String(s) => json!(matches!(s.to_lowercase().as_str(), "true" | "yes" | "1" | "x")),
            other => other.clone(),
        },
        "relation" => {
            let items: Vec<String> = match v {
                Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
                Value::String(s) => vec![s.clone()],
                _ => vec![],
            };
            let target = prop.config["targetDatabaseId"].as_str().unwrap_or_default();
            let mut ids = Vec::new();
            for it in items {
                // A record id, a record's page id, or a record title in the target database.
                let id: Option<String> = conn
                    .query_row(
                        "SELECT r.id FROM db_record r JOIN page p ON p.id = r.page_id
                         WHERE r.database_id = ?1 AND p.deleted_at IS NULL
                           AND (r.id = ?2 OR r.page_id = ?2 OR lower(trim(p.title)) = lower(trim(?2)))
                         LIMIT 1",
                        params![target, it],
                        |r| r.get(0),
                    )
                    .optional()?;
                ids.push(id.ok_or_else(|| AppError::Validation(format!("'{}' found no record '{it}'.", prop.name)))?);
            }
            json!(ids)
        }
        _ => v.clone(),
    })
}

/// A record's values by property name, in readable form.
pub fn readable(conn: &Connection, props: &[Property], values: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for p in props {
        let Some(v) = values.get(&p.id) else { continue };
        let shown = match p.property_type.as_str() {
            "select" | "status" => v.as_str().and_then(|id| option_name(p, id)).map(Value::from).unwrap_or(Value::Null),
            "multi_select" => Value::from(
                v.as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().and_then(|id| option_name(p, id))).collect::<Vec<_>>())
                    .unwrap_or_default(),
            ),
            "relation" => Value::from(
                v.as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str())
                            .filter_map(|rid| {
                                conn.query_row(
                                    "SELECT p.title FROM db_record r JOIN page p ON p.id = r.page_id WHERE r.id = ?1",
                                    [rid],
                                    |r| r.get::<_, String>(0),
                                )
                                .ok()
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
            ),
            "date" => v.get("start").cloned().map(|s| {
                match v.get("end").and_then(Value::as_str) {
                    Some(e) => Value::from(format!("{} → {e}", s.as_str().unwrap_or(""))),
                    None => s,
                }
            }).unwrap_or(Value::Null),
            _ => v.clone(),
        };
        if !shown.is_null() {
            out.insert(p.name.clone(), shown);
        }
    }
    out
}

/// Values by property name to the stored map the record services take.
pub fn stored_map(conn: &Connection, database_id: &str, values: &Map<String, Value>) -> AppResult<Map<String, Value>> {
    let props = load_properties(conn, database_id)?;
    let mut out = Map::new();
    for (name, v) in values {
        let p = property(&props, name)?;
        if matches!(p.property_type.as_str(), "title" | "formula" | "rollup" | "created_time" | "updated_time" | "unique_id" | "button") {
            continue;
        }
        out.insert(p.id.clone(), to_stored(conn, p, v)?);
    }
    Ok(out)
}

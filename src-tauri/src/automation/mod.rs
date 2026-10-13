//! Local automation: triggers, conditions and actions that run in Rust, on this computer.
//!
//! An automation belongs to one database. A button is an automation whose trigger is a Button
//! property, so buttons and automations share one action engine. Every run is one transaction:
//! if an action fails, nothing it did is kept and the failure is logged. A change an action makes
//! can trigger other automations; each step carries an execution id and a depth, an automation
//! already in the chain never runs again, and chains stop at [`MAX_DEPTH`].

pub mod engine;
pub mod schedule;
#[cfg(test)]
mod tests;

use crate::databases::service::{load_database, load_properties};
use crate::databases::{query, values, FilterNode, Property, ViewConfig};
use crate::domain::{new_id, now, validate_id};
use crate::errors::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MAX_DEPTH: u32 = 3;
pub const MAX_AUTOMATIONS: i64 = 30;
pub const MAX_ACTIONS: usize = 10;
pub const KEEP_RUNS: i64 = 100;

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Trigger {
    RecordCreated,
    RecordUpdated,
    /// Fires when one property changes; with `to`, only when it changes to that value.
    PropertyChanged {
        property_id: String,
        #[serde(default)]
        to: Option<Value>,
    },
    /// Fires once per record when a date property (plus an offset in days) is reached.
    DateReached {
        property_id: String,
        #[serde(default)]
        offset_days: i64,
        #[serde(default = "nine")]
        time: String,
    },
    /// "minutes" and "hours" repeat every `interval`; "daily" and "weekly" run at `time`
    /// (weekly on `days`, 0 = Monday).
    Schedule {
        every: String,
        #[serde(default = "one")]
        interval: u32,
        #[serde(default = "nine")]
        time: String,
        #[serde(default)]
        days: Vec<u32>,
    },
    AppStarted,
    Button {
        property_id: String,
    },
}

fn nine() -> String {
    "09:00".into()
}

fn one() -> u32 {
    1
}

impl Trigger {
    /// Whether the trigger has a record to act on.
    pub fn has_record(&self) -> bool {
        !matches!(self, Trigger::Schedule { .. } | Trigger::AppStarted)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    /// Sets properties on the triggering record. Strings may contain `{{title}}`, `{{today}}`
    /// and `{{now}}`.
    UpdateProperties {
        values: Map<String, Value>,
    },
    SetStatus {
        property_id: String,
        option_id: String,
    },
    CreateRecord {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        values: Map<String, Value>,
        #[serde(default)]
        template_id: Option<String>,
    },
    DuplicateRecord,
    ArchiveRecord,
    TrashRecord,
    Notify {
        title: String,
        #[serde(default)]
        body: Option<String>,
    },
}

impl Action {
    fn needs_record(&self) -> bool {
        !matches!(self, Action::CreateRecord { .. } | Action::Notify { .. })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub database_id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: Trigger,
    pub conditions: Option<FilterNode>,
    pub actions: Vec<Action>,
    pub last_run_at: Option<String>,
    pub last_status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSave {
    /// Absent to create.
    #[serde(default)]
    pub id: Option<String>,
    pub database_id: String,
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub trigger: Trigger,
    #[serde(default)]
    pub conditions: Option<FilterNode>,
    pub actions: Vec<Action>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub automation_id: String,
    pub automation_name: String,
    pub execution_id: String,
    pub depth: i64,
    /// "ok", "failed" or "skipped".
    pub status: String,
    pub message: String,
    pub record_title: Option<String>,
    pub started_at: String,
}

/// Local time as a sortable naive ISO string; schedules are in the user's own clock.
pub fn local_stamp(t: chrono::NaiveDateTime) -> String {
    t.format("%Y-%m-%dT%H:%M:%S").to_string()
}

pub fn parse_local(s: &str) -> Option<chrono::NaiveDateTime> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").ok()
}

pub fn parse_time(s: &str) -> Option<chrono::NaiveTime> {
    chrono::NaiveTime::parse_from_str(s, "%H:%M").ok()
}

fn has_token(v: &Value) -> bool {
    match v {
        Value::String(s) => s.contains("{{"),
        Value::Array(a) => a.iter().any(has_token),
        Value::Object(o) => o.values().any(has_token),
        _ => false,
    }
}

fn find<'a>(props: &'a [Property], id: &str) -> AppResult<&'a Property> {
    props.iter().find(|p| p.id == id).ok_or_else(|| {
        AppError::Validation("an automation uses a property that does not exist".into())
    })
}

fn check_values(props: &[Property], map: &Map<String, Value>) -> AppResult<()> {
    for (pid, v) in map {
        let p = find(props, pid)?;
        if p.property_type == "title" {
            return bad("set a record's title with the title field, not as a property");
        }
        // Values with tokens are checked when they are filled in at run time.
        if !has_token(v) {
            values::normalize_value(p, v)?;
        }
    }
    Ok(())
}

/// Checks a whole automation against its database.
pub fn validate(conn: &Connection, db_id: &str, a: &AutomationSave) -> AppResult<()> {
    let name = a.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return bad("automation names must be 1-80 characters");
    }
    if a.actions.is_empty() || a.actions.len() > MAX_ACTIONS {
        return bad(format!("an automation needs 1 to {MAX_ACTIONS} actions"));
    }
    let props = load_properties(conn, db_id)?;
    match &a.trigger {
        Trigger::PropertyChanged { property_id, .. } => {
            let p = find(&props, property_id)?;
            if values::is_computed(&p.property_type) && p.property_type != "formula" {
                return bad("choose a property that people can change");
            }
        }
        Trigger::DateReached {
            property_id, time, ..
        } => {
            if find(&props, property_id)?.property_type != "date" {
                return bad("a date trigger needs a date property");
            }
            if parse_time(time).is_none() {
                return bad("the time must look like 09:30");
            }
        }
        Trigger::Button { property_id } => {
            if find(&props, property_id)?.property_type != "button" {
                return bad("choose a button property");
            }
        }
        Trigger::Schedule {
            every,
            interval,
            time,
            days,
        } => match every.as_str() {
            "minutes" if (1..=1440).contains(interval) => {}
            "hours" if (1..=168).contains(interval) => {}
            "daily" | "weekly" => {
                if parse_time(time).is_none() {
                    return bad("the time must look like 09:30");
                }
                if every == "weekly" && (days.is_empty() || days.iter().any(|d| *d > 6)) {
                    return bad("choose at least one day of the week");
                }
            }
            _ => return bad("that schedule is not valid"),
        },
        _ => {}
    }
    for (i, action) in a.actions.iter().enumerate() {
        if !a.trigger.has_record() && action.needs_record() {
            return bad("a schedule or app start has no record, so it can only create records and show notifications");
        }
        match action {
            Action::UpdateProperties { values } => {
                if values.is_empty() {
                    return bad("choose at least one property to change");
                }
                check_values(&props, values)?;
            }
            Action::SetStatus {
                property_id,
                option_id,
            } => {
                let p = find(&props, property_id)?;
                if !matches!(p.property_type.as_str(), "status" | "select")
                    || !values::option_ids(p).contains(option_id)
                {
                    return bad("choose a status or select option");
                }
            }
            Action::CreateRecord {
                title,
                values,
                template_id,
            } => {
                check_values(&props, values)?;
                if title.as_deref().is_some_and(|t| t.chars().count() > 500) {
                    return bad("the title is too long");
                }
                if let Some(t) = template_id {
                    crate::databases::record_templates::load(conn, t, db_id)?;
                }
            }
            Action::ArchiveRecord | Action::TrashRecord if i + 1 != a.actions.len() => {
                return bad("archiving or trashing the record must be the last action");
            }
            Action::Notify { title, body } => {
                if title.trim().is_empty() || title.chars().count() > 100 {
                    return bad("a notification title must be 1-100 characters");
                }
                if body.as_deref().is_some_and(|b| b.chars().count() > 300) {
                    return bad("a notification message can be at most 300 characters");
                }
            }
            _ => {}
        }
    }
    if let Some(f) = &a.conditions {
        if !a.trigger.has_record() {
            return bad("conditions need a record to check");
        }
        let cfg = ViewConfig {
            filter: Some(f.clone()),
            ..Default::default()
        };
        query::build(db_id, &props, &cfg, chrono::Local::now().date_naive(), &[])?;
    }
    Ok(())
}

const COLS: &str = "id, database_id, name, enabled, trigger_json, conditions_json, actions_json, last_run_at, last_status";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Automation> {
    let trig: String = r.get(4)?;
    let cond: Option<String> = r.get(5)?;
    let actions: String = r.get(6)?;
    Ok(Automation {
        id: r.get(0)?,
        database_id: r.get(1)?,
        name: r.get(2)?,
        enabled: r.get::<_, i64>(3)? != 0,
        // A definition this version cannot read (written by a newer one) is shown as disabled
        // and does nothing rather than failing the whole list.
        trigger: serde_json::from_str(&trig).unwrap_or(Trigger::AppStarted),
        conditions: cond.and_then(|c| serde_json::from_str(&c).ok()),
        actions: serde_json::from_str(&actions).unwrap_or_default(),
        last_run_at: r.get(7)?,
        last_status: r.get(8)?,
    })
}

pub fn list(conn: &Connection, database_id: &str) -> AppResult<Vec<Automation>> {
    validate_id(database_id, "database")?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM automation WHERE database_id = ?1 ORDER BY position, created_at, id"
    ))?;
    let rows = stmt.query_map([database_id], row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Automation> {
    validate_id(id, "automation")?;
    conn.query_row(
        &format!("SELECT {COLS} FROM automation WHERE id = ?1"),
        [id],
        row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("automation".into()))
}

pub fn save(conn: &mut Connection, input: AutomationSave) -> AppResult<Automation> {
    let tx = conn.transaction()?;
    let out = save_in(&tx, input)?;
    tx.commit()?;
    Ok(out)
}

pub(crate) fn save_in(tx: &Connection, input: AutomationSave) -> AppResult<Automation> {
    validate_id(&input.database_id, "database")?;
    let db = load_database(tx, &input.database_id)?;
    validate(tx, &db.id, &input)?;
    let stamp = now();
    let local = local_stamp(chrono::Local::now().naive_local());
    let trigger =
        serde_json::to_string(&input.trigger).map_err(|e| AppError::Internal(e.to_string()))?;
    let conditions = input
        .conditions
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let actions =
        serde_json::to_string(&input.actions).map_err(|e| AppError::Internal(e.to_string()))?;
    let name = input.name.trim().to_string();
    let id = match &input.id {
        Some(id) => {
            validate_id(id, "automation")?;
            if get(tx, id)?.database_id != db.id {
                return bad("that automation belongs to another database");
            }
            tx.execute(
                "UPDATE automation SET name = ?2, enabled = ?3, trigger_json = ?4, conditions_json = ?5, actions_json = ?6,
                    armed_at = ?7, fired_at = ?7, updated_at = ?8 WHERE id = ?1",
                params![id, name, input.enabled as i64, trigger, conditions, actions, local, stamp],
            )?;
            tx.execute(
                "DELETE FROM automation_fired WHERE automation_id = ?1",
                [id],
            )?;
            id.clone()
        }
        None => {
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM automation WHERE database_id = ?1",
                [&db.id],
                |r| r.get(0),
            )?;
            if count >= MAX_AUTOMATIONS {
                return bad(format!(
                    "a database can have at most {MAX_AUTOMATIONS} automations"
                ));
            }
            let id = new_id();
            tx.execute(
                "INSERT INTO automation (id, database_id, name, enabled, trigger_json, conditions_json, actions_json, position, armed_at, fired_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?10)",
                params![id, db.id, name, input.enabled as i64, trigger, conditions, actions, count as f64, local, stamp],
            )?;
            id
        }
    };
    get(tx, &id)
}

pub fn set_enabled(conn: &mut Connection, id: &str, enabled: bool) -> AppResult<Automation> {
    validate_id(id, "automation")?;
    let local = local_stamp(chrono::Local::now().naive_local());
    let n = conn.execute(
        "UPDATE automation SET enabled = ?2, armed_at = ?3, fired_at = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, enabled as i64, local, now()],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("automation".into()));
    }
    get(conn, id)
}

pub fn delete(conn: &mut Connection, id: &str) -> AppResult<()> {
    validate_id(id, "automation")?;
    if conn.execute("DELETE FROM automation WHERE id = ?1", [id])? == 0 {
        return Err(AppError::NotFound("automation".into()));
    }
    Ok(())
}

pub fn runs(conn: &Connection, database_id: &str) -> AppResult<Vec<Run>> {
    validate_id(database_id, "database")?;
    let mut stmt = conn.prepare(
        "SELECT r.id, r.automation_id, a.name, r.execution_id, r.depth, r.status, r.message, r.record_title, r.started_at
         FROM automation_run r JOIN automation a ON a.id = r.automation_id
         WHERE r.database_id = ?1 ORDER BY r.started_at DESC, r.rowid DESC LIMIT 100",
    )?;
    let rows = stmt.query_map([database_id], |r| {
        Ok(Run {
            id: r.get(0)?,
            automation_id: r.get(1)?,
            automation_name: r.get(2)?,
            execution_id: r.get(3)?,
            depth: r.get(4)?,
            status: r.get(5)?,
            message: r.get(6)?,
            record_title: r.get(7)?,
            started_at: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

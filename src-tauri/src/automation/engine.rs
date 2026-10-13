//! The action engine: finds the automations an event triggers, checks their conditions and runs
//! their actions, one transaction per run.

use super::{Action, Automation, Trigger, KEEP_RUNS, MAX_DEPTH};
use crate::databases::service::{self as dbs, load_properties, load_rows};
use crate::databases::{calc, query, Property, RecordCreate, RecordRow, SetValue, ViewConfig};
use crate::domain::{new_id, now};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;

/// More runs than this from one event is a runaway; the rest are skipped.
const RUN_BUDGET: usize = 200;

#[derive(Debug, Clone)]
pub struct Notification {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone)]
pub enum Event {
    RecordCreated {
        record_id: String,
    },
    RecordUpdated {
        record_id: String,
    },
    PropertyChanged {
        record_id: String,
        property_id: String,
        new: Option<Value>,
    },
    Button {
        record_id: String,
        property_id: String,
    },
    AppStarted,
    Schedule {
        automation_id: String,
    },
    DateReached {
        automation_id: String,
        record_id: String,
    },
}

impl Event {
    fn record_id(&self) -> Option<&str> {
        match self {
            Event::RecordCreated { record_id }
            | Event::RecordUpdated { record_id }
            | Event::PropertyChanged { record_id, .. }
            | Event::Button { record_id, .. }
            | Event::DateReached { record_id, .. } => Some(record_id),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
struct Origin {
    execution_id: String,
    depth: u32,
    /// Automations that already ran on the way to this event.
    chain: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub automation_id: String,
    pub automation_name: String,
    /// "ok", "failed" or "skipped".
    pub status: String,
    pub message: String,
}

#[derive(Default)]
struct Outcome {
    followups: Vec<Event>,
    notifications: Vec<Notification>,
    notes: Vec<String>,
}

/// The events a change to one value produces (nothing when the value did not change).
pub fn change_events(old: Option<&Value>, row: &RecordRow, property_id: &str) -> Vec<Event> {
    let new = row.values.get(property_id);
    if old == new {
        return vec![];
    }
    vec![
        Event::PropertyChanged {
            record_id: row.id.clone(),
            property_id: property_id.into(),
            new: new.cloned(),
        },
        Event::RecordUpdated {
            record_id: row.id.clone(),
        },
    ]
}

fn record_info(conn: &Connection, record_id: &str) -> AppResult<Option<(String, String, String)>> {
    Ok(conn
        .query_row(
            "SELECT r.database_id, r.page_id, p.title FROM db_record r JOIN page p ON p.id = r.page_id
             WHERE r.id = ?1 AND p.deleted_at IS NULL",
            [record_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?)
}

fn matches(a: &Automation, ev: &Event) -> bool {
    match (&a.trigger, ev) {
        (Trigger::RecordCreated, Event::RecordCreated { .. })
        | (Trigger::RecordUpdated, Event::RecordUpdated { .. })
        | (Trigger::AppStarted, Event::AppStarted) => true,
        (
            Trigger::PropertyChanged { property_id, to },
            Event::PropertyChanged {
                property_id: changed,
                new,
                ..
            },
        ) => property_id == changed && to.as_ref().is_none_or(|t| new.as_ref() == Some(t)),
        (
            Trigger::Button { property_id },
            Event::Button {
                property_id: pressed,
                ..
            },
        ) => property_id == pressed,
        (Trigger::Schedule { .. }, Event::Schedule { automation_id })
        | (Trigger::DateReached { .. }, Event::DateReached { automation_id, .. }) => {
            *automation_id == a.id
        }
        _ => false,
    }
}

fn candidates(conn: &Connection, ev: &Event) -> AppResult<Vec<Automation>> {
    let all: Vec<Automation> = match ev {
        Event::AppStarted => {
            let mut stmt = conn
                .prepare("SELECT id FROM automation WHERE enabled = 1 ORDER BY created_at, id")?;
            let ids: Vec<String> = stmt
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            ids.iter()
                .map(|i| super::get(conn, i))
                .collect::<AppResult<_>>()?
        }
        Event::Schedule { automation_id } | Event::DateReached { automation_id, .. } => {
            vec![super::get(conn, automation_id)?]
        }
        _ => {
            let Some((db, _, _)) = record_info(conn, ev.record_id().unwrap_or_default())? else {
                return Ok(vec![]);
            };
            super::list(conn, &db)?
        }
    };
    Ok(all
        .into_iter()
        .filter(|a| a.enabled && matches(a, ev))
        .collect())
}

/// Replaces `{{title}}`, `{{today}}` and `{{now}}` in every string.
fn expand(v: &Value, title: &str) -> Value {
    match v {
        Value::String(s) if s.contains("{{") => {
            let local = chrono::Local::now();
            Value::String(
                s.replace("{{title}}", title)
                    .replace("{{today}}", &local.format("%Y-%m-%d").to_string())
                    .replace("{{now}}", &local.format("%Y-%m-%d %H:%M").to_string()),
            )
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| expand(x, title)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), expand(x, title)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn conditions_hold(
    conn: &Connection,
    a: &Automation,
    props: &[Property],
    record_id: &str,
) -> AppResult<bool> {
    let Some(filter) = &a.conditions else {
        return Ok(true);
    };
    let cfg = ViewConfig {
        filter: Some(filter.clone()),
        ..Default::default()
    };
    calc::prepare(conn, &a.database_id, &calc::used_by(props, &cfg))?;
    let mut built = query::build(
        &a.database_id,
        props,
        &cfg,
        chrono::Local::now().date_naive(),
        &[],
    )?;
    built
        .params
        .push(rusqlite::types::Value::Text(record_id.into()));
    let n = built.params.len();
    let sql = format!(
        "SELECT 1 FROM db_record r JOIN page p ON p.id = r.page_id
         WHERE r.database_id = ?1 AND p.deleted_at IS NULL AND r.id = ?{n} AND {}",
        built.where_sql
    );
    Ok(conn
        .query_row(
            &sql,
            rusqlite::params_from_iter(built.params.iter()),
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn set_one(
    tx: &Connection,
    record_id: &str,
    property_id: &str,
    value: Value,
    out: &mut Outcome,
    changed: &mut Vec<String>,
    props: &[Property],
) -> AppResult<()> {
    let old = load_rows(tx, &[record_id.to_string()])?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound("record".into()))?;
    let new = dbs::set_value_in(
        tx,
        SetValue {
            record_id: record_id.into(),
            property_id: property_id.into(),
            value,
        },
    )?;
    let evs = change_events(old.values.get(property_id), &new, property_id);
    if let Some(first) = evs.into_iter().next() {
        out.followups.push(first);
        changed.push(
            props
                .iter()
                .find(|p| p.id == property_id)
                .map_or_else(|| "a property".into(), |p| p.name.clone()),
        );
    }
    Ok(())
}

fn run_actions(
    tx: &Connection,
    a: &Automation,
    props: &[Property],
    record: Option<(&str, &str, &str)>,
) -> AppResult<Outcome> {
    let mut out = Outcome::default();
    let title = record.map_or("", |r| r.2);
    let need = || record.ok_or_else(|| AppError::Validation("this action needs a record".into()));
    for action in &a.actions {
        match action {
            Action::UpdateProperties { values } => {
                let (rid, _, _) = need()?;
                let mut changed = Vec::new();
                for (pid, v) in values {
                    set_one(
                        tx,
                        rid,
                        pid,
                        expand(v, title),
                        &mut out,
                        &mut changed,
                        props,
                    )?;
                }
                if !changed.is_empty() {
                    out.followups.push(Event::RecordUpdated {
                        record_id: rid.into(),
                    });
                    out.notes.push(format!("Changed {}", changed.join(", ")));
                }
            }
            Action::SetStatus {
                property_id,
                option_id,
            } => {
                let (rid, _, _) = need()?;
                let mut changed = Vec::new();
                set_one(
                    tx,
                    rid,
                    property_id,
                    json!(option_id),
                    &mut out,
                    &mut changed,
                    props,
                )?;
                if !changed.is_empty() {
                    out.followups.push(Event::RecordUpdated {
                        record_id: rid.into(),
                    });
                    out.notes.push(format!("Changed {}", changed.join(", ")));
                }
            }
            Action::CreateRecord {
                title: t,
                values,
                template_id,
            } => {
                let row = dbs::create_record_in(
                    tx,
                    RecordCreate {
                        database_id: a.database_id.clone(),
                        title: t.as_ref().map(|t| {
                            expand(&Value::String(t.clone()), title)
                                .as_str()
                                .unwrap_or_default()
                                .to_string()
                        }),
                        values: values
                            .iter()
                            .map(|(k, v)| (k.clone(), expand(v, title)))
                            .collect(),
                        template_id: template_id.clone(),
                    },
                )?;
                out.notes.push(format!("Created “{}”", row.title));
                out.followups
                    .push(Event::RecordCreated { record_id: row.id });
            }
            Action::DuplicateRecord => {
                let (rid, _, _) = need()?;
                let row = dbs::duplicate_record_in(tx, rid)?;
                out.notes.push(format!("Duplicated into “{}”", row.title));
                out.followups
                    .push(Event::RecordCreated { record_id: row.id });
            }
            Action::ArchiveRecord => {
                let (_, page_id, _) = need()?;
                let mut page = repo::page::get(tx, page_id)?
                    .ok_or_else(|| AppError::NotFound("record".into()))?;
                page.archived = true;
                page.updated_at = now();
                repo::page::update(tx, &page)?;
                out.notes.push("Archived the record".into());
            }
            Action::TrashRecord => {
                let (_, page_id, _) = need()?;
                repo::page::soft_delete_tree(tx, page_id, &now())?;
                out.notes.push("Moved the record to the trash".into());
            }
            Action::Notify { title: t, body } => {
                let t = expand(&Value::String(t.clone()), title);
                let b = expand(&Value::String(body.clone().unwrap_or_default()), title);
                out.notes.push("Showed a notification".into());
                out.notifications.push(Notification {
                    title: t.as_str().unwrap_or_default().to_string(),
                    body: b.as_str().unwrap_or_default().to_string(),
                });
            }
        }
    }
    Ok(out)
}

fn log_run(
    conn: &Connection,
    a: &Automation,
    origin: &Origin,
    status: &str,
    message: &str,
    record_title: Option<&str>,
) -> AppResult<()> {
    let stamp = now();
    conn.execute(
        "INSERT INTO automation_run (id, automation_id, database_id, execution_id, depth, status, message, record_title, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![new_id(), a.id, a.database_id, origin.execution_id, origin.depth, status, message, record_title, stamp],
    )?;
    if status != "skipped" {
        conn.execute(
            "UPDATE automation SET last_run_at = ?2, last_status = ?3 WHERE id = ?1",
            params![a.id, stamp, status],
        )?;
    }
    conn.execute(
        "DELETE FROM automation_run WHERE database_id = ?1 AND id NOT IN
         (SELECT id FROM automation_run WHERE database_id = ?1 ORDER BY started_at DESC, rowid DESC LIMIT ?2)",
        params![a.database_id, KEEP_RUNS],
    )?;
    Ok(())
}

struct Ran {
    summary: Option<RunSummary>,
    outcome: Outcome,
}

/// One run of one automation. `None` summary: the conditions were not met (not logged).
fn run_one(
    conn: &mut Connection,
    a: &Automation,
    ev: &Event,
    origin: &Origin,
    manual: bool,
) -> AppResult<Ran> {
    let summarize = |status: &str, message: String| RunSummary {
        automation_id: a.id.clone(),
        automation_name: a.name.clone(),
        status: status.into(),
        message,
    };
    let info = match ev.record_id() {
        Some(rid) => match record_info(conn, rid)? {
            Some(i) => Some((rid.to_string(), i)),
            None => {
                return Ok(Ran {
                    summary: Some(summarize("skipped", "the record no longer exists".into())),
                    outcome: Outcome::default(),
                })
            }
        },
        None => None,
    };
    let record_title = info.as_ref().map(|(_, i)| i.2.clone());
    let tx = conn.transaction()?;
    let attempt = (|| -> AppResult<Option<Outcome>> {
        let props = load_properties(&tx, &a.database_id)?;
        if let Some((rid, _)) = &info {
            if !conditions_hold(&tx, a, &props, rid)? {
                return Ok(None);
            }
        }
        let rec = info
            .as_ref()
            .map(|(rid, i)| (rid.as_str(), i.1.as_str(), i.2.as_str()));
        run_actions(&tx, a, &props, rec).map(Some)
    })();
    match attempt {
        Ok(Some(outcome)) => {
            let msg = if outcome.notes.is_empty() {
                "Nothing needed changing".to_string()
            } else {
                outcome.notes.join("; ")
            };
            log_run(&tx, a, origin, "ok", &msg, record_title.as_deref())?;
            tx.commit()?;
            Ok(Ran {
                summary: Some(summarize("ok", msg)),
                outcome,
            })
        }
        Ok(None) => {
            drop(tx);
            let summary = if manual {
                let msg = "the conditions are not met for this record".to_string();
                log_run(conn, a, origin, "skipped", &msg, record_title.as_deref())?;
                Some(summarize("skipped", msg))
            } else {
                None
            };
            Ok(Ran {
                summary,
                outcome: Outcome::default(),
            })
        }
        Err(e) => {
            drop(tx); // everything this run did is undone
            let msg = e.to_string();
            log_run(conn, a, origin, "failed", &msg, record_title.as_deref())?;
            Ok(Ran {
                summary: Some(summarize("failed", msg)),
                outcome: Outcome::default(),
            })
        }
    }
}

/// Runs everything an event triggers, then everything those runs trigger in turn.
pub fn dispatch(
    conn: &mut Connection,
    event: Event,
    sink: &mut dyn FnMut(Notification),
) -> AppResult<Vec<RunSummary>> {
    dispatch_all(conn, vec![event], sink)
}

pub fn dispatch_all(
    conn: &mut Connection,
    events: Vec<Event>,
    sink: &mut dyn FnMut(Notification),
) -> AppResult<Vec<RunSummary>> {
    let mut summaries = Vec::new();
    let mut budget = RUN_BUDGET;
    let execution_id = new_id();
    let mut queue: VecDeque<(Event, Origin)> = events
        .into_iter()
        .map(|e| {
            (
                e,
                Origin {
                    execution_id: execution_id.clone(),
                    depth: 0,
                    chain: vec![],
                },
            )
        })
        .collect();
    while let Some((ev, origin)) = queue.pop_front() {
        for a in candidates(conn, &ev)? {
            let record_title = ev
                .record_id()
                .and_then(|r| record_info(conn, r).ok().flatten())
                .map(|i| i.2);
            let block = if origin.chain.contains(&a.id) {
                Some("it already ran earlier in this chain, so it was not run again".to_string())
            } else if origin.depth >= MAX_DEPTH {
                Some(format!(
                    "the chain of automations reached its limit of {MAX_DEPTH}"
                ))
            } else if budget == 0 {
                Some("too many automations ran from one change".to_string())
            } else {
                None
            };
            if let Some(why) = block {
                log_run(conn, &a, &origin, "skipped", &why, record_title.as_deref())?;
                summaries.push(RunSummary {
                    automation_id: a.id.clone(),
                    automation_name: a.name.clone(),
                    status: "skipped".into(),
                    message: why,
                });
                continue;
            }
            budget -= 1;
            let ran = run_one(conn, &a, &ev, &origin, false)?;
            summaries.extend(ran.summary);
            for n in ran.outcome.notifications {
                sink(n);
            }
            let mut chain = origin.chain.clone();
            chain.push(a.id.clone());
            for f in ran.outcome.followups {
                queue.push_back((
                    f,
                    Origin {
                        execution_id: origin.execution_id.clone(),
                        depth: origin.depth + 1,
                        chain: chain.clone(),
                    },
                ));
            }
        }
    }
    Ok(summaries)
}

/// A button was pressed on a record.
pub fn press_button(
    conn: &mut Connection,
    record_id: &str,
    property_id: &str,
    sink: &mut dyn FnMut(Notification),
) -> AppResult<Vec<RunSummary>> {
    crate::domain::validate_id(record_id, "record")?;
    crate::domain::validate_id(property_id, "property")?;
    let (db, _, _) =
        record_info(conn, record_id)?.ok_or_else(|| AppError::NotFound("record".into()))?;
    let props = load_properties(conn, &db)?;
    if !props
        .iter()
        .any(|p| p.id == property_id && p.property_type == "button")
    {
        return Err(AppError::Validation(
            "that is not a button of this database".into(),
        ));
    }
    let wired = super::list(conn, &db)?.into_iter().any(|a| {
        a.enabled && matches!(&a.trigger, Trigger::Button { property_id: p } if p == property_id)
    });
    if !wired {
        return Err(AppError::Validation(
            "this button does not do anything yet: add an automation with a Button trigger".into(),
        ));
    }
    dispatch(
        conn,
        Event::Button {
            record_id: record_id.into(),
            property_id: property_id.into(),
        },
        sink,
    )
}

/// Runs one automation now, ignoring its trigger but not its conditions. For testing it.
pub fn run_now(
    conn: &mut Connection,
    automation_id: &str,
    record_id: Option<&str>,
    sink: &mut dyn FnMut(Notification),
) -> AppResult<RunSummary> {
    let a = super::get(conn, automation_id)?;
    let ev = if a.trigger.has_record() {
        let rid = match record_id {
            Some(r) => r.to_string(),
            None => conn
                .query_row(
                    "SELECT r.id FROM db_record r JOIN page p ON p.id = r.page_id
                     WHERE r.database_id = ?1 AND p.deleted_at IS NULL ORDER BY r.unique_id LIMIT 1",
                    [&a.database_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| AppError::Validation("add a record to test this automation on".into()))?,
        };
        Event::RecordUpdated { record_id: rid }
    } else {
        Event::AppStarted
    };
    let origin = Origin {
        execution_id: new_id(),
        depth: 0,
        chain: vec![],
    };
    let ran = run_one(conn, &a, &ev, &origin, true)?;
    for n in ran.outcome.notifications {
        sink(n);
    }
    // Changes a manual run makes can trigger other automations, like any other change.
    let follow: Vec<Event> = ran.outcome.followups;
    if !follow.is_empty() {
        let mut chain = vec![a.id.clone()];
        chain.dedup();
        let mut queue: VecDeque<(Event, Origin)> = follow
            .into_iter()
            .map(|e| {
                (
                    e,
                    Origin {
                        execution_id: origin.execution_id.clone(),
                        depth: 1,
                        chain: chain.clone(),
                    },
                )
            })
            .collect();
        while let Some((ev, o)) = queue.pop_front() {
            for b in candidates(conn, &ev)? {
                if o.chain.contains(&b.id) || o.depth >= MAX_DEPTH {
                    log_run(conn, &b, &o, "skipped", "the chain stopped here", None)?;
                    continue;
                }
                let r = run_one(conn, &b, &ev, &o, false)?;
                for n in r.outcome.notifications {
                    sink(n);
                }
                let mut c = o.chain.clone();
                c.push(b.id.clone());
                for f in r.outcome.followups {
                    queue.push_back((
                        f,
                        Origin {
                            execution_id: o.execution_id.clone(),
                            depth: o.depth + 1,
                            chain: c.clone(),
                        },
                    ));
                }
            }
        }
    }
    Ok(ran.summary.unwrap_or(RunSummary {
        automation_id: a.id.clone(),
        automation_name: a.name.clone(),
        status: "skipped".into(),
        message: "nothing to do".into(),
    }))
}

//! Schedules and date triggers. There is no background service: a ticker runs while the app is
//! open, and on start it catches up by running each missed schedule once (not once per missed
//! slot). Nothing runs retroactively for the time before an automation was saved or switched on.

use super::engine::{dispatch, Event, Notification};
use super::{local_stamp, parse_local, parse_time, Trigger};
use crate::errors::AppResult;
use chrono::{Datelike, Duration, NaiveDateTime};
use rusqlite::{params, Connection};

/// At most this many date-trigger runs are started by one tick.
const DATE_BATCH: usize = 200;

/// The schedule slot that is due: the moment to record as handled, if one has passed since
/// `fired_at`.
pub fn due_slot(
    trigger: &Trigger,
    fired_at: NaiveDateTime,
    now: NaiveDateTime,
) -> Option<NaiveDateTime> {
    let Trigger::Schedule {
        every,
        interval,
        time,
        days,
    } = trigger
    else {
        return None;
    };
    match every.as_str() {
        "minutes" | "hours" => {
            let step = if every == "minutes" {
                Duration::minutes(i64::from(*interval))
            } else {
                Duration::hours(i64::from(*interval))
            };
            (now >= fired_at + step).then_some(now)
        }
        "daily" | "weekly" => {
            let at = parse_time(time)?;
            (0..=7)
                .map(|back| now.date() - Duration::days(back))
                .filter(|d| every == "daily" || days.contains(&d.weekday().num_days_from_monday()))
                .map(|d| d.and_time(at))
                .find(|slot| *slot <= now)
                .filter(|slot| *slot > fired_at)
        }
        _ => None,
    }
}

/// When a date trigger is due for a record whose date property starts on `day`.
pub fn date_fire_time(day: &str, offset_days: i64, time: &str) -> Option<NaiveDateTime> {
    let d = chrono::NaiveDate::parse_from_str(day.get(..10)?, "%Y-%m-%d").ok()?;
    Some((d + Duration::days(offset_days)).and_time(parse_time(time)?))
}

/// Starts every schedule and date trigger that is due at `now` (local time).
pub fn tick(
    conn: &mut Connection,
    now: NaiveDateTime,
    sink: &mut dyn FnMut(Notification),
) -> AppResult<usize> {
    let mut started = 0;
    let mut stmt = conn
        .prepare("SELECT id, trigger_json, armed_at, fired_at FROM automation WHERE enabled = 1")?;
    let rows: Vec<(String, String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    for (id, trigger_json, armed, fired) in rows {
        let Ok(trigger) = serde_json::from_str::<Trigger>(&trigger_json) else {
            continue;
        };
        match &trigger {
            Trigger::Schedule { .. } => {
                let Some(fired_at) = parse_local(&fired) else {
                    continue;
                };
                if let Some(slot) = due_slot(&trigger, fired_at, now) {
                    // Recorded first, so a failing run is not retried every tick.
                    conn.execute(
                        "UPDATE automation SET fired_at = ?2 WHERE id = ?1",
                        params![id, local_stamp(slot)],
                    )?;
                    dispatch(conn, Event::Schedule { automation_id: id }, sink)?;
                    started += 1;
                }
            }
            Trigger::DateReached {
                property_id,
                offset_days,
                time,
            } => {
                let Some(armed_at) = parse_local(&armed) else {
                    continue;
                };
                let mut stmt = conn.prepare(
                    "SELECT r.id, json_extract(v.value_json, '$.start') FROM db_record r
                     JOIN page p ON p.id = r.page_id
                     JOIN db_value v ON v.record_id = r.id AND v.property_id = ?2
                     WHERE r.database_id = (SELECT database_id FROM automation WHERE id = ?1) AND p.deleted_at IS NULL",
                )?;
                let records: Vec<(String, Option<String>)> = stmt
                    .query_map(params![id, property_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<_, _>>()?;
                drop(stmt);
                for (record_id, start) in records {
                    let Some(fire) = start.and_then(|s| date_fire_time(&s, *offset_days, time))
                    else {
                        continue;
                    };
                    if fire <= armed_at || fire > now || started >= DATE_BATCH {
                        continue;
                    }
                    let fresh = conn.execute(
                        "INSERT OR IGNORE INTO automation_fired (automation_id, record_id, fire_key) VALUES (?1, ?2, ?3)",
                        params![id, record_id, local_stamp(fire)],
                    )?;
                    if fresh == 1 {
                        dispatch(
                            conn,
                            Event::DateReached {
                                automation_id: id.clone(),
                                record_id,
                            },
                            sink,
                        )?;
                        started += 1;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(started)
}

/// What happens when the app starts: automations triggered by it run, then anything missed
/// while the app was closed is caught up once.
pub fn on_start(
    conn: &mut Connection,
    now: NaiveDateTime,
    sink: &mut dyn FnMut(Notification),
) -> AppResult<usize> {
    let summaries = dispatch(conn, Event::AppStarted, sink)?;
    Ok(summaries.len() + tick(conn, now, sink)?)
}

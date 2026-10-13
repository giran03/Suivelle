//! Reminders: "remind me about this page" at a local date and time. The scheduler thread that
//! runs automations also fires reminders, as a desktop notification and an in-app event.

use crate::automation::{local_stamp, parse_local};
use crate::domain::{new_id, now, validate_id};
use crate::errors::{AppError, AppResult};
use chrono::NaiveDateTime;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

const MAX_NOTE_CHARS: usize = 500;
/// Fired reminders stay in the list this long, so a missed notification can still be seen.
const KEEP_FIRED_DAYS: i64 = 7;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Reminder {
    pub id: String,
    pub page_id: String,
    pub page_title: String,
    pub remind_at: String,
    pub note: String,
    pub fired_at: Option<String>,
}

const SELECT: &str = "SELECT r.id, r.page_id, p.title, r.remind_at, r.note, r.fired_at
     FROM reminder r JOIN page p ON p.id = r.page_id";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Reminder> {
    Ok(Reminder {
        id: r.get(0)?,
        page_id: r.get(1)?,
        page_title: r.get(2)?,
        remind_at: r.get(3)?,
        note: r.get(4)?,
        fired_at: r.get(5)?,
    })
}

/// Adds a reminder for `page_id` at `remind_at` (local time, "YYYY-MM-DDTHH:MM:SS").
pub fn create(
    conn: &Connection,
    page_id: &str,
    remind_at: &str,
    note: &str,
) -> AppResult<Reminder> {
    validate_id(page_id, "page")?;
    let at = parse_local(remind_at)
        .ok_or_else(|| AppError::Validation("choose a valid date and time".into()))?;
    let note = note.trim();
    if note.chars().count() > MAX_NOTE_CHARS {
        return Err(AppError::Validation(format!(
            "keep the note under {MAX_NOTE_CHARS} characters"
        )));
    }
    let workspace: String = conn
        .query_row(
            "SELECT workspace_id FROM page WHERE id = ?1 AND deleted_at IS NULL",
            [page_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("page".into()))?;
    let id = new_id();
    conn.execute(
        "INSERT INTO reminder (id, workspace_id, page_id, remind_at, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, workspace, page_id, local_stamp(at), note, now()],
    )?;
    get(conn, &id)
}

fn get(conn: &Connection, id: &str) -> AppResult<Reminder> {
    conn.query_row(&format!("{SELECT} WHERE r.id = ?1"), [id], row)
        .optional()?
        .ok_or_else(|| AppError::NotFound("reminder".into()))
}

/// Upcoming reminders, soonest first, then the ones that fired in the last week.
pub fn list(conn: &Connection, workspace_id: &str, now: NaiveDateTime) -> AppResult<Vec<Reminder>> {
    validate_id(workspace_id, "workspace")?;
    let since = local_stamp(now - chrono::Duration::days(KEEP_FIRED_DAYS));
    let mut stmt = conn.prepare(&format!(
        "{SELECT} WHERE r.workspace_id = ?1 AND p.deleted_at IS NULL
           AND (r.fired_at IS NULL OR r.remind_at >= ?2)
         ORDER BY r.fired_at IS NOT NULL, r.remind_at"
    ))?;
    let rows = stmt.query_map(params![workspace_id, since], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    validate_id(id, "reminder")?;
    conn.execute("DELETE FROM reminder WHERE id = ?1", [id])?;
    Ok(())
}

/// Marks every reminder due at `now` as fired and returns them. Reminders on trashed pages wait
/// until the page is restored.
pub fn fire_due(conn: &Connection, now: NaiveDateTime) -> AppResult<Vec<Reminder>> {
    let stamp = local_stamp(now);
    let due: Vec<Reminder> = {
        let mut stmt = conn.prepare(&format!(
            "{SELECT} WHERE r.fired_at IS NULL AND r.remind_at <= ?1 AND p.deleted_at IS NULL ORDER BY r.remind_at"
        ))?;
        let rows = stmt.query_map([&stamp], row)?;
        rows.collect::<Result<_, _>>()?
    };
    for r in &due {
        conn.execute(
            "UPDATE reminder SET fired_at = ?2 WHERE id = ?1",
            params![r.id, stamp],
        )?;
    }
    Ok(due
        .into_iter()
        .map(|r| Reminder {
            fired_at: Some(stamp.clone()),
            ..r
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::open_in_memory;
    use crate::domain::{PageCreate, WorkspaceCreate};
    use crate::services;

    fn at(s: &str) -> NaiveDateTime {
        parse_local(s).unwrap()
    }

    #[test]
    fn reminders_fire_once_when_due_and_skip_trashed_pages() {
        let mut conn = open_in_memory().unwrap();
        let ws = services::workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "W".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let page = |conn: &mut Connection, title: &str| {
            services::page::create(
                conn,
                PageCreate {
                    workspace_id: ws.id.clone(),
                    parent_page_id: None,
                    title: Some(title.into()),
                    icon: None,
                },
            )
            .unwrap()
        };
        let plan = page(&mut conn, "Plan");
        let old = page(&mut conn, "Old");
        let r = create(
            &conn,
            &plan.id,
            "2026-10-13T09:00:00",
            "  Call the printer  ",
        )
        .unwrap();
        assert_eq!(
            (r.page_title.as_str(), r.note.as_str()),
            ("Plan", "Call the printer")
        );
        create(&conn, &old.id, "2026-10-13T08:00:00", "").unwrap();
        services::page::delete(&mut conn, &old.id).unwrap();
        assert!(create(&conn, &plan.id, "tomorrow", "").is_err());
        assert!(
            create(&conn, &old.id, "2026-10-14T08:00:00", "").is_err(),
            "no reminders on trashed pages"
        );

        assert!(fire_due(&conn, at("2026-10-13T08:59:59"))
            .unwrap()
            .is_empty());
        let fired = fire_due(&conn, at("2026-10-13T09:00:30")).unwrap();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].id, r.id);
        assert!(
            fire_due(&conn, at("2026-10-13T10:00:00"))
                .unwrap()
                .is_empty(),
            "fires once"
        );

        let listed = list(&conn, &ws.id, at("2026-10-14T00:00:00")).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].fired_at.is_some());
        assert!(
            list(&conn, &ws.id, at("2026-10-30T00:00:00"))
                .unwrap()
                .is_empty(),
            "fired ones age out"
        );
        delete(&conn, &r.id).unwrap();
        assert!(list(&conn, &ws.id, at("2026-10-14T00:00:00"))
            .unwrap()
            .is_empty());
    }
}

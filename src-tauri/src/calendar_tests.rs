use crate::{calendar::*, database::open_in_memory, domain::*, services};
use chrono::NaiveDate;
fn setup() -> (rusqlite::Connection, String, String) {
    let mut c = open_in_memory().unwrap();
    let w = services::workspace::create(
        &mut c,
        WorkspaceCreate {
            name: "Calendar tests".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let p = create_collection(&mut c, &w.id, "Personal").unwrap();
    (c, w.id, p.id)
}
fn schedule(id: &str) -> Schedule {
    serde_json::from_value(serde_json::json!({"calendarId":id,"start":"2026-10-13","end":"2026-10-14","allDay":true,"timezone":"Asia/Manila","recurrence":null,"exceptions":[],"links":[],"reminders":[],"location":"","completed":false,"busy":true})).unwrap()
}
fn write(c: &mut rusqlite::Connection, w: &str, data: Schedule) -> Event {
    save(
        c,
        Save {
            workspace_id: w.into(),
            page_id: None,
            revision: None,
            title: "Plan".into(),
            data,
            split_date: None,
        },
    )
    .unwrap()
}
fn day(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}
#[test]
fn deleting_the_calendar_view_preserves_collection_and_events() {
    let (mut c, w, id) = setup();
    write(&mut c, &w, schedule(&id));
    c.execute(
        "DELETE FROM block WHERE page_id=?1 AND type='calendar'",
        [&id],
    )
    .unwrap();
    let result = snapshot(&c, &w, "2026-10-13", "2026-10-14").unwrap();
    assert_eq!(result.collections.len(), 1);
    assert_eq!(result.events.len(), 1);
    write(&mut c, &w, schedule(&id));
}
#[test]
fn exceptions_cannot_extend_a_finished_series_and_import_keeps_notes() {
    let (mut c, w, id) = setup();
    let mut d = schedule(&id);
    d.imported_description = Some("Imported planning notes".into());
    let e = write(&mut c, &w, d.clone());
    assert!(e.notes.contains("Imported planning notes"));
    d.recurrence = Some(Repeat {
        frequency: "daily".into(),
        interval: 1,
        days: vec![],
        until: None,
        count: Some(2),
    });
    d.exceptions.push(Exception {
        date: "2026-10-15".into(),
        cancelled: false,
        start: Some("2026-10-20".into()),
        end: Some("2026-10-21".into()),
    });
    assert!(validate(&d).is_err());
}
#[test]
fn rejects_cross_workspace_calendar_writes() {
    let (mut c, w, id) = setup();
    let other = services::workspace::create(
        &mut c,
        WorkspaceCreate {
            name: "Other".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(save(
        &mut c,
        Save {
            workspace_id: other.id,
            page_id: None,
            revision: None,
            title: "Foreign".into(),
            data: schedule(&id),
            split_date: None
        }
    )
    .is_err());
    assert!(snapshot(&c, &w, "2026-10-13", "2026-10-13")
        .unwrap()
        .events
        .is_empty());
}
#[test]
fn reminders_fire_once_and_completed_sessions_stay_quiet() {
    let (mut c, w, id) = setup();
    let mut d = schedule(&id);
    d.all_day = false;
    d.timezone = "UTC".into();
    d.start = chrono::Utc::now().format("%Y-%m-%dT%H:%M").to_string();
    d.end = (chrono::Utc::now() + chrono::Duration::hours(1))
        .format("%Y-%m-%dT%H:%M")
        .to_string();
    d.reminders = vec![0];
    write(&mut c, &w, d.clone());
    assert_eq!(fire_due(&c).unwrap().len(), 1);
    assert!(fire_due(&c).unwrap().is_empty());
    d.completed = true;
    write(&mut c, &w, d);
    assert!(fire_due(&c).unwrap().is_empty());
}
#[test]
fn creates_real_pages_and_refuses_stale_edits() {
    let (mut c, w, id) = setup();
    let e = write(&mut c, &w, schedule(&id));
    assert!(crate::repositories::page::get(&c, &e.page_id)
        .unwrap()
        .is_some());
    let mut d = e.data.clone();
    d.location = "Studio".into();
    let saved = save(
        &mut c,
        Save {
            workspace_id: w.clone(),
            page_id: Some(e.page_id.clone()),
            revision: Some(e.revision),
            title: "Updated".into(),
            data: d.clone(),
            split_date: None,
        },
    )
    .unwrap();
    assert!(saved.revision > e.revision);
    assert!(save(
        &mut c,
        Save {
            workspace_id: w.clone(),
            page_id: Some(e.page_id),
            revision: Some(e.revision),
            title: "Stale".into(),
            data: d,
            split_date: None
        }
    )
    .is_err());
    assert_eq!(
        snapshot(&c, &w, "2026-10-13", "2026-10-13").unwrap().events[0].title,
        "Updated"
    );
}
#[test]
fn all_day_end_is_exclusive() {
    let (mut c, w, id) = setup();
    write(&mut c, &w, schedule(&id));
    assert_eq!(
        snapshot(&c, &w, "2026-10-13", "2026-10-13")
            .unwrap()
            .occurrences
            .len(),
        1
    );
    assert!(snapshot(&c, &w, "2026-10-14", "2026-10-14")
        .unwrap()
        .occurrences
        .is_empty());
}
#[test]
fn monthly_recurrence_skips_missing_dates() {
    let (mut c, w, id) = setup();
    let mut d = schedule(&id);
    d.start = "2026-01-31".into();
    d.end = "2026-02-01".into();
    d.recurrence = Some(Repeat {
        frequency: "monthly".into(),
        interval: 1,
        days: vec![],
        until: None,
        count: Some(3),
    });
    let e = write(&mut c, &w, d);
    let o = occurrences(&e, day("2026-01-01"), day("2026-05-31")).unwrap();
    assert_eq!(
        o.iter().map(|o| o.start.as_str()).collect::<Vec<_>>(),
        vec!["2026-01-31", "2026-03-31", "2026-05-31"]
    );
}
#[test]
fn moving_one_occurrence_keeps_identity_and_series() {
    let (mut c, w, id) = setup();
    let mut d = schedule(&id);
    d.recurrence = Some(Repeat {
        frequency: "daily".into(),
        interval: 1,
        days: vec![],
        until: None,
        count: Some(4),
    });
    d.exceptions.push(Exception {
        date: "2026-10-14".into(),
        cancelled: false,
        start: Some("2026-11-20".into()),
        end: Some("2026-11-21".into()),
    });
    let e = write(&mut c, &w, d);
    let o = occurrences(&e, day("2026-11-01"), day("2026-11-30")).unwrap();
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].original_date, "2026-10-14");
    assert_eq!(e.data.start, "2026-10-13");
}
#[test]
fn rejects_ambiguous_or_missing_local_times() {
    let (_, _, id) = setup();
    let mut d = schedule(&id);
    d.all_day = false;
    d.timezone = "America/New_York".into();
    d.start = "2026-03-08T02:30".into();
    d.end = "2026-03-08T04:00".into();
    assert!(validate(&d).is_err());
    d.start = "2026-11-01T01:30".into();
    d.end = "2026-11-01T03:00".into();
    assert!(validate(&d).is_err());
}
#[test]
fn recurring_wall_time_survives_daylight_saving() {
    let (mut c, w, id) = setup();
    let mut d = schedule(&id);
    d.all_day = false;
    d.timezone = "America/New_York".into();
    d.start = "2026-03-07T09:00".into();
    d.end = "2026-03-07T10:00".into();
    d.recurrence = Some(Repeat {
        frequency: "daily".into(),
        interval: 1,
        days: vec![],
        until: None,
        count: Some(3),
    });
    let e = write(&mut c, &w, d);
    let o = occurrences(&e, day("2026-03-07"), day("2026-03-09")).unwrap();
    assert!(o[0].start.contains("14:00"));
    assert!(o[1].start.contains("13:00"));
}
#[test]
fn calendar_import_rolls_back_the_whole_batch() {
    let (mut c, w, id) = setup();
    let first = Save {
        workspace_id: w.clone(),
        page_id: None,
        revision: None,
        title: "One".into(),
        data: schedule(&id),
        split_date: None,
    };
    let mut bad = schedule(&id);
    bad.end = "2020-01-01".into();
    assert!(import(
        &mut c,
        &w,
        vec![
            first,
            Save {
                workspace_id: w.clone(),
                page_id: None,
                revision: None,
                title: "Bad".into(),
                data: bad,
                split_date: None
            }
        ]
    )
    .is_err());
    assert!(snapshot(&c, &w, "2026-10-13", "2026-10-13")
        .unwrap()
        .events
        .is_empty());
}
#[test]
fn trashing_a_collection_hides_its_events() {
    let (mut c, w, id) = setup();
    write(&mut c, &w, schedule(&id));
    services::page::delete(&mut c, &id).unwrap();
    assert!(snapshot(&c, &w, "2026-10-13", "2026-10-13")
        .unwrap()
        .events
        .is_empty());
}
#[test]
fn split_preserves_earlier_occurrences_and_remaining_count() {
    let (mut c, w, id) = setup();
    let mut d = schedule(&id);
    d.recurrence = Some(Repeat {
        frequency: "daily".into(),
        interval: 1,
        days: vec![],
        until: None,
        count: Some(5),
    });
    let original = write(&mut c, &w, d);
    let mut future = original.data.clone();
    future.start = "2026-10-15".into();
    future.end = "2026-10-16".into();
    save(
        &mut c,
        Save {
            workspace_id: w.clone(),
            page_id: Some(original.page_id),
            revision: Some(original.revision),
            title: "Future".into(),
            data: future,
            split_date: Some("2026-10-15".into()),
        },
    )
    .unwrap();
    let snap = snapshot(&c, &w, "2026-10-13", "2026-10-20").unwrap();
    assert_eq!(snap.events.len(), 2);
    assert_eq!(snap.occurrences.len(), 5);
    assert_eq!(
        snap.events
            .iter()
            .find(|e| e.title == "Future")
            .unwrap()
            .data
            .recurrence
            .as_ref()
            .unwrap()
            .count,
        Some(3)
    );
}

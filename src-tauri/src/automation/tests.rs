use super::engine::{dispatch, press_button, run_now, Event, Notification};
use super::schedule::{date_fire_time, due_slot, on_start, tick};
use super::*;
use crate::database::open_in_memory;
use crate::databases::service::*;
use crate::databases::{
    DatabaseCreate, DatabaseDetail, PropertyCreate, RecordCreate, RecordRow, SetValue,
};
use crate::domain::*;
use crate::services;
use chrono::{Duration, NaiveDate};
use serde_json::json;

struct Fx {
    conn: Connection,
    db: DatabaseDetail,
    status: Property,
    done: Property,
    points: Property,
    due: Property,
    button: Property,
}

fn add(
    conn: &mut Connection,
    db: &DatabaseDetail,
    name: &str,
    ty: &str,
    config: Option<Value>,
) -> Property {
    add_property(
        conn,
        PropertyCreate {
            database_id: db.database.id.clone(),
            name: name.into(),
            property_type: ty.into(),
            config,
        },
    )
    .unwrap()
}

fn fx() -> Fx {
    let mut conn = open_in_memory().unwrap();
    let ws = services::workspace::create(
        &mut conn,
        WorkspaceCreate {
            name: "W".into(),
            icon: None,
            ..Default::default()
        },
    )
    .unwrap();
    let db = create_database(
        &mut conn,
        DatabaseCreate {
            workspace_id: ws.id,
            parent_page_id: None,
            title: Some("Tasks".into()),
        },
    )
    .unwrap();
    let status = add(&mut conn, &db, "Status", "status", None);
    let done = add(&mut conn, &db, "Done", "checkbox", None);
    let points = add(&mut conn, &db, "Points", "number", None);
    let due = add(&mut conn, &db, "Due", "date", None);
    let button = add(
        &mut conn,
        &db,
        "Finish",
        "button",
        Some(json!({ "label": "Finish it" })),
    );
    Fx {
        conn,
        db,
        status,
        done,
        points,
        due,
        button,
    }
}

fn opt(p: &Property, name: &str) -> String {
    p.config["options"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["name"] == name)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn rec(conn: &mut Connection, db: &str, title: &str, values: Value) -> RecordRow {
    create_record(
        conn,
        RecordCreate {
            database_id: db.to_string(),
            title: Some(title.into()),
            values: values.as_object().cloned().unwrap_or_default(),
            template_id: None,
        },
    )
    .unwrap()
}

fn row(f: &Fx, id: &str) -> RecordRow {
    load_rows(&f.conn, &[id.to_string()]).unwrap().remove(0)
}

fn all(f: &Fx) -> Vec<RecordRow> {
    let ids: Vec<String> = f
        .conn
        .prepare("SELECT r.id FROM db_record r JOIN page p ON p.id = r.page_id WHERE p.deleted_at IS NULL ORDER BY r.unique_id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    load_rows(&f.conn, &ids).unwrap()
}

fn save_auto(
    conn: &mut Connection,
    db: &str,
    name: &str,
    trigger: Trigger,
    conditions: Option<FilterNode>,
    actions: Vec<Action>,
) -> AppResult<Automation> {
    save(
        conn,
        AutomationSave {
            id: None,
            database_id: db.to_string(),
            name: name.into(),
            enabled: true,
            trigger,
            conditions,
            actions,
        },
    )
}

fn set_to(pid: &str, v: Value) -> Action {
    Action::UpdateProperties {
        values: json!({ pid: v }).as_object().cloned().unwrap(),
    }
}

fn fire(conn: &mut Connection, ev: Event) -> Vec<engine::RunSummary> {
    let mut sink = |_: Notification| {};
    dispatch(conn, ev, &mut sink).unwrap()
}

fn created(r: &RecordRow) -> Event {
    Event::RecordCreated {
        record_id: r.id.clone(),
    }
}

fn runs_of(f: &Fx) -> Vec<Run> {
    runs(&f.conn, &f.db.database.id).unwrap()
}

#[test]
fn definitions_are_validated_against_the_database() {
    let mut f = fx();
    let ok = vec![set_to(&f.done.id, json!(true))];
    assert!(save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Fine",
        Trigger::RecordCreated,
        None,
        ok.clone()
    )
    .is_ok());
    for (name, trigger, actions) in [
        ("", Trigger::RecordCreated, ok.clone()),
        ("No actions", Trigger::RecordCreated, vec![]),
        (
            "Bad prop",
            Trigger::PropertyChanged {
                property_id: "nope".into(),
                to: None,
            },
            ok.clone(),
        ),
        (
            "Not a date",
            Trigger::DateReached {
                property_id: f.points.id.clone(),
                offset_days: 0,
                time: "09:00".into(),
            },
            ok.clone(),
        ),
        (
            "Bad time",
            Trigger::DateReached {
                property_id: f.due.id.clone(),
                offset_days: 0,
                time: "9am".into(),
            },
            ok.clone(),
        ),
        (
            "Not a button",
            Trigger::Button {
                property_id: f.done.id.clone(),
            },
            ok.clone(),
        ),
        (
            "Bad schedule",
            Trigger::Schedule {
                every: "fortnightly".into(),
                interval: 1,
                time: "09:00".into(),
                days: vec![],
            },
            vec![Action::Notify {
                title: "x".into(),
                body: None,
            }],
        ),
        (
            "No days",
            Trigger::Schedule {
                every: "weekly".into(),
                interval: 1,
                time: "09:00".into(),
                days: vec![],
            },
            vec![Action::Notify {
                title: "x".into(),
                body: None,
            }],
        ),
        (
            "Record action on schedule",
            Trigger::Schedule {
                every: "daily".into(),
                interval: 1,
                time: "09:00".into(),
                days: vec![],
            },
            ok.clone(),
        ),
        (
            "Computed target",
            Trigger::RecordCreated,
            vec![set_to(&f.button.id, json!(true))],
        ),
        (
            "Bad value",
            Trigger::RecordCreated,
            vec![set_to(&f.points.id, json!("many"))],
        ),
        (
            "Trash not last",
            Trigger::RecordCreated,
            vec![Action::TrashRecord, set_to(&f.done.id, json!(true))],
        ),
        (
            "Bad option",
            Trigger::RecordCreated,
            vec![Action::SetStatus {
                property_id: f.status.id.clone(),
                option_id: "zzz".into(),
            }],
        ),
        (
            "Empty notice",
            Trigger::RecordCreated,
            vec![Action::Notify {
                title: " ".into(),
                body: None,
            }],
        ),
    ] {
        assert!(
            save_auto(&mut f.conn, &f.db.database.id, name, trigger, None, actions).is_err(),
            "{name:?} should be rejected"
        );
    }
    // Conditions need a record and a valid filter.
    let sched = Trigger::Schedule {
        every: "daily".into(),
        interval: 1,
        time: "09:00".into(),
        days: vec![],
    };
    let note = vec![Action::Notify {
        title: "x".into(),
        body: None,
    }];
    let cond = FilterNode::Leaf {
        property_id: f.done.id.clone(),
        operator: "=".into(),
        value: json!(true),
    };
    assert!(save_auto(&mut f.conn, &f.db.database.id, "c", sched, Some(cond), note).is_err());
    let bad = FilterNode::Leaf {
        property_id: f.done.id.clone(),
        operator: "contains".into(),
        value: json!("x"),
    };
    assert!(save_auto(
        &mut f.conn,
        &f.db.database.id,
        "c2",
        Trigger::RecordCreated,
        Some(bad),
        ok.clone()
    )
    .is_err());
    // Tokens defer value checks to run time.
    assert!(save_auto(
        &mut f.conn,
        &f.db.database.id,
        "tok",
        Trigger::RecordCreated,
        None,
        vec![set_to(&f.due.id, json!({ "start": "{{today}}" }))]
    )
    .is_ok());
}

#[test]
fn a_new_record_triggers_actions_gated_by_conditions() {
    let mut f = fx();
    let cond = FilterNode::Leaf {
        property_id: f.points.id.clone(),
        operator: ">=".into(),
        value: json!(5),
    };
    let a = save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Big ones",
        Trigger::RecordCreated,
        Some(cond),
        vec![
            Action::SetStatus {
                property_id: f.status.id.clone(),
                option_id: opt(&f.status, "In progress"),
            },
            set_to(&f.done.id, json!(true)),
        ],
    )
    .unwrap();
    let small = rec(
        &mut f.conn,
        &f.db.database.id,
        "small",
        json!({ f.points.id.clone(): 1 }),
    );
    let big = rec(
        &mut f.conn,
        &f.db.database.id,
        "big",
        json!({ f.points.id.clone(): 9 }),
    );
    assert!(
        fire(&mut f.conn, created(&small)).is_empty(),
        "unmet conditions are not logged"
    );
    let out = fire(&mut f.conn, created(&big));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].status, "ok");
    assert!(out[0].message.contains("Status"));
    assert_eq!(row(&f, &small.id).values.get(&f.done.id), None);
    assert_eq!(row(&f, &big.id).values[&f.done.id], json!(true));
    assert_eq!(
        row(&f, &big.id).values[&f.status.id],
        json!(opt(&f.status, "In progress"))
    );
    assert_eq!(
        get(&f.conn, &a.id).unwrap().last_status.as_deref(),
        Some("ok")
    );
    assert_eq!(runs_of(&f).len(), 1);
    // Disabled automations do not run.
    set_enabled(&mut f.conn, &a.id, false).unwrap();
    let other = rec(
        &mut f.conn,
        &f.db.database.id,
        "other",
        json!({ f.points.id.clone(): 50 }),
    );
    assert!(fire(&mut f.conn, created(&other)).is_empty());
}

#[test]
fn property_changes_fire_only_for_the_chosen_property_and_value() {
    let mut f = fx();
    let done_opt = opt(&f.status, "Done");
    save_auto(
        &mut f.conn,
        &f.db.database.id,
        "When done",
        Trigger::PropertyChanged {
            property_id: f.status.id.clone(),
            to: Some(json!(done_opt)),
        },
        None,
        vec![set_to(&f.done.id, json!(true))],
    )
    .unwrap();
    let r = rec(&mut f.conn, &f.db.database.id, "t", json!({}));
    let ev = |new: Option<Value>| Event::PropertyChanged {
        record_id: r.id.clone(),
        property_id: f.status.id.clone(),
        new,
    };
    assert!(fire(&mut f.conn, ev(Some(json!(opt(&f.status, "In progress"))))).is_empty());
    assert!(fire(&mut f.conn, ev(None)).is_empty());
    let other = Event::PropertyChanged {
        record_id: r.id.clone(),
        property_id: f.points.id.clone(),
        new: Some(json!(done_opt)),
    };
    assert!(fire(&mut f.conn, other).is_empty());
    assert_eq!(fire(&mut f.conn, ev(Some(json!(done_opt)))).len(), 1);
    assert_eq!(row(&f, &r.id).values[&f.done.id], json!(true));
}

#[test]
fn a_failing_run_undoes_everything_it_did() {
    let mut f = fx();
    // The second action's value is only invalid once the token is filled in.
    save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Half way",
        Trigger::RecordCreated,
        None,
        vec![
            set_to(&f.done.id, json!(true)),
            set_to(&f.points.id, json!("{{title}}")),
        ],
    )
    .unwrap();
    let r = rec(&mut f.conn, &f.db.database.id, "abc", json!({}));
    let out = fire(&mut f.conn, created(&r));
    assert_eq!(out[0].status, "failed");
    assert_eq!(
        row(&f, &r.id).values.get(&f.done.id),
        None,
        "the first change was rolled back"
    );
    let log = runs_of(&f);
    assert_eq!(log[0].status, "failed");
    assert!(!log[0].message.is_empty());
}

#[test]
fn tokens_notifications_and_record_actions() {
    let mut f = fx();
    save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Greet",
        Trigger::RecordCreated,
        None,
        vec![
            Action::Notify {
                title: "New: {{title}}".into(),
                body: Some("Added {{today}}".into()),
            },
            set_to(&f.due.id, json!({ "start": "{{today}}" })),
            Action::CreateRecord {
                title: Some("Follow up on {{title}}".into()),
                values: Default::default(),
                template_id: None,
            },
        ],
    )
    .unwrap();
    let r = rec(&mut f.conn, &f.db.database.id, "Launch", json!({}));
    let mut seen = Vec::new();
    let mut sink = |n: Notification| seen.push(n);
    dispatch(&mut f.conn, created(&r), &mut sink).unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].title, "New: Launch");
    assert!(seen[0].body.starts_with("Added 20"));
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    assert_eq!(row(&f, &r.id).values[&f.due.id]["start"], json!(today));
    // The follow-up record triggered the same automation, which is already in the chain.
    let titles: Vec<String> = all(&f).into_iter().map(|x| x.title).collect();
    assert_eq!(titles, vec!["Launch", "Follow up on Launch"]);
    let log = runs_of(&f);
    assert!(log
        .iter()
        .any(|r| r.status == "skipped" && r.message.contains("already ran")));
}

#[test]
fn duplicate_archive_and_trash_actions() {
    let mut f = fx();
    let copy = save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Copy",
        Trigger::Button {
            property_id: f.button.id.clone(),
        },
        None,
        vec![Action::DuplicateRecord],
    )
    .unwrap();
    let r = rec(
        &mut f.conn,
        &f.db.database.id,
        "Original",
        json!({ f.points.id.clone(): 3 }),
    );
    let mut sink = |_: Notification| {};
    let out = press_button(&mut f.conn, &r.id, &f.button.id, &mut sink).unwrap();
    assert_eq!(out[0].status, "ok");
    let rows = all(&f);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].title, "Original (copy)");
    assert_eq!(rows[1].values[&f.points.id], json!(3.0));
    set_enabled(&mut f.conn, &copy.id, false).unwrap();

    save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Archive",
        Trigger::Button {
            property_id: f.button.id.clone(),
        },
        None,
        vec![Action::ArchiveRecord],
    )
    .unwrap();
    press_button(&mut f.conn, &r.id, &f.button.id, &mut sink).unwrap();
    let archived: bool = f
        .conn
        .query_row(
            "SELECT archived FROM page p JOIN db_record r ON r.page_id = p.id WHERE r.id = ?1",
            [&r.id],
            |x| x.get(0),
        )
        .unwrap();
    assert!(archived);

    let trash = save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Trash",
        Trigger::Button {
            property_id: f.button.id.clone(),
        },
        None,
        vec![Action::TrashRecord],
    )
    .unwrap();
    set_enabled(&mut f.conn, &trash.id, true).unwrap();
    press_button(&mut f.conn, &r.id, &f.button.id, &mut sink).unwrap();
    assert!(all(&f).iter().all(|x| x.id != r.id));
}

#[test]
fn buttons_need_a_button_property_and_an_automation() {
    let mut f = fx();
    let r = rec(&mut f.conn, &f.db.database.id, "t", json!({}));
    let mut sink = |_: Notification| {};
    assert!(
        press_button(&mut f.conn, &r.id, &f.button.id, &mut sink).is_err(),
        "nothing is wired to it yet"
    );
    assert!(
        press_button(&mut f.conn, &r.id, &f.done.id, &mut sink).is_err(),
        "not a button"
    );
    assert!(press_button(&mut f.conn, "not-an-id", &f.button.id, &mut sink).is_err());
    // A button holds no value.
    assert!(set_value(
        &mut f.conn,
        SetValue {
            record_id: r.id.clone(),
            property_id: f.button.id.clone(),
            value: json!(true)
        }
    )
    .is_err());
    assert_eq!(f.button.config["label"], "Finish it");
    save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Finish",
        Trigger::Button {
            property_id: f.button.id.clone(),
        },
        None,
        vec![set_to(&f.done.id, json!(true))],
    )
    .unwrap();
    let out = press_button(&mut f.conn, &r.id, &f.button.id, &mut sink).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(row(&f, &r.id).values[&f.done.id], json!(true));
}

#[test]
fn loops_are_cut_by_the_chain() {
    let mut f = fx();
    let (a, b) = (opt(&f.status, "In progress"), opt(&f.status, "Done"));
    // Status changing to X sets points; points changing sets status back: a ping-pong.
    save_auto(
        &mut f.conn,
        &f.db.database.id,
        "A",
        Trigger::PropertyChanged {
            property_id: f.status.id.clone(),
            to: None,
        },
        None,
        vec![set_to(&f.points.id, json!("{{today}}".len() as f64))],
    )
    .unwrap();
    save_auto(
        &mut f.conn,
        &f.db.database.id,
        "B",
        Trigger::PropertyChanged {
            property_id: f.points.id.clone(),
            to: None,
        },
        None,
        vec![Action::SetStatus {
            property_id: f.status.id.clone(),
            option_id: b.clone(),
        }],
    )
    .unwrap();
    let r = rec(
        &mut f.conn,
        &f.db.database.id,
        "t",
        json!({ f.status.id.clone(): a }),
    );
    let ev = Event::PropertyChanged {
        record_id: r.id.clone(),
        property_id: f.status.id.clone(),
        new: Some(json!(a)),
    };
    let out = fire(&mut f.conn, ev);
    assert_eq!(
        out.iter().filter(|s| s.status == "ok").count(),
        2,
        "A then B"
    );
    let skipped: Vec<_> = out.iter().filter(|s| s.status == "skipped").collect();
    assert_eq!(skipped.len(), 1, "A would run again, so it is stopped");
    assert!(skipped[0].message.contains("already ran"));
    // Everything shares one execution id.
    let log = runs_of(&f);
    assert!(log.iter().all(|r| r.execution_id == log[0].execution_id));
}

#[test]
fn chains_stop_at_the_depth_limit() {
    let mut f = fx();
    let numbers: Vec<Property> = (1..=5)
        .map(|i| add(&mut f.conn, &f.db.clone(), &format!("N{i}"), "number", None))
        .collect();
    // N1 changes set N2, N2 changes set N3, and so on: five automations in a row.
    for i in 0..4 {
        save_auto(
            &mut f.conn,
            &f.db.database.id,
            &format!("Step {}", i + 1),
            Trigger::PropertyChanged {
                property_id: numbers[i].id.clone(),
                to: None,
            },
            None,
            vec![set_to(&numbers[i + 1].id, json!(1))],
        )
        .unwrap();
    }
    let r = rec(
        &mut f.conn,
        &f.db.database.id,
        "t",
        json!({ numbers[0].id.clone(): 1 }),
    );
    let ev = Event::PropertyChanged {
        record_id: r.id.clone(),
        property_id: numbers[0].id.clone(),
        new: Some(json!(1)),
    };
    let out = fire(&mut f.conn, ev);
    let ok = out.iter().filter(|s| s.status == "ok").count();
    assert_eq!(ok as u32, MAX_DEPTH, "three links run");
    let stopped: Vec<_> = out.iter().filter(|s| s.status == "skipped").collect();
    assert_eq!(stopped.len(), 1);
    assert!(stopped[0].message.contains("limit"));
    assert!(row(&f, &r.id).values.contains_key(&numbers[3].id));
    assert!(
        !row(&f, &r.id).values.contains_key(&numbers[4].id),
        "the fourth link never ran"
    );
}

#[test]
fn app_start_and_manual_runs() {
    let mut f = fx();
    let a = save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Hello",
        Trigger::AppStarted,
        None,
        vec![Action::Notify {
            title: "Welcome back".into(),
            body: None,
        }],
    )
    .unwrap();
    let mut seen = Vec::new();
    {
        let mut sink = |n: Notification| seen.push(n.title);
        on_start(&mut f.conn, chrono::Local::now().naive_local(), &mut sink).unwrap();
    }
    assert_eq!(seen, vec!["Welcome back"]);
    let mut sink = |_: Notification| {};
    let cond = FilterNode::Leaf {
        property_id: f.done.id.clone(),
        operator: "=".into(),
        value: json!(true),
    };
    let m = save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Manual",
        Trigger::RecordUpdated,
        Some(cond),
        vec![set_to(&f.points.id, json!(7))],
    )
    .unwrap();
    let r = rec(&mut f.conn, &f.db.database.id, "t", json!({}));
    let skipped = run_now(&mut f.conn, &m.id, Some(&r.id), &mut sink).unwrap();
    assert_eq!(skipped.status, "skipped");
    assert!(skipped.message.contains("conditions"));
    set_value(
        &mut f.conn,
        SetValue {
            record_id: r.id.clone(),
            property_id: f.done.id.clone(),
            value: json!(true),
        },
    )
    .unwrap();
    assert_eq!(
        run_now(&mut f.conn, &m.id, None, &mut sink).unwrap().status,
        "ok",
        "defaults to the first record"
    );
    assert_eq!(row(&f, &r.id).values[&f.points.id], json!(7.0));
    assert!(run_now(&mut f.conn, &a.id, None, &mut sink).is_ok());
}

fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> chrono::NaiveDateTime {
    NaiveDate::from_ymd_opt(y, m, d)
        .unwrap()
        .and_hms_opt(h, min, 0)
        .unwrap()
}

fn sched(every: &str, interval: u32, time: &str, days: &[u32]) -> Trigger {
    Trigger::Schedule {
        every: every.into(),
        interval,
        time: time.into(),
        days: days.to_vec(),
    }
}

#[test]
fn schedule_slots_are_caught_up_once() {
    // 2026-10-07 is a Wednesday.
    let armed = at(2026, 10, 1, 12, 0);
    let daily = sched("daily", 1, "09:00", &[]);
    assert_eq!(
        due_slot(&daily, armed, at(2026, 10, 1, 13, 0)),
        None,
        "today's slot already passed before arming"
    );
    assert_eq!(due_slot(&daily, armed, at(2026, 10, 2, 8, 59)), None);
    assert_eq!(
        due_slot(&daily, armed, at(2026, 10, 2, 9, 0)),
        Some(at(2026, 10, 2, 9, 0))
    );
    // Six days closed: one run, for the latest slot.
    assert_eq!(
        due_slot(&daily, armed, at(2026, 10, 7, 20, 0)),
        Some(at(2026, 10, 7, 9, 0))
    );
    // Once handled, it is not due again until the next slot.
    assert_eq!(
        due_slot(&daily, at(2026, 10, 7, 9, 0), at(2026, 10, 7, 20, 0)),
        None
    );

    let weekly = sched("weekly", 1, "18:30", &[0, 4]); // Mondays and Fridays
    assert_eq!(
        due_slot(&weekly, armed, at(2026, 10, 7, 12, 0)),
        Some(at(2026, 10, 5, 18, 30))
    );
    assert_eq!(
        due_slot(&weekly, at(2026, 10, 5, 18, 30), at(2026, 10, 7, 12, 0)),
        None
    );
    assert_eq!(
        due_slot(&weekly, at(2026, 10, 5, 18, 30), at(2026, 10, 9, 19, 0)),
        Some(at(2026, 10, 9, 18, 30))
    );

    let every = sched("minutes", 15, "", &[]);
    assert_eq!(due_slot(&every, armed, armed + Duration::minutes(14)), None);
    assert_eq!(
        due_slot(&every, armed, armed + Duration::minutes(15)),
        Some(armed + Duration::minutes(15))
    );
    let hours = sched("hours", 2, "", &[]);
    assert_eq!(
        due_slot(&hours, armed, armed + Duration::minutes(119)),
        None
    );
    assert!(due_slot(&Trigger::AppStarted, armed, at(2030, 1, 1, 0, 0)).is_none());
}

#[test]
fn the_ticker_runs_a_schedule_once_per_slot() {
    let mut f = fx();
    let a = save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Morning",
        sched("daily", 1, "09:00", &[]),
        None,
        vec![Action::CreateRecord {
            title: Some("Daily {{today}}".into()),
            values: Default::default(),
            template_id: None,
        }],
    )
    .unwrap();
    let mut sink = |_: Notification| {};
    let now = chrono::Local::now().naive_local();
    assert_eq!(
        tick(&mut f.conn, now, &mut sink).unwrap(),
        0,
        "nothing runs retroactively"
    );
    let later = now + Duration::days(3);
    assert_eq!(
        tick(&mut f.conn, later, &mut sink).unwrap(),
        1,
        "missed days run once"
    );
    assert_eq!(
        tick(&mut f.conn, later + Duration::minutes(1), &mut sink).unwrap(),
        0
    );
    assert_eq!(all(&f).len(), 1);
    // Switching it off and on again starts counting from then.
    set_enabled(&mut f.conn, &a.id, false).unwrap();
    set_enabled(&mut f.conn, &a.id, true).unwrap();
    assert_eq!(
        tick(&mut f.conn, chrono::Local::now().naive_local(), &mut sink).unwrap(),
        0
    );
    // A broken schedule is not retried on every tick.
    assert!(get(&f.conn, &a.id).unwrap().last_status.is_some());
}

#[test]
fn date_triggers_fire_once_per_record_and_never_before_arming() {
    let mut f = fx();
    let today = chrono::Local::now().date_naive();
    let day = |d: i64| (today + Duration::days(d)).format("%Y-%m-%d").to_string();
    save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Due soon",
        Trigger::DateReached {
            property_id: f.due.id.clone(),
            offset_days: -1,
            time: "09:00".into(),
        },
        None,
        vec![set_to(&f.done.id, json!(true))],
    )
    .unwrap();
    let past = rec(
        &mut f.conn,
        &f.db.database.id,
        "past",
        json!({ f.due.id.clone(): { "start": day(-5) } }),
    );
    let soon = rec(
        &mut f.conn,
        &f.db.database.id,
        "soon",
        json!({ f.due.id.clone(): { "start": day(3) } }),
    );
    let none = rec(&mut f.conn, &f.db.database.id, "undated", json!({}));
    let mut sink = |_: Notification| {};
    let now = chrono::Local::now().naive_local();
    assert_eq!(tick(&mut f.conn, now, &mut sink).unwrap(), 0);
    // Two days on, "soon" is one day before its date: due. "past" was due before arming.
    assert_eq!(
        tick(
            &mut f.conn,
            now + Duration::days(2) + Duration::hours(12),
            &mut sink
        )
        .unwrap(),
        1
    );
    assert_eq!(row(&f, &soon.id).values[&f.done.id], json!(true));
    assert_eq!(row(&f, &past.id).values.get(&f.done.id), None);
    assert_eq!(row(&f, &none.id).values.get(&f.done.id), None);
    assert_eq!(
        tick(&mut f.conn, now + Duration::days(3), &mut sink).unwrap(),
        0,
        "once per record and date"
    );
    // Moving the date makes it due again.
    set_value(
        &mut f.conn,
        SetValue {
            record_id: soon.id.clone(),
            property_id: f.due.id.clone(),
            value: json!({ "start": day(6) }),
        },
    )
    .unwrap();
    assert_eq!(
        tick(&mut f.conn, now + Duration::days(6), &mut sink).unwrap(),
        1
    );
    assert_eq!(
        date_fire_time("2026-10-07", -1, "09:30"),
        Some(at(2026, 10, 6, 9, 30))
    );
    assert_eq!(
        date_fire_time("2026-10-07T14:00", 0, "09:00"),
        Some(at(2026, 10, 7, 9, 0))
    );
    assert_eq!(date_fire_time("junk", 0, "09:00"), None);
}

#[test]
fn the_run_log_is_bounded_and_automations_die_with_their_database() {
    let mut f = fx();
    let a = save_auto(
        &mut f.conn,
        &f.db.database.id,
        "Count",
        Trigger::RecordCreated,
        None,
        vec![Action::Notify {
            title: "x".into(),
            body: None,
        }],
    )
    .unwrap();
    let r = rec(&mut f.conn, &f.db.database.id, "t", json!({}));
    for _ in 0..(KEEP_RUNS + 10) {
        fire(&mut f.conn, created(&r));
    }
    assert_eq!(runs_of(&f).len() as i64, KEEP_RUNS);
    f.conn
        .execute("DELETE FROM db_database WHERE id = ?1", [&f.db.database.id])
        .unwrap();
    let left: i64 = f
        .conn
        .query_row(
            "SELECT COUNT(*) + (SELECT COUNT(*) FROM automation_run) FROM automation WHERE id = ?1",
            [&a.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn definitions_survive_saving_and_updating() {
    let mut f = fx();
    let a = save_auto(
        &mut f.conn,
        &f.db.database.id,
        "  Spaced  ",
        Trigger::RecordCreated,
        None,
        vec![set_to(&f.done.id, json!(true))],
    )
    .unwrap();
    assert_eq!(a.name, "Spaced");
    let updated = save(
        &mut f.conn,
        AutomationSave {
            id: Some(a.id.clone()),
            database_id: f.db.database.id.clone(),
            name: "Renamed".into(),
            enabled: false,
            trigger: sched("minutes", 5, "", &[]),
            conditions: None,
            actions: vec![Action::Notify {
                title: "tick".into(),
                body: None,
            }],
        },
    )
    .unwrap();
    assert_eq!(updated.id, a.id);
    assert!(!updated.enabled);
    assert_eq!(updated.trigger, sched("minutes", 5, "", &[]));
    assert_eq!(list(&f.conn, &f.db.database.id).unwrap().len(), 1);
    assert!(delete(&mut f.conn, &a.id).is_ok());
    assert!(delete(&mut f.conn, &a.id).is_err());
    for i in 0..MAX_AUTOMATIONS {
        save_auto(
            &mut f.conn,
            &f.db.database.id,
            &format!("A{i}"),
            Trigger::AppStarted,
            None,
            vec![Action::Notify {
                title: "x".into(),
                body: None,
            }],
        )
        .unwrap();
    }
    assert!(save_auto(
        &mut f.conn,
        &f.db.database.id,
        "One too many",
        Trigger::AppStarted,
        None,
        vec![Action::Notify {
            title: "x".into(),
            body: None
        }]
    )
    .is_err());
}

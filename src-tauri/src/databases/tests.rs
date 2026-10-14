use super::calc;
use super::previews;
use super::service::*;
use super::templates;
use super::*;
use crate::database::open_in_memory;
use crate::domain::*;
use crate::errors::AppError;
use crate::repositories as repo;
use crate::search;
use crate::services;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn setup() -> (Connection, Workspace) {
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
    (conn, ws)
}

fn new_db(conn: &mut Connection, ws: &Workspace) -> DatabaseDetail {
    create_database(
        conn,
        DatabaseCreate {
            workspace_id: ws.id.clone(),
            parent_page_id: None,
            title: Some("Tasks".into()),
        },
    )
    .unwrap()
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

fn rec(conn: &mut Connection, db: &DatabaseDetail, title: &str, values: Value) -> RecordRow {
    create_record(
        conn,
        RecordCreate {
            template_id: None,
            database_id: db.database.id.clone(),
            title: Some(title.into()),
            values: values.as_object().cloned().unwrap_or_default(),
        },
    )
    .unwrap()
}

fn set(
    conn: &mut Connection,
    r: &RecordRow,
    p: &Property,
    v: Value,
) -> Result<RecordRow, AppError> {
    set_value(
        conn,
        SetValue {
            record_id: r.id.clone(),
            property_id: p.id.clone(),
            value: v,
        },
    )
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

fn select(
    conn: &mut Connection,
    db: &DatabaseDetail,
    name: &str,
    ty: &str,
    names: &[&str],
) -> Property {
    let options: Vec<Value> = names
        .iter()
        .map(|n| json!({ "name": n, "color": "violet" }))
        .collect();
    add(conn, db, name, ty, Some(json!({ "options": options })))
}

fn view(conn: &mut Connection, db: &DatabaseDetail, cfg: ViewConfig) -> DbView {
    update_view(
        conn,
        ViewUpdate {
            name: None,
            view_id: db.views[0].id.clone(),
            config: cfg,
        },
    )
    .unwrap()
}

fn filter(p: &Property, op: &str, value: Value) -> FilterNode {
    FilterNode::Leaf {
        property_id: p.id.clone(),
        operator: op.into(),
        value,
    }
}

fn group(op: &str, children: Vec<FilterNode>) -> FilterNode {
    FilterNode::Group {
        op: op.into(),
        children,
    }
}

fn titles(conn: &Connection, db: &DatabaseDetail) -> Vec<String> {
    query_records(
        conn,
        &RecordQuery {
            extra_filter: None,
            view_id: None,
            group_key: None,
            subgroup_key: None,
            database_id: db.database.id.clone(),
            cursor: None,
            limit: Some(200),
            skip_total: false,
            range: None,
        },
    )
    .unwrap()
    .rows
    .into_iter()
    .map(|r| r.title)
    .collect()
}

fn with_filter(conn: &mut Connection, db: &DatabaseDetail, f: FilterNode) -> Vec<String> {
    view(
        conn,
        db,
        ViewConfig {
            filter: Some(f),
            ..Default::default()
        },
    );
    titles(conn, db)
}

fn with_sort(conn: &mut Connection, db: &DatabaseDetail, p: &Property, dir: &str) -> Vec<String> {
    view(
        conn,
        db,
        ViewConfig {
            sorts: vec![ViewSort {
                property_id: p.id.clone(),
                direction: dir.into(),
            }],
            ..Default::default()
        },
    );
    titles(conn, db)
}

// ---------------------------------------------------------------------------------------------

#[test]
fn new_database_is_a_page_with_a_title_property_tags_and_a_table_view() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    assert_eq!(db.page.kind, "database");
    assert_eq!(db.page.title, "Tasks");
    assert_eq!(
        db.properties
            .iter()
            .map(|p| p.property_type.as_str())
            .collect::<Vec<_>>(),
        ["title", "multi_select"]
    );
    assert_eq!(db.views[0].config.columns.len(), 2);
    assert!(titles(&conn, &db).is_empty());
    // It is an ordinary entry in the page tree.
    let tree = repo::page::list_children(&conn, &ws.id, None).unwrap();
    assert_eq!(tree.len(), 1);
    assert_eq!(
        database_detail_by_page(&conn, &db.page.id)
            .unwrap()
            .database
            .id,
        db.database.id
    );
}

#[test]
fn records_are_pages_under_the_database_and_stay_out_of_the_page_tree() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let r = rec(&mut conn, &db, "First", json!({}));
    let page = repo::page::get(&conn, &r.page_id).unwrap().unwrap();
    assert_eq!(page.kind, "record");
    assert_eq!(page.parent_page_id.as_deref(), Some(db.page.id.as_str()));
    assert!(repo::page::list_children(&conn, &ws.id, Some(&db.page.id))
        .unwrap()
        .is_empty());
    assert_eq!(
        repo::page::get(&conn, &db.page.id)
            .unwrap()
            .unwrap()
            .child_count,
        0
    );
    let detail = record_detail(&conn, &r.page_id).unwrap();
    assert_eq!(detail.record.title, "First");
    assert_eq!(detail.database.database.id, db.database.id);
}

#[test]
fn pages_cannot_be_nested_inside_databases_and_records_cannot_move() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let r = rec(&mut conn, &db, "R", json!({}));
    let plain = services::page::create(
        &mut conn,
        PageCreate {
            workspace_id: ws.id.clone(),
            parent_page_id: None,
            title: Some("P".into()),
            icon: None,
        },
    )
    .unwrap();
    assert!(matches!(
        services::page::create(
            &mut conn,
            PageCreate {
                workspace_id: ws.id.clone(),
                parent_page_id: Some(db.page.id.clone()),
                title: None,
                icon: None
            }
        ),
        Err(AppError::Validation(_))
    ));
    let mv = |conn: &mut Connection, id: &str, parent: Option<&str>| {
        services::page::move_page(
            conn,
            PageMove {
                id: id.into(),
                parent_page_id: parent.map(String::from),
                before_page_id: None,
            },
        )
    };
    assert!(matches!(
        mv(&mut conn, &plain.id, Some(&db.page.id)),
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        mv(&mut conn, &r.page_id, None),
        Err(AppError::Validation(_))
    ));
    // A database itself can be nested in a page.
    assert!(mv(&mut conn, &db.page.id, Some(&plain.id)).is_ok());
}

#[test]
fn property_rules() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let status = add(&mut conn, &db, "Status", "status", None);
    assert_eq!(status.config["options"].as_array().unwrap().len(), 3);
    assert!(status.config["options"][2]["group"] == "done");
    // Names are unique (case-insensitive), types known, one title only.
    for (name, ty) in [
        ("status", "text"),
        ("Other", "bogus"),
        ("Another title", "title"),
        ("  ", "text"),
    ] {
        assert!(matches!(
            add_property(
                &mut conn,
                PropertyCreate {
                    database_id: db.database.id.clone(),
                    name: name.into(),
                    property_type: ty.into(),
                    config: None
                }
            ),
            Err(AppError::Validation(_))
        ));
    }
    // Option validation.
    let mut bad = |cfg: Value| {
        add_property(
            &mut conn,
            PropertyCreate {
                database_id: db.database.id.clone(),
                name: "X".into(),
                property_type: "select".into(),
                config: Some(cfg),
            },
        )
    };
    assert!(bad(json!({ "options": [{ "name": "a" }, { "name": "A" }] })).is_err());
    assert!(bad(json!({ "options": [{ "name": "" }] })).is_err());
    assert!(bad(json!({ "options": [{ "name": "a", "color": "pink" }] })).is_err());
    let many: Vec<Value> = (0..51)
        .map(|i| json!({ "name": format!("o{i}") }))
        .collect();
    assert!(bad(json!({ "options": many })).is_err());
    // Rename and reorder; the type cannot change.
    let renamed = update_property(
        &mut conn,
        PropertyUpdate {
            id: status.id.clone(),
            name: Some("State".into()),
            config: None,
            position: Some(-1.0),
        },
    )
    .unwrap();
    assert_eq!(renamed.name, "State");
    let props = database_detail(&conn, &db.database.id).unwrap().properties;
    assert_eq!(props[0].id, status.id);
    // The title property cannot be deleted.
    let title = &props
        .iter()
        .find(|p| p.property_type == "title")
        .unwrap()
        .id;
    assert!(matches!(
        delete_property(&mut conn, title),
        Err(AppError::Validation(_))
    ));
}

#[test]
fn cell_values_are_validated_per_type() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let r = rec(&mut conn, &db, "R", json!({}));
    let text = add(&mut conn, &db, "Notes", "text", None);
    let num = add(&mut conn, &db, "Points", "number", None);
    let check = add(&mut conn, &db, "Done", "checkbox", None);
    let email = add(&mut conn, &db, "Email", "email", None);
    let phone = add(&mut conn, &db, "Phone", "phone", None);
    let date = add(&mut conn, &db, "Due", "date", None);
    let sel = select(&mut conn, &db, "Priority", "select", &["Low", "High"]);
    let multi = select(&mut conn, &db, "Labels", "multi_select", &["a", "b"]);
    let uid = add(&mut conn, &db, "ID", "unique_id", None);

    assert_eq!(
        set(&mut conn, &r, &text, json!("hello")).unwrap().values[&text.id],
        "hello"
    );
    assert!(set(&mut conn, &r, &text, json!("x".repeat(10_001))).is_err());
    assert!(set(&mut conn, &r, &text, json!(5)).is_err());
    assert!(!set(&mut conn, &r, &text, json!(null))
        .unwrap()
        .values
        .contains_key(&text.id));

    assert_eq!(
        set(&mut conn, &r, &num, json!(3.5)).unwrap().values[&num.id],
        3.5
    );
    assert!(set(&mut conn, &r, &num, json!("3")).is_err());

    assert_eq!(
        set(&mut conn, &r, &check, json!(true)).unwrap().values[&check.id],
        true
    );
    assert!(!set(&mut conn, &r, &check, json!(false))
        .unwrap()
        .values
        .contains_key(&check.id));

    assert!(set(&mut conn, &r, &email, json!("a b@c")).is_err());
    assert!(set(&mut conn, &r, &email, json!("a@b.co")).is_ok());
    assert!(set(&mut conn, &r, &phone, json!("+1 (555) 010-2030")).is_ok());
    assert!(set(&mut conn, &r, &phone, json!("call me")).is_err());

    assert!(set(
        &mut conn,
        &r,
        &date,
        json!({ "start": "2026-10-07", "end": "2026-10-09" })
    )
    .is_ok());
    assert!(set(&mut conn, &r, &date, json!({ "start": "2026-10-07T09:30" })).is_ok());
    assert!(set(
        &mut conn,
        &r,
        &date,
        json!({ "start": "2026-10-09", "end": "2026-10-07" })
    )
    .is_err());
    assert!(set(&mut conn, &r, &date, json!({ "start": "nope" })).is_err());

    let high = opt(&sel, "High");
    assert!(set(&mut conn, &r, &sel, json!(high)).is_ok());
    assert!(set(&mut conn, &r, &sel, json!("ghost")).is_err());
    let (a, b) = (opt(&multi, "a"), opt(&multi, "b"));
    let row = set(&mut conn, &r, &multi, json!([a, b, a])).unwrap();
    assert_eq!(row.values[&multi.id], json!([a, b]));
    assert!(!set(&mut conn, &r, &multi, json!([]))
        .unwrap()
        .values
        .contains_key(&multi.id));

    // Calculated properties are read-only; foreign properties are rejected.
    assert!(set(&mut conn, &r, &uid, json!(5)).is_err());
    let other = new_db(&mut conn, &ws);
    let foreign = add(&mut conn, &other, "Foreign", "text", None);
    assert!(set(&mut conn, &r, &foreign, json!("x")).is_err());
}

#[test]
fn unique_ids_count_up_and_titles_live_on_the_page() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let (a, b) = (
        rec(&mut conn, &db, "A", json!({})),
        rec(&mut conn, &db, "B", json!({})),
    );
    assert_eq!((a.unique_id, b.unique_id), (1, 2));
    let title = db
        .properties
        .iter()
        .find(|p| p.property_type == "title")
        .unwrap();
    let renamed = set(&mut conn, &a, title, json!("Renamed")).unwrap();
    assert_eq!(renamed.title, "Renamed");
    assert_eq!(
        repo::page::get(&conn, &a.page_id).unwrap().unwrap().title,
        "Renamed"
    );
    assert!(set(&mut conn, &a, title, json!("x".repeat(501))).is_err());
}

#[test]
fn text_filters() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let notes = add(&mut conn, &db, "Notes", "text", None);
    let title = db.properties[0].clone();
    rec(
        &mut conn,
        &db,
        "Alpha",
        json!({ notes.id.clone(): "100% sure_thing" }),
    );
    rec(&mut conn, &db, "Beta", json!({ notes.id.clone(): "plain" }));
    rec(&mut conn, &db, "Gamma", json!({}));
    assert_eq!(
        with_filter(&mut conn, &db, filter(&title, "contains", json!("ALP"))),
        ["Alpha"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&notes, "contains", json!("100%"))),
        ["Alpha"]
    ); // % is literal
    assert_eq!(
        with_filter(&mut conn, &db, filter(&notes, "contains", json!("_"))),
        ["Alpha"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&notes, "=", json!("PLAIN"))),
        ["Beta"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&notes, "!=", json!("plain"))),
        ["Alpha", "Gamma"]
    );
    assert_eq!(
        with_filter(
            &mut conn,
            &db,
            filter(&notes, "not_contains", json!("sure"))
        ),
        ["Beta", "Gamma"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&notes, "is_empty", json!(null))),
        ["Gamma"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&notes, "is_not_empty", json!(null))),
        ["Alpha", "Beta"]
    );
    // Hostile text is only ever a bound parameter.
    assert!(with_filter(
        &mut conn,
        &db,
        filter(&notes, "contains", json!("'; DROP TABLE page; --"))
    )
    .is_empty());
    view(&mut conn, &db, ViewConfig::default());
    assert_eq!(titles(&conn, &db).len(), 3);
}

#[test]
fn number_checkbox_option_and_date_filters() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let pts = add(&mut conn, &db, "Points", "number", None);
    let done = add(&mut conn, &db, "Done", "checkbox", None);
    let pri = select(&mut conn, &db, "Priority", "select", &["Low", "High"]);
    let tags = select(&mut conn, &db, "Labels", "multi_select", &["x", "y"]);
    let due = add(&mut conn, &db, "Due", "date", None);
    let (low, high) = (opt(&pri, "Low"), opt(&pri, "High"));
    let (x, y) = (opt(&tags, "x"), opt(&tags, "y"));
    let today = chrono::Local::now().date_naive();
    let day = |n: i64| {
        (today + chrono::Duration::days(n))
            .format("%Y-%m-%d")
            .to_string()
    };
    rec(
        &mut conn,
        &db,
        "A",
        json!({ pts.id.clone(): 1, done.id.clone(): true, pri.id.clone(): low, tags.id.clone(): [x], due.id.clone(): { "start": day(-2) } }),
    );
    rec(
        &mut conn,
        &db,
        "B",
        json!({ pts.id.clone(): 5, pri.id.clone(): high, tags.id.clone(): [x, y], due.id.clone(): { "start": format!("{}T10:00", day(0)) } }),
    );
    rec(
        &mut conn,
        &db,
        "C",
        json!({ pts.id.clone(): 10, due.id.clone(): { "start": day(3), "end": day(5) } }),
    );
    rec(&mut conn, &db, "D", json!({}));

    assert_eq!(
        with_filter(&mut conn, &db, filter(&pts, ">", json!(1))),
        ["B", "C"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&pts, ">=", json!(5))),
        ["B", "C"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&pts, "<", json!(5))),
        ["A"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&pts, "=", json!(10))),
        ["C"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&pts, "!=", json!(5))),
        ["A", "C", "D"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&pts, "is_empty", json!(null))),
        ["D"]
    );

    assert_eq!(
        with_filter(&mut conn, &db, filter(&done, "=", json!(true))),
        ["A"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&done, "=", json!(false))),
        ["B", "C", "D"]
    );

    assert_eq!(
        with_filter(&mut conn, &db, filter(&pri, "=", json!(high))),
        ["B"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&pri, "!=", json!(high))),
        ["A", "C", "D"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&pri, "is_empty", json!(null))),
        ["C", "D"]
    );

    assert_eq!(
        with_filter(&mut conn, &db, filter(&tags, "contains", json!(y))),
        ["B"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&tags, "contains", json!(x))),
        ["A", "B"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&tags, "not_contains", json!(y))),
        ["A", "C", "D"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&tags, "is_empty", json!(null))),
        ["C", "D"]
    );

    assert_eq!(
        with_filter(
            &mut conn,
            &db,
            filter(&due, "before", json!({ "relativeDays": 0 }))
        ),
        ["A"]
    );
    assert_eq!(
        with_filter(
            &mut conn,
            &db,
            filter(&due, "after", json!({ "relativeDays": 0 }))
        ),
        ["C"]
    );
    assert_eq!(
        with_filter(
            &mut conn,
            &db,
            filter(&due, "=", json!({ "relativeDays": 0 }))
        ),
        ["B"]
    );
    assert_eq!(
        with_filter(
            &mut conn,
            &db,
            filter(&due, "between", json!([day(-3), day(0)]))
        ),
        ["A", "B"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&due, "is_not_empty", json!(null))),
        ["A", "B", "C"]
    );
}

#[test]
fn computed_properties_filter_and_sort() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let id = add(&mut conn, &db, "ID", "unique_id", None);
    let created = add(&mut conn, &db, "Created", "created_time", None);
    for t in ["a", "b", "c"] {
        rec(&mut conn, &db, t, json!({}));
    }
    assert_eq!(
        with_filter(&mut conn, &db, filter(&id, ">=", json!(2))),
        ["b", "c"]
    );
    assert_eq!(with_sort(&mut conn, &db, &id, "desc"), ["c", "b", "a"]);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    assert_eq!(
        with_filter(&mut conn, &db, filter(&created, "=", json!(today))).len(),
        3
    );
}

#[test]
fn nested_and_or_groups_and_validation() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let pts = add(&mut conn, &db, "Points", "number", None);
    let done = add(&mut conn, &db, "Done", "checkbox", None);
    rec(
        &mut conn,
        &db,
        "A",
        json!({ pts.id.clone(): 1, done.id.clone(): true }),
    );
    rec(&mut conn, &db, "B", json!({ pts.id.clone(): 5 }));
    rec(
        &mut conn,
        &db,
        "C",
        json!({ pts.id.clone(): 9, done.id.clone(): true }),
    );
    let f = group(
        "and",
        vec![
            filter(&pts, ">", json!(0)),
            group(
                "or",
                vec![filter(&done, "=", json!(true)), filter(&pts, ">", json!(8))],
            ),
        ],
    );
    assert_eq!(with_filter(&mut conn, &db, f), ["A", "C"]);
    let f = group(
        "or",
        vec![
            filter(&pts, "=", json!(5)),
            group(
                "and",
                vec![filter(&done, "=", json!(true)), filter(&pts, "<", json!(5))],
            ),
        ],
    );
    assert_eq!(with_filter(&mut conn, &db, f), ["A", "B"]);
    // Empty groups do not filter anything.
    assert_eq!(with_filter(&mut conn, &db, group("and", vec![])).len(), 3);

    let reject = |conn: &mut Connection, f: FilterNode| {
        update_view(
            conn,
            ViewUpdate {
                name: None,
                view_id: db.views[0].id.clone(),
                config: ViewConfig {
                    filter: Some(f),
                    ..Default::default()
                },
            },
        )
    };
    assert!(reject(&mut conn, filter(&pts, "contains", json!("x"))).is_err()); // operator not valid for numbers
    assert!(reject(&mut conn, filter(&pts, ">", json!("abc"))).is_err());
    assert!(reject(&mut conn, group("xor", vec![])).is_err());
    let mut deep = filter(&pts, ">", json!(0));
    for _ in 0..6 {
        deep = group("and", vec![deep]);
    }
    assert!(reject(&mut conn, deep).is_err());
    let wide = group(
        "and",
        (0..120).map(|_| filter(&pts, ">", json!(0))).collect(),
    );
    assert!(reject(&mut conn, wide).is_err());
    // The stored view is untouched by rejected updates.
    assert_eq!(titles(&conn, &db).len(), 3);
}

#[test]
fn sorting_text_numbers_options_with_empties_last() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let title = db.properties[0].clone();
    let pts = add(&mut conn, &db, "Points", "number", None);
    let pri = select(
        &mut conn,
        &db,
        "Priority",
        "select",
        &["Low", "Mid", "High"],
    );
    let (low, mid, high) = (opt(&pri, "Low"), opt(&pri, "Mid"), opt(&pri, "High"));
    rec(
        &mut conn,
        &db,
        "banana",
        json!({ pts.id.clone(): 3, pri.id.clone(): high }),
    );
    rec(
        &mut conn,
        &db,
        "Apple",
        json!({ pts.id.clone(): 10, pri.id.clone(): low }),
    );
    rec(&mut conn, &db, "cherry", json!({ pri.id.clone(): mid }));
    rec(&mut conn, &db, "date", json!({ pts.id.clone(): 1 }));

    assert_eq!(
        with_sort(&mut conn, &db, &title, "asc"),
        ["Apple", "banana", "cherry", "date"]
    );
    assert_eq!(
        with_sort(&mut conn, &db, &title, "desc"),
        ["date", "cherry", "banana", "Apple"]
    );
    assert_eq!(
        with_sort(&mut conn, &db, &pts, "asc"),
        ["date", "banana", "Apple", "cherry"]
    ); // empty last
    assert_eq!(
        with_sort(&mut conn, &db, &pts, "desc"),
        ["Apple", "banana", "date", "cherry"]
    ); // still last
    assert_eq!(
        with_sort(&mut conn, &db, &pri, "asc"),
        ["Apple", "cherry", "banana", "date"]
    ); // option order, not alphabet
       // Secondary sort.
    view(
        &mut conn,
        &db,
        ViewConfig {
            sorts: vec![
                ViewSort {
                    property_id: pri.id.clone(),
                    direction: "asc".into(),
                },
                ViewSort {
                    property_id: title.id.clone(),
                    direction: "desc".into(),
                },
            ],
            ..Default::default()
        },
    );
    assert_eq!(titles(&conn, &db).len(), 4);
}

#[test]
fn multi_select_cannot_be_sorted_and_view_updates_are_normalized() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let tags = db
        .properties
        .iter()
        .find(|p| p.property_type == "multi_select")
        .unwrap()
        .clone();
    let title = db.properties[0].clone();
    let saved = view(
        &mut conn,
        &db,
        ViewConfig {
            columns: vec![
                ViewColumn {
                    property_id: tags.id.clone(),
                    width: Some(5000.0),
                    hidden: true,
                },
                ViewColumn {
                    property_id: title.id.clone(),
                    width: Some(10.0),
                    hidden: true,
                },
                ViewColumn {
                    property_id: "ghost".into(),
                    width: None,
                    hidden: false,
                },
            ],
            sorts: vec![
                ViewSort {
                    property_id: tags.id.clone(),
                    direction: "asc".into(),
                },
                ViewSort {
                    property_id: "ghost".into(),
                    direction: "asc".into(),
                },
            ],
            filter: None,
            ..Default::default()
        },
    );
    assert!(saved.config.sorts.is_empty());
    assert_eq!(saved.config.columns.len(), 2);
    assert_eq!(saved.config.columns[0].width, Some(800.0));
    assert!(saved.config.columns[0].hidden);
    assert_eq!(saved.config.columns[1].width, Some(60.0));
    assert!(
        !saved.config.columns[1].hidden,
        "the title column is always visible"
    );
    assert!(update_view(
        &mut conn,
        ViewUpdate {
            name: None,
            view_id: db.views[0].id.clone(),
            config: ViewConfig {
                sorts: vec![ViewSort {
                    property_id: title.id.clone(),
                    direction: "sideways".into()
                }],
                ..Default::default()
            }
        }
    )
    .is_err());
    // A new property appears in the table automatically.
    let extra = add(&mut conn, &db, "Extra", "text", None);
    let now = database_detail(&conn, &db.database.id).unwrap();
    assert!(now.views[0]
        .config
        .columns
        .iter()
        .any(|c| c.property_id == extra.id));
}

#[test]
fn deleting_a_property_prunes_the_view_values_and_search() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let notes = add(&mut conn, &db, "Notes", "text", None);
    let pts = add(&mut conn, &db, "Points", "number", None);
    let r = rec(
        &mut conn,
        &db,
        "R",
        json!({ notes.id.clone(): "findable words", pts.id.clone(): 4 }),
    );
    view(
        &mut conn,
        &db,
        ViewConfig {
            sorts: vec![ViewSort {
                property_id: notes.id.clone(),
                direction: "asc".into(),
            }],
            filter: Some(group(
                "and",
                vec![
                    filter(&notes, "is_not_empty", json!(null)),
                    filter(&pts, ">", json!(1)),
                ],
            )),
            ..Default::default()
        },
    );
    delete_property(&mut conn, &notes.id).unwrap();
    let d = database_detail(&conn, &db.database.id).unwrap();
    assert!(d.views[0].config.sorts.is_empty());
    assert!(
        matches!(&d.views[0].config.filter, Some(FilterNode::Group { children, .. }) if children.len() == 1)
    );
    assert_eq!(titles(&conn, &db), ["R"]);
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM db_value WHERE property_id = ?1",
            [&notes.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert!(find(&conn, &ws, "findable").is_empty());
    assert_eq!(
        record_detail(&conn, &r.page_id)
            .unwrap()
            .record
            .values
            .len(),
        1
    );
}

fn find(conn: &Connection, ws: &Workspace, q: &str) -> Vec<search::SearchHit> {
    search::search(
        conn,
        &search::SearchInput {
            workspace_id: ws.id.clone(),
            query: q.into(),
            titles_only: false,
            modified_within_days: None,
            limit: None,
            offset: None,
        },
    )
    .unwrap()
}

#[test]
fn text_properties_and_titles_are_searchable() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let notes = add(&mut conn, &db, "Notes", "text", None);
    let pts = add(&mut conn, &db, "Points", "number", None);
    let r = rec(
        &mut conn,
        &db,
        "Quest log",
        json!({ notes.id.clone(): "dragon sighting near harbor", pts.id.clone(): 77 }),
    );
    let hit = find(&conn, &ws, "harbor");
    assert_eq!(
        (hit.len(), hit[0].kind, hit[0].page_title.as_str()),
        (1, "block", "Quest log")
    );
    assert!(hit[0].block_id.is_none());
    assert_eq!(find(&conn, &ws, "quest")[0].kind, "page");
    assert!(find(&conn, &ws, "77").is_empty()); // numbers are not indexed

    set(&mut conn, &r, &notes, json!("now about lanterns")).unwrap();
    assert!(find(&conn, &ws, "harbor").is_empty());
    assert_eq!(find(&conn, &ws, "lanterns").len(), 1);
    set(&mut conn, &r, &notes, json!(null)).unwrap();
    assert!(find(&conn, &ws, "lanterns").is_empty());

    // Rebuild brings property text back.
    set(&mut conn, &r, &notes, json!("rebuild me")).unwrap();
    conn.execute("DELETE FROM search_fts", []).unwrap();
    conn.execute("DELETE FROM search_doc", []).unwrap();
    search::index::rebuild_workspace(&conn, &ws.id).unwrap();
    assert_eq!(find(&conn, &ws, "rebuild").len(), 1);
}

#[test]
fn pagination_total_and_cursors() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    for i in 0..25 {
        rec(&mut conn, &db, &format!("R{i:02}"), json!({}));
    }
    let q = |cursor: Option<&str>, limit| {
        query_records(
            &conn,
            &RecordQuery {
                extra_filter: None,
                view_id: None,
                group_key: None,
                subgroup_key: None,
                database_id: db.database.id.clone(),
                cursor: cursor.map(String::from),
                limit: Some(limit),
                skip_total: false,
                range: None,
            },
        )
        .unwrap()
    };
    let first = q(None, 10);
    assert_eq!((first.rows.len(), first.total), (10, Some(25)));
    assert_eq!(first.next_cursor.as_deref(), Some("o:10"));
    let second = q(first.next_cursor.as_deref(), 10);
    let third = q(second.next_cursor.as_deref(), 10);
    assert_eq!(
        (
            second.rows[0].title.as_str(),
            third.rows.len(),
            third.next_cursor.is_none()
        ),
        ("R10", 5, true)
    );
    let all: Vec<_> = [first, second, third]
        .into_iter()
        .flat_map(|p| p.rows)
        .map(|r| r.title)
        .collect();
    assert_eq!(all.len(), 25);
    assert_eq!(
        all.iter().collect::<std::collections::HashSet<_>>().len(),
        25
    );
    assert!(query_records(
        &conn,
        &RecordQuery {
            extra_filter: None,
            view_id: None,
            group_key: None,
            subgroup_key: None,
            database_id: db.database.id.clone(),
            cursor: Some("junk".into()),
            limit: None,
            skip_total: false,
            range: None
        }
    )
    .is_err());
    assert_eq!(q(None, 5000).rows.len(), 25); // clamped, never unbounded
}

#[test]
fn sorted_pages_report_totals_even_when_empty_or_beyond_the_end() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let points = add(&mut conn, &db, "Points", "number", None);
    for n in 0..5 {
        rec(
            &mut conn,
            &db,
            &format!("R{n}"),
            json!({points.id.clone(): n}),
        );
    }
    view(
        &mut conn,
        &db,
        ViewConfig {
            sorts: vec![ViewSort {
                property_id: points.id.clone(),
                direction: "desc".into(),
            }],
            ..Default::default()
        },
    );
    let query = |cursor: Option<&str>, skip_total, extra_filter| {
        query_records(
            &conn,
            &RecordQuery {
                database_id: db.database.id.clone(),
                view_id: None,
                cursor: cursor.map(String::from),
                limit: Some(2),
                skip_total,
                extra_filter,
                group_key: None,
                subgroup_key: None,
                range: None,
            },
        )
        .unwrap()
    };
    let first = query(None, false, None);
    assert_eq!(first.total, Some(5));
    assert_eq!(
        first
            .rows
            .iter()
            .map(|r| r.title.as_str())
            .collect::<Vec<_>>(),
        vec!["R4", "R3"]
    );
    let second = query(first.next_cursor.as_deref(), false, None);
    assert_eq!(second.total, Some(5));
    assert_eq!(second.rows[0].title, "R2");
    let beyond = query(Some("o:100"), false, None);
    assert!(beyond.rows.is_empty());
    assert_eq!(beyond.total, Some(5));
    let empty = query(None, false, Some(filter(&points, ">", json!(100))));
    assert!(empty.rows.is_empty());
    assert_eq!(empty.total, Some(0));
    assert_eq!(query(None, true, None).total, None);
}

#[test]
fn trash_restore_and_permanent_delete_of_records() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let a = rec(&mut conn, &db, "A", json!({}));
    let b = rec(&mut conn, &db, "B", json!({}));
    services::page::delete(&mut conn, &a.page_id).unwrap();
    assert_eq!(titles(&conn, &db), ["B"]);
    assert_eq!(
        query_records(
            &conn,
            &RecordQuery {
                extra_filter: None,
                view_id: None,
                group_key: None,
                subgroup_key: None,
                database_id: db.database.id.clone(),
                cursor: None,
                limit: None,
                skip_total: false,
                range: None
            }
        )
        .unwrap()
        .total,
        Some(1)
    );
    services::page::restore(&mut conn, &a.page_id).unwrap();
    assert_eq!(titles(&conn, &db).len(), 2);

    // A record trashed on its own cannot be restored while its database is in the trash.
    services::page::delete(&mut conn, &b.page_id).unwrap();
    // Trash batches are told apart by timestamp (milliseconds), so let the clock tick.
    std::thread::sleep(std::time::Duration::from_millis(3));
    services::page::delete(&mut conn, &db.page.id).unwrap();
    assert!(matches!(
        services::page::restore(&mut conn, &b.page_id),
        Err(AppError::Validation(_))
    ));
    services::page::restore(&mut conn, &db.page.id).unwrap();
    assert!(services::page::restore(&mut conn, &b.page_id).is_ok());
    // Trashing a database trashes its records with it; restoring brings them all back.
    services::page::delete(&mut conn, &db.page.id).unwrap();
    assert!(find(&conn, &ws, "A").is_empty());
    services::page::restore(&mut conn, &db.page.id).unwrap();
    assert_eq!(titles(&conn, &db).len(), 2);

    // Permanent delete removes every table row.
    services::page::delete(&mut conn, &db.page.id).unwrap();
    services::page::delete_permanent(&mut conn, &db.page.id).unwrap();
    for table in [
        "db_database",
        "db_property",
        "db_record",
        "db_value",
        "db_view",
    ] {
        let n: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }
    let docs: i64 = conn
        .query_row("SELECT COUNT(*) FROM search_doc", [], |r| r.get(0))
        .unwrap();
    assert_eq!(docs, 0);
}

#[test]
fn duplicating_a_record_copies_values_content_and_gets_a_new_id() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let notes = add(&mut conn, &db, "Notes", "text", None);
    let r = rec(
        &mut conn,
        &db,
        "Original",
        json!({ notes.id.clone(): "carried over" }),
    );
    let parent = new_id();
    let child = new_id();
    let up = |id: &str, parent: Option<&str>, text: &str| BlockUpsert {
        id: id.into(),
        parent_block_id: parent.map(String::from),
        block_type: "bullet_list".into(),
        position: 0.0,
        data_json: format!(r#"{{"content":[{{"type":"text","text":"{text}"}}]}}"#),
        schema_version: 2,
    };
    services::block::apply_batch(
        &mut conn,
        BlockBatch {
            page_id: r.page_id.clone(),
            upserts: vec![
                up(&parent, None, "outer"),
                up(&child, Some(&parent), "inner words"),
            ],
            delete_ids: vec![],
        },
    )
    .unwrap();

    let copy = duplicate_record(&mut conn, &r.id).unwrap();
    assert_eq!(
        (copy.title.as_str(), copy.unique_id),
        ("Original (copy)", 2)
    );
    assert_eq!(copy.values[&notes.id], "carried over");
    assert_ne!(copy.page_id, r.page_id);
    let blocks = repo::block::list(&conn, &copy.page_id).unwrap();
    assert_eq!(blocks.len(), 2);
    let nested = blocks.iter().find(|b| b.parent_block_id.is_some()).unwrap();
    assert!(blocks
        .iter()
        .any(|b| Some(&b.id) == nested.parent_block_id.as_ref()));
    assert!(blocks.iter().all(|b| b.id != parent && b.id != child));
    assert_eq!(find(&conn, &ws, "inner").len(), 2); // both pages are searchable
    assert_eq!(find(&conn, &ws, "carried").len(), 2);
    assert_eq!(titles(&conn, &db).len(), 2);
}

#[test]
fn unknown_properties_in_saved_filters_are_ignored_not_fatal() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    rec(&mut conn, &db, "A", json!({}));
    let props = database_detail(&conn, &db.database.id).unwrap().properties;
    let cfg = ViewConfig {
        filter: Some(group(
            "or",
            vec![FilterNode::Leaf {
                property_id: "gone".into(),
                operator: "=".into(),
                value: json!("x"),
            }],
        )),
        ..Default::default()
    };
    let norm = normalize_view(cfg, &props, &db.database.id, "table").unwrap();
    assert!(norm.filter.is_some());
    update_view(
        &mut conn,
        ViewUpdate {
            name: None,
            view_id: db.views[0].id.clone(),
            config: norm,
        },
    )
    .unwrap();
    assert_eq!(titles(&conn, &db), ["A"]);
}

#[test]
fn records_validate_their_inputs() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let num = add(&mut conn, &db, "N", "number", None);
    let title = db.properties[0].clone();
    let attempt = |conn: &mut Connection, values: Value| {
        create_record(
            conn,
            RecordCreate {
                template_id: None,
                database_id: db.database.id.clone(),
                title: None,
                values: values.as_object().cloned().unwrap(),
            },
        )
    };
    assert!(attempt(&mut conn, json!({ num.id.clone(): "x" })).is_err());
    assert!(attempt(&mut conn, json!({ "ghost": 1 })).is_err());
    assert!(attempt(&mut conn, json!({ title.id.clone(): "t" })).is_err());
    assert!(attempt(&mut conn, json!({ num.id.clone(): 1 })).is_ok());
    assert!(create_record(
        &mut conn,
        RecordCreate {
            template_id: None,
            database_id: "nope".into(),
            title: None,
            values: Default::default()
        }
    )
    .is_err());
    // Nothing from the failed attempts leaked in.
    assert_eq!(titles(&conn, &db).len(), 1);
}

// ---------------------------------------------------------------------------------------------
// views and grouping (Phase 5)
// ---------------------------------------------------------------------------------------------

fn mk_view(
    conn: &mut Connection,
    db: &DatabaseDetail,
    ty: &str,
    cfg: Option<ViewConfig>,
) -> DbView {
    create_view(
        conn,
        ViewCreate {
            database_id: db.database.id.clone(),
            name: None,
            view_type: ty.into(),
            config: cfg,
        },
    )
    .unwrap()
}

fn counts(conn: &Connection, db: &DatabaseDetail, view: &DbView) -> Vec<(String, i64)> {
    group_counts(
        conn,
        &GroupCountsQuery {
            extra_filter: None,
            database_id: db.database.id.clone(),
            view_id: Some(view.id.clone()),
        },
    )
    .unwrap()
    .into_iter()
    .map(|g| (g.key, g.count))
    .collect()
}

fn rq(db: &DatabaseDetail, view: &DbView, key: Option<&str>, sub: Option<&str>) -> RecordQuery {
    RecordQuery {
        extra_filter: None,
        database_id: db.database.id.clone(),
        view_id: Some(view.id.clone()),
        group_key: key.map(String::from),
        subgroup_key: sub.map(String::from),
        cursor: None,
        limit: Some(200),
        skip_total: false,
        range: None,
    }
}

fn grouped_titles(
    conn: &Connection,
    db: &DatabaseDetail,
    view: &DbView,
    key: &str,
    sub: Option<&str>,
) -> Vec<String> {
    query_records(conn, &rq(db, view, Some(key), sub))
        .unwrap()
        .rows
        .into_iter()
        .map(|r| r.title)
        .collect()
}

fn group_by(p: &Property, bucket: Option<&str>) -> Option<GroupSpec> {
    Some(GroupSpec {
        property_id: p.id.clone(),
        bucket: bucket.map(String::from),
    })
}

fn set_view(conn: &mut Connection, view: &DbView, cfg: ViewConfig) -> Result<DbView, AppError> {
    update_view(
        conn,
        ViewUpdate {
            name: None,
            view_id: view.id.clone(),
            config: cfg,
        },
    )
}

#[test]
fn a_database_can_have_several_named_views_with_their_own_settings() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let status = add(&mut conn, &db, "Status", "status", None);
    let due = add(&mut conn, &db, "Due", "date", None);
    let done = opt(&status, "Done");
    rec(&mut conn, &db, "A", json!({ status.id.clone(): done }));
    rec(&mut conn, &db, "B", json!({}));

    let board = mk_view(&mut conn, &db, "board", None);
    assert_eq!(board.view_type, "board");
    assert_eq!(board.name, "Board");
    assert_eq!(
        board.config.group.as_ref().unwrap().property_id,
        status.id,
        "a board starts grouped by status"
    );
    let shown: Vec<_> = board.config.columns.iter().filter(|c| !c.hidden).collect();
    assert!(shown.len() <= 4 && shown.iter().any(|c| c.property_id == db.properties[0].id));

    let cal = mk_view(&mut conn, &db, "calendar", None);
    assert_eq!(
        cal.config.date_property_id.as_deref(),
        Some(due.id.as_str()),
        "calendars default to the first date property"
    );
    let gallery = mk_view(&mut conn, &db, "gallery", None);
    assert_eq!(gallery.config.card_size.as_deref(), Some("medium"));
    let timeline = mk_view(&mut conn, &db, "timeline", None);
    assert_eq!(timeline.config.zoom.as_deref(), Some("month"));
    mk_view(&mut conn, &db, "list", None);
    assert_eq!(
        database_detail(&conn, &db.database.id).unwrap().views.len(),
        7
    );

    // Each view filters on its own.
    let t = update_view(
        &mut conn,
        ViewUpdate {
            name: Some("Only done".into()),
            view_id: board.id.clone(),
            config: ViewConfig {
                filter: Some(filter(&status, "=", json!(done))),
                ..board.config.clone()
            },
        },
    )
    .unwrap();
    assert_eq!(t.name, "Only done");
    let q = |view: &DbView| {
        query_records(&conn, &rq(&db, view, None, None))
            .unwrap()
            .rows
            .len()
    };
    assert_eq!((q(&t), q(&gallery)), (1, 2));
    // Views of other databases are refused.
    let other = new_db(&mut conn, &ws);
    assert!(query_records(&conn, &rq(&other, &t, None, None)).is_err());

    // Duplicate, rename validation, delete (never the last one).
    let copy = duplicate_view(&mut conn, &t.id).unwrap();
    assert_eq!(
        (copy.view_type.as_str(), copy.name.as_str()),
        ("board", "Only done copy")
    );
    assert!(update_view(
        &mut conn,
        ViewUpdate {
            name: Some("  ".into()),
            view_id: copy.id.clone(),
            config: copy.config.clone()
        }
    )
    .is_err());
    assert!(create_view(
        &mut conn,
        ViewCreate {
            database_id: db.database.id.clone(),
            name: None,
            view_type: "pie".into(),
            config: None
        }
    )
    .is_err());
    let all = database_detail(&conn, &db.database.id).unwrap().views;
    for v in all.iter().skip(1) {
        delete_view(&mut conn, &v.id).unwrap();
    }
    assert!(matches!(
        delete_view(&mut conn, &all[0].id),
        Err(AppError::Validation(_))
    ));
}

#[test]
fn views_are_capped() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    for _ in 2..MAX_VIEWS {
        mk_view(&mut conn, &db, "list", None);
    }
    assert!(create_view(
        &mut conn,
        ViewCreate {
            database_id: db.database.id.clone(),
            name: None,
            view_type: "list".into(),
            config: None
        }
    )
    .is_err());
}

#[test]
fn group_counts_follow_option_order_and_put_empty_last() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let status = add(&mut conn, &db, "Status", "status", None);
    let (todo, doing) = (opt(&status, "Not started"), opt(&status, "In progress"));
    rec(&mut conn, &db, "a", json!({ status.id.clone(): doing }));
    rec(&mut conn, &db, "b", json!({ status.id.clone(): doing }));
    rec(&mut conn, &db, "c", json!({ status.id.clone(): todo }));
    rec(&mut conn, &db, "d", json!({}));
    let board = mk_view(&mut conn, &db, "board", None);
    let done = opt(&status, "Done");
    assert_eq!(
        counts(&conn, &db, &board),
        vec![
            (todo.clone(), 1),
            (doing.clone(), 2),
            (done.clone(), 0),
            ("__empty".to_string(), 1)
        ]
    );
    // Hiding empty groups drops the zero-count option.
    let hidden = set_view(
        &mut conn,
        &board,
        ViewConfig {
            hide_empty_groups: true,
            ..board.config.clone()
        },
    )
    .unwrap();
    assert_eq!(
        counts(&conn, &db, &hidden)
            .iter()
            .map(|(k, _)| k.as_str())
            .collect::<Vec<_>>(),
        [todo.as_str(), doing.as_str(), "__empty"]
    );
    // Records of one group can be queried alone.
    assert_eq!(grouped_titles(&conn, &db, &board, &doing, None), ["a", "b"]);
    assert_eq!(grouped_titles(&conn, &db, &board, "__empty", None), ["d"]);
    assert!(grouped_titles(&conn, &db, &board, &done, None).is_empty());
    // Groups respect the view's filter.
    let pts = add(&mut conn, &db, "Points", "number", None);
    let e = rec(
        &mut conn,
        &db,
        "e",
        json!({ status.id.clone(): doing, pts.id.clone(): 9 }),
    );
    let filtered = set_view(
        &mut conn,
        &board,
        ViewConfig {
            filter: Some(filter(&pts, ">", json!(5))),
            ..board.config.clone()
        },
    )
    .unwrap();
    assert_eq!(
        counts(&conn, &db, &filtered)
            .into_iter()
            .find(|(k, _)| *k == doing)
            .unwrap()
            .1,
        1
    );
    assert_eq!(grouped_titles(&conn, &db, &filtered, &doing, None), ["e"]);
    // Trashed records are not counted (the view is saved, so clear its filter first).
    let board = set_view(
        &mut conn,
        &board,
        ViewConfig {
            filter: None,
            hide_empty_groups: false,
            ..board.config.clone()
        },
    )
    .unwrap();
    services::page::delete(&mut conn, &e.page_id).unwrap();
    assert_eq!(
        counts(&conn, &db, &board)
            .into_iter()
            .find(|(k, _)| *k == doing)
            .unwrap()
            .1,
        2
    );
}

#[test]
fn grouping_by_checkbox_and_by_date_buckets() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let done = add(&mut conn, &db, "Done", "checkbox", None);
    let due = add(&mut conn, &db, "Due", "date", None);
    rec(
        &mut conn,
        &db,
        "a",
        json!({ done.id.clone(): true, due.id.clone(): { "start": "2026-10-03" } }),
    );
    rec(
        &mut conn,
        &db,
        "b",
        json!({ due.id.clone(): { "start": "2026-10-20T09:00" } }),
    );
    rec(
        &mut conn,
        &db,
        "c",
        json!({ due.id.clone(): { "start": "2026-11-01" } }),
    );
    rec(&mut conn, &db, "d", json!({}));
    let base = mk_view(&mut conn, &db, "list", None);
    let with = |conn: &mut Connection, g: Option<GroupSpec>| {
        set_view(
            conn,
            &base,
            ViewConfig {
                group: g,
                ..base.config.clone()
            },
        )
        .unwrap()
    };

    let v = with(&mut conn, group_by(&done, None));
    assert_eq!(
        counts(&conn, &db, &v),
        vec![("false".to_string(), 3), ("true".to_string(), 1)]
    );
    assert_eq!(grouped_titles(&conn, &db, &v, "true", None), ["a"]);

    let v = with(&mut conn, group_by(&due, Some("month")));
    assert_eq!(
        counts(&conn, &db, &v),
        vec![
            ("2026-10".to_string(), 2),
            ("2026-11".to_string(), 1),
            ("__empty".to_string(), 1)
        ]
    );
    assert_eq!(grouped_titles(&conn, &db, &v, "2026-10", None), ["a", "b"]);
    let v = with(&mut conn, group_by(&due, Some("day")));
    assert_eq!(counts(&conn, &db, &v).len(), 4);
    let v = with(&mut conn, group_by(&due, Some("year")));
    assert_eq!(counts(&conn, &db, &v)[0], ("2026".to_string(), 3));
    let v = with(&mut conn, group_by(&due, Some("week")));
    assert!(counts(&conn, &db, &v)
        .iter()
        .any(|(k, _)| k.starts_with("2026-W")));
}

#[test]
fn subgroups_split_each_group() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let status = add(&mut conn, &db, "Status", "status", None);
    let pri = select(&mut conn, &db, "Priority", "select", &["Low", "High"]);
    let (doing, done) = (opt(&status, "In progress"), opt(&status, "Done"));
    let (low, high) = (opt(&pri, "Low"), opt(&pri, "High"));
    rec(
        &mut conn,
        &db,
        "a",
        json!({ status.id.clone(): doing, pri.id.clone(): high }),
    );
    rec(
        &mut conn,
        &db,
        "b",
        json!({ status.id.clone(): doing, pri.id.clone(): low }),
    );
    rec(
        &mut conn,
        &db,
        "c",
        json!({ status.id.clone(): done, pri.id.clone(): high }),
    );
    let board = mk_view(&mut conn, &db, "board", None);
    let v = set_view(
        &mut conn,
        &board,
        ViewConfig {
            subgroup: group_by(&pri, None),
            ..board.config.clone()
        },
    )
    .unwrap();
    let groups = group_counts(
        &conn,
        &GroupCountsQuery {
            extra_filter: None,
            database_id: db.database.id.clone(),
            view_id: Some(v.id.clone()),
        },
    )
    .unwrap();
    let in_progress = groups.iter().find(|g| g.key == doing).unwrap();
    let sub: Vec<_> = in_progress
        .subgroups
        .iter()
        .map(|s| (s.key.as_str(), s.count))
        .collect();
    assert_eq!(sub, [(low.as_str(), 1), (high.as_str(), 1), ("__empty", 0)]);
    assert_eq!(grouped_titles(&conn, &db, &v, &doing, Some(&high)), ["a"]);
    assert!(grouped_titles(&conn, &db, &v, &done, Some(&low)).is_empty());
    // A subgroup on the same property as the group is ignored.
    let same = set_view(
        &mut conn,
        &board,
        ViewConfig {
            subgroup: group_by(&status, None),
            ..board.config.clone()
        },
    )
    .unwrap();
    assert!(same.config.subgroup.is_none());
}

#[test]
fn grouping_and_view_settings_are_validated() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let notes = add(&mut conn, &db, "Notes", "text", None);
    let due = add(&mut conn, &db, "Due", "date", None);
    let list = mk_view(&mut conn, &db, "list", None);
    assert!(set_view(
        &mut conn,
        &list,
        ViewConfig {
            group: group_by(&notes, None),
            ..list.config.clone()
        }
    )
    .is_err());
    assert!(set_view(
        &mut conn,
        &list,
        ViewConfig {
            group: group_by(&due, Some("decade")),
            ..list.config.clone()
        }
    )
    .is_err());
    assert!(set_view(
        &mut conn,
        &list,
        ViewConfig {
            card_size: Some("huge".into()),
            ..list.config.clone()
        }
    )
    .is_err());
    assert!(set_view(
        &mut conn,
        &list,
        ViewConfig {
            zoom: Some("hour".into()),
            ..list.config.clone()
        }
    )
    .is_err());
    // Unknown properties are dropped quietly; a date bucket defaults to month.
    let ok = set_view(
        &mut conn,
        &list,
        ViewConfig {
            group: group_by(&due, None),
            date_property_id: Some("ghost".into()),
            ..list.config.clone()
        },
    )
    .unwrap();
    assert_eq!(ok.config.group.unwrap().bucket.as_deref(), Some("month"));
    assert!(ok.config.date_property_id.is_none());
    let gone = set_view(
        &mut conn,
        &list,
        ViewConfig {
            group: Some(GroupSpec {
                property_id: "ghost".into(),
                bucket: None,
            }),
            ..list.config.clone()
        },
    )
    .unwrap();
    assert!(gone.config.group.is_none());
    // A group count request needs a grouped view.
    assert!(group_counts(
        &conn,
        &GroupCountsQuery {
            extra_filter: None,
            database_id: db.database.id.clone(),
            view_id: Some(list.id.clone())
        }
    )
    .is_err());
}

#[test]
fn schema_changes_reach_every_view() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let status = add(&mut conn, &db, "Status", "status", None);
    let due = add(&mut conn, &db, "Due", "date", None);
    let board = mk_view(
        &mut conn,
        &db,
        "board",
        Some(ViewConfig {
            group: group_by(&status, None),
            ..Default::default()
        }),
    );
    let cal = mk_view(
        &mut conn,
        &db,
        "calendar",
        Some(ViewConfig {
            date_property_id: Some(due.id.clone()),
            ..Default::default()
        }),
    );

    // A new property appears in the table but stays off the cards until turned on.
    let extra = add(&mut conn, &db, "Extra", "text", None);
    let views = database_detail(&conn, &db.database.id).unwrap().views;
    let hidden = |v: &DbView| {
        v.config
            .columns
            .iter()
            .find(|c| c.property_id == extra.id)
            .map(|c| c.hidden)
    };
    assert_eq!(hidden(&views[0]), Some(false));
    assert_eq!(
        hidden(views.iter().find(|v| v.id == board.id).unwrap()),
        Some(true)
    );

    // Deleting the grouping or date property clears those settings.
    delete_property(&mut conn, &status.id).unwrap();
    delete_property(&mut conn, &due.id).unwrap();
    let views = database_detail(&conn, &db.database.id).unwrap().views;
    assert!(views
        .iter()
        .find(|v| v.id == board.id)
        .unwrap()
        .config
        .group
        .is_none());
    assert!(views
        .iter()
        .find(|v| v.id == cal.id)
        .unwrap()
        .config
        .date_property_id
        .is_none());
    assert!(views.iter().all(|v| v
        .config
        .columns
        .iter()
        .all(|c| c.property_id != status.id && c.property_id != due.id)));
}

/// Run with `cargo test --release databases_scale -- --ignored --nocapture`.
#[test]
#[ignore = "benchmark"]
fn databases_scale_to_the_design_target() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let notes = add(&mut conn, &db, "Notes", "text", None);
    let pts = add(&mut conn, &db, "Points", "number", None);
    let pri = select(
        &mut conn,
        &db,
        "Priority",
        "select",
        &["Low", "Mid", "High"],
    );
    let due = add(&mut conn, &db, "Due", "date", None);
    let ids: Vec<String> = ["Low", "Mid", "High"]
        .iter()
        .map(|n| opt(&pri, n))
        .collect();
    let start = std::time::Instant::now();
    let tx = conn.transaction().unwrap();
    let now = now();
    for i in 0..50_000usize {
        let page_id = new_id();
        let rid = new_id();
        tx.execute(
            "INSERT INTO page (id, workspace_id, parent_page_id, title, position, created_at, updated_at, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'record')",
            params![page_id, ws.id, db.page.id, format!("Task {i} {}", ["alpha", "beta", "gamma"][i % 3]), i as f64, now],
        )
        .unwrap();
        tx.execute("INSERT INTO db_record (id, database_id, page_id, unique_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![rid, db.database.id, page_id, i as i64 + 1, format!("{now}{i:06}")]).unwrap();
        let ins = |p: &Property, v: Value| {
            tx.execute(
                "INSERT INTO db_value (record_id, property_id, value_json) VALUES (?1, ?2, ?3)",
                params![rid, p.id, v.to_string()],
            )
            .unwrap()
        };
        ins(&notes, json!(format!("note number {i}")));
        ins(&pts, json!((i % 100) as f64));
        ins(&pri, json!(ids[i % 3]));
        ins(
            &due,
            json!({ "start": format!("2026-{:02}-{:02}", i % 12 + 1, i % 28 + 1) }),
        );
    }
    tx.commit().unwrap();
    println!("inserted 50k records in {:?}", start.elapsed());
    let time = |label: &str, conn: &mut Connection, cfg: ViewConfig, cursor: Option<&str>| {
        update_view(
            conn,
            ViewUpdate {
                name: None,
                view_id: db.views[0].id.clone(),
                config: cfg,
            },
        )
        .unwrap();
        let t = std::time::Instant::now();
        let page = query_records(
            conn,
            &RecordQuery {
                extra_filter: None,
                view_id: None,
                group_key: None,
                subgroup_key: None,
                database_id: db.database.id.clone(),
                cursor: cursor.map(String::from),
                limit: Some(100),
                skip_total: false,
                range: None,
            },
        )
        .unwrap();
        println!(
            "{label:>34}: {:>6} total, {:>3} rows in {:?}",
            page.total.unwrap_or(-1),
            page.rows.len(),
            t.elapsed()
        );
    };
    time(
        "unfiltered, first page",
        &mut conn,
        ViewConfig::default(),
        None,
    );
    time(
        "unfiltered, offset 49,900",
        &mut conn,
        ViewConfig::default(),
        Some("o:49900"),
    );
    time(
        "filter points > 90",
        &mut conn,
        ViewConfig {
            filter: Some(filter(&pts, ">", json!(90))),
            ..Default::default()
        },
        None,
    );
    time(
        "filter text contains 'number 4'",
        &mut conn,
        ViewConfig {
            filter: Some(filter(&notes, "contains", json!("number 4"))),
            ..Default::default()
        },
        None,
    );
    time(
        "sort by points desc",
        &mut conn,
        ViewConfig {
            sorts: vec![ViewSort {
                property_id: pts.id.clone(),
                direction: "desc".into(),
            }],
            ..Default::default()
        },
        None,
    );
    time(
        "sort by priority, then title",
        &mut conn,
        ViewConfig {
            sorts: vec![
                ViewSort {
                    property_id: pri.id.clone(),
                    direction: "asc".into(),
                },
                ViewSort {
                    property_id: db.properties[0].id.clone(),
                    direction: "asc".into(),
                },
            ],
            ..Default::default()
        },
        None,
    );
    time(
        "nested filter + sort",
        &mut conn,
        ViewConfig {
            filter: Some(group(
                "and",
                vec![
                    filter(&pts, ">", json!(10)),
                    group(
                        "or",
                        vec![
                            filter(&pri, "=", json!(ids[2])),
                            filter(&due, "before", json!("2026-03-01")),
                        ],
                    ),
                ],
            )),
            sorts: vec![ViewSort {
                property_id: due.id.clone(),
                direction: "asc".into(),
            }],
            ..Default::default()
        },
        None,
    );
    let free_before: i64 = conn
        .query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .unwrap();
    let page_size: i64 = conn
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .unwrap();
    conn.execute_batch("DROP INDEX idx_db_value_cover").unwrap();
    let free_after: i64 = conn
        .query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .unwrap();
    println!(
        "covering index allocated bytes for 200k cells: {}",
        (free_after - free_before) * page_size
    );
}

// ---- relations and rollups ----

fn relate(
    conn: &mut Connection,
    from: &DatabaseDetail,
    to: &DatabaseDetail,
    name: &str,
    two_way: bool,
) -> Property {
    add(
        conn,
        from,
        name,
        "relation",
        Some(json!({ "targetDatabaseId": to.database.id, "twoWay": two_way })),
    )
}

fn links(r: &RecordRow, p: &Property) -> Vec<String> {
    r.values
        .get(&p.id)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|v| v["title"].as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn row(conn: &Connection, id: &str) -> RecordRow {
    load_rows(conn, &[id.to_string()]).unwrap().remove(0)
}

fn project_and_tasks(conn: &mut Connection, ws: &Workspace) -> (DatabaseDetail, DatabaseDetail) {
    let projects = create_database(
        conn,
        DatabaseCreate {
            workspace_id: ws.id.clone(),
            parent_page_id: None,
            title: Some("Projects".into()),
        },
    )
    .unwrap();
    let tasks = new_db(conn, ws);
    (projects, tasks)
}

fn prop_named(conn: &Connection, db: &DatabaseDetail, id: &str) -> Property {
    load_properties(conn, &db.database.id)
        .unwrap()
        .into_iter()
        .find(|p| p.id == id)
        .unwrap()
}

#[test]
fn two_way_relations_mirror_links_and_hide_trashed_records() {
    let (mut conn, ws) = setup();
    let (projects, tasks) = project_and_tasks(&mut conn, &ws);
    let rel = relate(&mut conn, &tasks, &projects, "Project", true);
    let reverse = prop_named(&conn, &projects, rel.config["reverseId"].as_str().unwrap());
    assert_eq!(reverse.name, "Tasks");
    assert_eq!(reverse.config["reverseId"], rel.id);

    let p1 = rec(&mut conn, &projects, "Alpha", json!({}));
    let p2 = rec(&mut conn, &projects, "Beta", json!({}));
    let t1 = rec(&mut conn, &tasks, "Write", json!({}));
    let out = set(&mut conn, &t1, &rel, json!([p1.id, p2.id])).unwrap();
    assert_eq!(links(&out, &rel), ["Alpha", "Beta"]);
    assert_eq!(links(&row(&conn, &p1.id), &reverse), ["Write"]);

    set(&mut conn, &t1, &rel, json!([p2.id])).unwrap();
    assert!(links(&row(&conn, &p1.id), &reverse).is_empty());
    assert_eq!(links(&row(&conn, &p2.id), &reverse), ["Write"]);

    set(&mut conn, &p1, &reverse, json!([t1.id])).unwrap();
    assert_eq!(links(&row(&conn, &t1.id), &rel), ["Beta", "Alpha"]);

    services::page::delete(&mut conn, &p2.page_id).unwrap();
    assert_eq!(links(&row(&conn, &t1.id), &rel), ["Alpha"]);
    services::page::restore(&mut conn, &p2.page_id).unwrap();
    assert_eq!(links(&row(&conn, &t1.id), &rel).len(), 2);
}

#[test]
fn relation_validation_and_filters() {
    let (mut conn, ws) = setup();
    let (projects, tasks) = project_and_tasks(&mut conn, &ws);
    let rel = relate(&mut conn, &tasks, &projects, "Project", false);
    assert!(rel.config["reverseId"].is_null());
    assert_eq!(
        load_properties(&conn, &projects.database.id).unwrap().len(),
        projects.properties.len(),
        "a one-way relation adds nothing to the target"
    );
    let t = rec(&mut conn, &tasks, "T", json!({}));
    let other_task = rec(&mut conn, &tasks, "U", json!({}));
    let p = rec(&mut conn, &projects, "P", json!({}));
    assert!(set(&mut conn, &t, &rel, json!([other_task.id])).is_err());
    assert!(set(&mut conn, &t, &rel, json!(["nope"])).is_err());
    assert!(set(&mut conn, &t, &rel, json!("x")).is_err());
    assert!(set(&mut conn, &t, &rel, json!([p.id, p.id])).is_ok());
    assert_eq!(links(&row(&conn, &t.id), &rel), ["P"]);

    for config in [json!({}), json!({ "targetDatabaseId": "missing" })] {
        let res = add_property(
            &mut conn,
            PropertyCreate {
                database_id: tasks.database.id.clone(),
                name: "Bad".into(),
                property_type: "relation".into(),
                config: Some(config),
            },
        );
        assert!(res.is_err());
    }

    let cfg = ViewConfig {
        sorts: vec![ViewSort {
            property_id: rel.id.clone(),
            direction: "asc".into(),
        }],
        ..Default::default()
    };
    assert!(view(&mut conn, &tasks, cfg).config.sorts.is_empty());
    assert_eq!(
        with_filter(&mut conn, &tasks, filter(&rel, "is_empty", Value::Null)),
        ["U"]
    );
    assert_eq!(
        with_filter(&mut conn, &tasks, filter(&rel, "is_not_empty", Value::Null)),
        ["T"]
    );
    assert_eq!(
        with_filter(&mut conn, &tasks, filter(&rel, "contains", json!(p.id))),
        ["T"]
    );
    assert_eq!(
        with_filter(&mut conn, &tasks, filter(&rel, "not_contains", json!(p.id))),
        ["U"]
    );
}

#[test]
fn self_relations_and_deleting_one_side() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let parent = relate(&mut conn, &db, &db, "Parent", true);
    let reverse_id = parent.config["reverseId"].as_str().unwrap().to_string();
    assert_eq!(
        load_properties(&conn, &db.database.id).unwrap().len(),
        db.properties.len() + 2
    );
    let a = rec(&mut conn, &db, "A", json!({}));
    let b = rec(&mut conn, &db, "B", json!({}));
    assert!(set(&mut conn, &a, &parent, json!([a.id])).is_err());
    set(&mut conn, &b, &parent, json!([a.id])).unwrap();
    let reverse = prop_named(&conn, &db, &reverse_id);
    assert_eq!(links(&row(&conn, &a.id), &reverse), ["B"]);

    delete_property(&mut conn, &parent.id).unwrap();
    let reverse = prop_named(&conn, &db, &reverse_id);
    assert!(reverse.config["reverseId"].is_null());
    assert_eq!(links(&row(&conn, &a.id), &reverse), ["B"]);
    set(&mut conn, &a, &reverse, json!([])).unwrap();
    assert!(links(&row(&conn, &a.id), &reverse).is_empty());
}

#[test]
fn relation_link_limit() {
    let (mut conn, ws) = setup();
    let (projects, tasks) = project_and_tasks(&mut conn, &ws);
    let rel = relate(&mut conn, &tasks, &projects, "Project", false);
    let t = rec(&mut conn, &tasks, "T", json!({}));
    let ids: Vec<String> = (0..=MAX_RELATION_LINKS)
        .map(|i| rec(&mut conn, &projects, &format!("P{i}"), json!({})).id)
        .collect();
    assert!(set(&mut conn, &t, &rel, json!(ids)).is_err());
    assert!(set(&mut conn, &t, &rel, json!(&ids[..MAX_RELATION_LINKS])).is_ok());
}

#[test]
fn rollups_summarize_linked_records() {
    let (mut conn, ws) = setup();
    let (projects, tasks) = project_and_tasks(&mut conn, &ws);
    let rel = relate(&mut conn, &projects, &tasks, "Tasks", true);
    let hours = add(&mut conn, &tasks, "Hours", "number", None);
    let done = add(&mut conn, &tasks, "Done", "checkbox", None);
    let due = add(&mut conn, &tasks, "Due", "date", None);
    let roll = |conn: &mut Connection, name: &str, target: &Property, f: &str| {
        add(
            conn,
            &projects,
            name,
            "rollup",
            Some(
                json!({ "relationPropertyId": rel.id, "targetPropertyId": target.id, "function": f }),
            ),
        )
    };
    let count = roll(&mut conn, "N", &hours, "count");
    let sum = roll(&mut conn, "Sum", &hours, "sum");
    let avg = roll(&mut conn, "Avg", &hours, "average");
    let max = roll(&mut conn, "Max", &hours, "max");
    let pct = roll(&mut conn, "Pct", &done, "percent_checked");
    let first = roll(&mut conn, "First", &due, "earliest");
    let uniq = roll(&mut conn, "Uniq", &hours, "count_unique");

    let p = rec(&mut conn, &projects, "P", json!({}));
    let empty = rec(&mut conn, &projects, "Empty", json!({}));
    let t1 = rec(
        &mut conn,
        &tasks,
        "T1",
        json!({ hours.id.clone(): 2, done.id.clone(): true, due.id.clone(): { "start": "2026-03-05" } }),
    );
    let t2 = rec(
        &mut conn,
        &tasks,
        "T2",
        json!({ hours.id.clone(): 4, due.id.clone(): { "start": "2026-02-01" } }),
    );
    let t3 = rec(&mut conn, &tasks, "T3", json!({ hours.id.clone(): 4 }));
    set(&mut conn, &p, &rel, json!([t1.id, t2.id, t3.id])).unwrap();
    let r = row(&conn, &p.id);
    assert_eq!(r.values[&count.id], json!(3));
    assert_eq!(r.values[&sum.id], json!(10.0));
    assert!((r.values[&avg.id].as_f64().unwrap() - 10.0 / 3.0).abs() < 1e-9);
    assert_eq!(r.values[&max.id], json!(4.0));
    assert!((r.values[&pct.id].as_f64().unwrap() - 100.0 / 3.0).abs() < 1e-9);
    assert_eq!(r.values[&first.id], json!("2026-02-01"));
    assert_eq!(r.values[&uniq.id], json!(2));

    let e = row(&conn, &empty.id);
    assert_eq!(e.values[&count.id], json!(0));
    assert!(!e.values.contains_key(&avg.id) && !e.values.contains_key(&pct.id));

    services::page::delete(&mut conn, &t1.page_id).unwrap();
    assert_eq!(row(&conn, &p.id).values[&count.id], json!(2));

    assert!(set(&mut conn, &p, &sum, json!(5)).is_err());
    assert_eq!(
        with_filter(&mut conn, &projects, filter(&sum, ">", json!(5))),
        ["P"]
    );
    assert_eq!(
        with_filter(&mut conn, &projects, filter(&sum, "<", json!(5))),
        ["Empty"]
    );

    let attempt = |conn: &mut Connection, target: &Property, f: &str| {
        add_property(
            conn,
            PropertyCreate {
                database_id: projects.database.id.clone(),
                name: "X".into(),
                property_type: "rollup".into(),
                config: Some(
                    json!({ "relationPropertyId": rel.id, "targetPropertyId": target.id, "function": f }),
                ),
            },
        )
    };
    assert!(attempt(&mut conn, &done, "sum").is_err());
    assert!(attempt(&mut conn, &hours, "earliest").is_err());
    assert!(attempt(&mut conn, &hours, "percent_checked").is_err());
    assert!(attempt(&mut conn, &hours, "median").is_err());
    let own = add(&mut conn, &projects, "Own", "number", None);
    assert!(attempt(&mut conn, &own, "sum").is_err());
    assert!(attempt(&mut conn, &sum, "sum").is_err());
}

#[test]
fn lookup_finds_records_by_title() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let a = rec(&mut conn, &db, "Apple pie", json!({}));
    rec(&mut conn, &db, "Banana", json!({}));
    rec(&mut conn, &db, "Pineapple", json!({}));
    services::page::delete(&mut conn, &a.page_id).unwrap();
    let hit = |q: &str| -> Vec<String> {
        relations::lookup(
            &conn,
            &RecordLookup {
                database_id: db.database.id.clone(),
                query: q.into(),
                limit: None,
            },
        )
        .unwrap()
        .into_iter()
        .map(|r| r.title)
        .collect()
    };
    assert_eq!(hit("apple"), ["Pineapple"]);
    assert_eq!(hit("").len(), 2);
    assert!(hit("%").is_empty());
}

// ---- formulas ----

fn ev(src: &str) -> Value {
    use super::formula::{self, Env, Val};
    let expr = formula::parse(src).unwrap().expect("an expression");
    let now = chrono::NaiveDate::from_ymd_opt(2026, 3, 15)
        .unwrap()
        .and_hms_opt(9, 30, 0)
        .unwrap();
    let get = |_: &str| Val::Empty;
    formula::eval(&expr, &Env { now, get: &get })
        .to_json()
        .unwrap_or(Value::Null)
}

#[test]
fn formula_language_arithmetic_text_logic_and_dates() {
    assert_eq!(ev("1 + 2 * 3"), json!(7.0));
    assert_eq!(ev("(1 + 2) * 3"), json!(9.0));
    assert_eq!(ev("-2 * -3"), json!(6.0));
    assert_eq!(ev("10 % 4"), json!(2.0));
    assert_eq!(ev("round(2.456, 2)"), json!(2.46));
    assert_eq!(ev("floor(2.9) + ceil(2.1)"), json!(5.0));
    assert_eq!(ev("abs(-4) + min(3, 1, 2) + max(1, 5)"), json!(10.0));
    assert_eq!(ev("\"a\" + \"b\""), json!("ab"));
    assert_eq!(ev("\"n=\" + 3"), json!("n=3"));
    assert_eq!(ev("concat(\"x\", 1.5, true)"), json!("x1.5true"));
    assert_eq!(ev("length(\"héllo\")"), json!(5.0));
    assert_eq!(ev("contains(\"Hello\", \"ELL\")"), json!(true));
    assert_eq!(ev("1 < 2 && 2 < 3"), json!(true));
    assert_eq!(ev("1 > 2 || !false"), json!(true));
    assert_eq!(ev("1 > 2 or not true"), json!(false));
    assert_eq!(ev("\"a\" == \"A\""), json!(true));
    assert_eq!(ev("if(1 < 2, \"yes\", \"no\")"), json!("yes"));
    assert_eq!(ev("ifs(1 > 2, \"a\", 2 > 3, \"b\", \"c\")"), json!("c"));
    assert_eq!(ev("empty(\"\")"), json!(true));
    assert_eq!(ev("toNumber(\"1,234.5\")"), json!(1234.5));
    assert_eq!(ev("today()"), json!({ "start": "2026-03-15" }));
    assert_eq!(ev("now()"), json!({ "start": "2026-03-15T09:30" }));
    assert_eq!(
        ev("dateAdd(today(), 1, \"months\")"),
        json!({ "start": "2026-04-15" })
    );
    assert_eq!(
        ev("dateSubtract(today(), 2, \"weeks\")"),
        json!({ "start": "2026-03-01" })
    );
    assert_eq!(
        ev("dateAdd(today(), 90, \"minutes\")"),
        json!({ "start": "2026-03-15T01:30" })
    );
    assert_eq!(
        ev("formatDate(today(), \"MMM D YYYY\")"),
        json!("Mar D 2026")
    );
    assert_eq!(
        ev("formatDate(now(), \"YYYY-MM-DD HH:mm\")"),
        json!("2026-03-15 09:30")
    );
    // Short-circuiting keeps a bad right side from running.
    assert_eq!(ev("false && 1 / 0 > 1"), json!(false));
}

#[test]
fn formula_runtime_errors_are_values_not_failures() {
    assert_eq!(ev("1 / 0"), json!({ "error": "#ERROR" }));
    assert_eq!(ev("round(1, 2) + (10 % 0)"), json!({ "error": "#ERROR" }));
    assert_eq!(ev("length(5)"), json!({ "error": "#TYPE" }));
    assert_eq!(ev("1 < \"a\""), json!({ "error": "#TYPE" }));
}

#[test]
fn formula_syntax_errors_carry_positions() {
    use super::formula;
    let e = formula::parse("1 + ").unwrap_err();
    assert_eq!(e.position, 4);
    assert_eq!(formula::parse("round(1,").unwrap_err().position, 8);
    assert!(formula::parse("\"open").is_err());
    assert!(formula::parse("1 $ 2").unwrap_err().message.contains('$'));
    assert!(
        formula::parse("Price * 2").is_err(),
        "bare names must use prop()"
    );
    assert!(formula::parse("prop(1)").is_err());
    assert!(formula::parse(&"(".repeat(200)).is_err());
    assert!(formula::parse(&"1+".repeat(1500)).is_err(), "length limit");
    assert!(formula::parse("   ").unwrap().is_none());
    assert_eq!(
        formula::rename_refs("prop(\"A b\") + prop(\"a B\") + prop(\"C\")", "a b", "Z\"q"),
        "prop(\"Z\\\"q\") + prop(\"Z\\\"q\") + prop(\"C\")"
    );
}

fn formula_prop(
    conn: &mut Connection,
    db: &DatabaseDetail,
    name: &str,
    expr: &str,
) -> Result<Property, AppError> {
    add_property(
        conn,
        PropertyCreate {
            database_id: db.database.id.clone(),
            name: name.into(),
            property_type: "formula".into(),
            config: Some(json!({ "expression": expr })),
        },
    )
}

#[test]
fn formula_properties_compute_rename_and_survive_deleted_references() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let price = add(&mut conn, &db, "Price", "number", None);
    let qty = add(&mut conn, &db, "Qty", "number", None);
    let total = formula_prop(&mut conn, &db, "Total", "prop(\"Price\") * prop(\"Qty\")").unwrap();
    assert_eq!(total.config["resultType"], "number");
    let label = formula_prop(
        &mut conn,
        &db,
        "Label",
        "prop(\"Name\") + \": \" + format(prop(\"Total\"))",
    )
    .unwrap();
    assert_eq!(label.config["resultType"], "text");
    let a = rec(
        &mut conn,
        &db,
        "Widget",
        json!({ price.id.clone(): 2.5, qty.id.clone(): 4 }),
    );
    let b = rec(&mut conn, &db, "Empty", json!({}));
    let r = row(&conn, &a.id);
    assert_eq!(r.values[&total.id], json!(10.0));
    assert_eq!(r.values[&label.id], json!("Widget: 10"));
    assert!(
        !row(&conn, &b.id).values.contains_key(&total.id)
            || row(&conn, &b.id).values[&total.id].get("error").is_some()
    );

    // Formulas cannot be edited as cells.
    assert!(set(&mut conn, &a, &total, json!(1)).is_err());

    // Renaming a property rewrites formulas that refer to it.
    update_property(
        &mut conn,
        PropertyUpdate {
            id: price.id.clone(),
            name: Some("Cost".into()),
            config: None,
            position: None,
        },
    )
    .unwrap();
    let total_now = load_properties(&conn, &db.database.id)
        .unwrap()
        .into_iter()
        .find(|p| p.id == total.id)
        .unwrap();
    assert_eq!(
        total_now.config["expression"],
        "prop(\"Cost\") * prop(\"Qty\")"
    );
    assert_eq!(row(&conn, &a.id).values[&total.id], json!(10.0));

    // Editing an expression revalidates it and refreshes the type.
    let edited = update_property(
        &mut conn,
        PropertyUpdate {
            id: total.id.clone(),
            name: None,
            config: Some(json!({ "expression": "prop(\"Cost\") > 1" })),
            position: None,
        },
    )
    .unwrap();
    assert_eq!(edited.config["resultType"], "bool");
    let label_now = load_properties(&conn, &db.database.id)
        .unwrap()
        .into_iter()
        .find(|p| p.id == label.id)
        .unwrap();
    assert_eq!(label_now.config["resultType"], "text");
    assert_eq!(row(&conn, &a.id).values[&total.id], json!(true));

    // Deleting a referenced property leaves #REF behind instead of breaking loads.
    delete_property(&mut conn, &qty.id).unwrap();
    update_property(
        &mut conn,
        PropertyUpdate {
            id: label.id.clone(),
            name: None,
            config: Some(json!({ "expression": "prop(\"Cost\") + 1" })),
            position: None,
        },
    )
    .unwrap();
    delete_property(&mut conn, &price.id).unwrap();
    assert_eq!(
        row(&conn, &a.id).values[&label.id],
        json!({ "error": "#REF" })
    );
}

#[test]
fn formulas_are_checked_when_saved() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    add(&mut conn, &db, "Price", "number", None);
    add(&mut conn, &db, "Done", "checkbox", None);
    for (src, why) in [
        ("prop(\"Nope\") + 1", "unknown property"),
        ("prop(\"Price\") + ", "syntax"),
        ("prop(\"Done\") * 2", "boolean times number"),
        ("if(prop(\"Price\"), 1, 2)", "condition must be boolean"),
        ("frobnicate(1)", "unknown function"),
        ("round()", "arity"),
        ("dateAdd(today(), 1, \"fortnights\")", "bad unit"),
        ("length(prop(\"Price\"))", "length of a number"),
        ("prop(\"Price\") == \"x\"", "mismatched comparison"),
    ] {
        let res = formula_prop(&mut conn, &db, "F", src);
        assert!(matches!(res, Err(AppError::Validation(_))), "{why}: {src}");
    }
    let err = formula_prop(&mut conn, &db, "F", "1 +\n  $").unwrap_err();
    assert!(err.to_string().contains("line 2, column 3"), "{err}");

    // Self reference and circles are rejected; chains are fine.
    let a = formula_prop(&mut conn, &db, "A", "1").unwrap();
    let b = formula_prop(&mut conn, &db, "B", "prop(\"A\") + 1").unwrap();
    let edit = |conn: &mut Connection, p: &Property, src: &str| {
        update_property(
            conn,
            PropertyUpdate {
                id: p.id.clone(),
                name: None,
                config: Some(json!({ "expression": src })),
                position: None,
            },
        )
    };
    assert!(edit(&mut conn, &a, "prop(\"A\")").is_err());
    assert!(edit(&mut conn, &a, "prop(\"B\")").is_err());
    assert!(edit(&mut conn, &a, "5").is_ok());
    assert_eq!(b.config["resultType"], "number");
    assert!(
        formula_prop(&mut conn, &db, "Empty", "").is_ok(),
        "an empty formula is allowed"
    );
}

#[test]
fn formulas_and_rollups_filter_and_sort_in_memory() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let n = add(&mut conn, &db, "N", "number", None);
    let double = formula_prop(&mut conn, &db, "Double", "prop(\"N\") * 2").unwrap();
    let big = formula_prop(&mut conn, &db, "Big", "prop(\"N\") >= 3").unwrap();
    let tag = formula_prop(
        &mut conn,
        &db,
        "Tag",
        "if(prop(\"N\") >= 3, \"high\", \"low\")",
    )
    .unwrap();
    for (t, v) in [("a", 1), ("b", 5), ("c", 3)] {
        rec(&mut conn, &db, t, json!({ n.id.clone(): v }));
    }
    rec(&mut conn, &db, "d", json!({}));
    assert_eq!(
        with_filter(&mut conn, &db, filter(&double, ">", json!(5))),
        ["b", "c"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&big, "=", json!(true))),
        ["b", "c"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&tag, "=", json!("low"))),
        ["a", "d"]
    );
    assert_eq!(
        with_filter(&mut conn, &db, filter(&double, "is_empty", Value::Null)),
        ["d"]
    );
    assert_eq!(
        with_sort(&mut conn, &db, &double, "desc"),
        ["b", "c", "a", "d"]
    );
    assert_eq!(
        with_sort(&mut conn, &db, &double, "asc"),
        ["a", "c", "b", "d"]
    );
    // Combined with ordinary conditions.
    let f = group(
        "and",
        vec![filter(&double, ">", json!(1)), filter(&n, "<", json!(5))],
    );
    assert_eq!(with_filter(&mut conn, &db, f), ["a", "c"]);
    // Grouping by calculated values is not offered.
    let cfg = ViewConfig {
        group: Some(GroupSpec {
            property_id: big.id.clone(),
            bucket: None,
        }),
        ..Default::default()
    };
    assert!(update_view(
        &mut conn,
        ViewUpdate {
            name: None,
            view_id: db.views[0].id.clone(),
            config: cfg
        }
    )
    .is_err());
}

#[test]
fn formula_preview_reports_errors_and_samples() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let n = add(&mut conn, &db, "N", "number", None);
    rec(&mut conn, &db, "one", json!({ n.id.clone(): 1 }));
    rec(&mut conn, &db, "two", json!({ n.id.clone(): 2 }));
    let preview = |conn: &Connection, src: &str| {
        formula_preview(
            conn,
            &FormulaPreviewInput {
                database_id: db.database.id.clone(),
                property_id: None,
                expression: src.into(),
            },
        )
        .unwrap()
    };
    let ok = preview(&conn, "prop(\"N\") * 10");
    assert_eq!(ok.result_type.as_deref(), Some("number"));
    assert_eq!(ok.samples.len(), 2);
    assert_eq!(ok.samples[1].value, Some(json!(20.0)));
    let syntax = preview(&conn, "prop(\"N\") *");
    assert!(syntax.error.is_some() && syntax.samples.is_empty());
    assert!(preview(&conn, "prop(\"Missing\")").error.is_some());
    assert!(preview(&conn, "").error.is_none());
}

#[test]
fn calculated_filters_refuse_huge_databases() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let f = formula_prop(&mut conn, &db, "F", "1").unwrap();
    {
        let tx = conn.transaction().unwrap();
        let (ws_id, page_id): (String, String) = tx
            .query_row(
                "SELECT workspace_id, page_id FROM db_database WHERE id = ?1",
                [&db.database.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        for i in 0..(calc::MAX_CALC_RECORDS + 1) {
            let pid = format!("p{i}");
            tx.execute("INSERT INTO page (id, workspace_id, parent_page_id, title, position, created_at, updated_at, kind) VALUES (?1, ?2, ?3, 't', 0, 'x', 'x', 'record')", params![pid, ws_id, page_id]).unwrap();
            tx.execute("INSERT INTO db_record (id, database_id, page_id, unique_id, created_at) VALUES (?1, ?2, ?1, ?3, 'x')", params![pid, db.database.id, i]).unwrap();
        }
        tx.commit().unwrap();
    }
    let cfg = ViewConfig {
        filter: Some(filter(&f, "=", json!(1))),
        ..Default::default()
    };
    let saved = view(&mut conn, &db, cfg);
    let res = query_records(
        &conn,
        &RecordQuery {
            extra_filter: None,
            database_id: db.database.id.clone(),
            view_id: Some(saved.id),
            group_key: None,
            subgroup_key: None,
            cursor: None,
            limit: None,
            skip_total: false,
            range: None,
        },
    );
    assert!(matches!(res, Err(AppError::Validation(m)) if m.contains("10000")));
}

// ---- calendar, timeline and gallery support ----

fn in_range(
    conn: &Connection,
    db: &DatabaseDetail,
    p: &Property,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<String>, AppError> {
    let page = query_records(
        conn,
        &RecordQuery {
            extra_filter: None,
            database_id: db.database.id.clone(),
            view_id: None,
            group_key: None,
            subgroup_key: None,
            cursor: None,
            limit: None,
            skip_total: false,
            range: Some(RecordRange {
                property_id: p.id.clone(),
                from: from.map(String::from),
                to: to.map(String::from),
            }),
        },
    )?;
    assert!(page.total.is_none(), "windowed queries are not counted");
    Ok(page.rows.into_iter().map(|r| r.title).collect())
}

#[test]
fn date_windows_include_overlapping_ranges_and_undated_records() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let when = add(&mut conn, &db, "When", "date", None);
    let other = add(&mut conn, &db, "Other", "date", None);
    let day = |s: &str| json!({ "start": s });
    rec(
        &mut conn,
        &db,
        "before",
        json!({ when.id.clone(): day("2026-02-27") }),
    );
    rec(
        &mut conn,
        &db,
        "first",
        json!({ when.id.clone(): day("2026-03-01") }),
    );
    rec(
        &mut conn,
        &db,
        "timed",
        json!({ when.id.clone(): day("2026-03-10T14:30") }),
    );
    rec(
        &mut conn,
        &db,
        "last",
        json!({ when.id.clone(): day("2026-03-31") }),
    );
    rec(
        &mut conn,
        &db,
        "after",
        json!({ when.id.clone(): day("2026-04-01") }),
    );
    rec(
        &mut conn,
        &db,
        "spans in",
        json!({ when.id.clone(): { "start": "2026-02-20", "end": "2026-03-02" } }),
    );
    rec(
        &mut conn,
        &db,
        "spans over",
        json!({ when.id.clone(): { "start": "2026-01-01", "end": "2026-12-31" } }),
    );
    rec(
        &mut conn,
        &db,
        "spans out",
        json!({ when.id.clone(): { "start": "2026-02-01", "end": "2026-02-28" } }),
    );
    rec(&mut conn, &db, "undated", json!({}));
    let mut march = in_range(&conn, &db, &when, Some("2026-03-01"), Some("2026-03-31")).unwrap();
    march.sort();
    assert_eq!(march, ["first", "last", "spans in", "spans over", "timed"]);
    assert_eq!(
        in_range(&conn, &db, &when, None, None).unwrap(),
        ["undated"]
    );
    assert_eq!(
        in_range(&conn, &db, &other, Some("2026-03-01"), Some("2026-03-31"))
            .unwrap()
            .len(),
        0
    );
    assert!(
        in_range(
            &conn,
            &db,
            &db.properties[0],
            Some("2026-03-01"),
            Some("2026-03-31")
        )
        .is_err(),
        "not a date property"
    );
    assert!(in_range(&conn, &db, &when, Some("March"), Some("2026-03-31")).is_err());
}

#[test]
fn previews_show_the_first_image_else_the_first_text() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let plain = rec(&mut conn, &db, "Plain", json!({}));
    let pictured = rec(&mut conn, &db, "Pictured", json!({}));
    let empty = rec(&mut conn, &db, "Empty", json!({}));
    let block = |conn: &Connection,
                 page: &str,
                 kind: &str,
                 pos: f64,
                 parent: Option<&str>,
                 data: Value| {
        conn.execute(
            "INSERT INTO block (id, page_id, parent_block_id, type, position, data_json, schema_version, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 2, 'x', 'x')",
            params![new_id(), page, parent, kind, pos, data.to_string()],
        )
        .unwrap();
    };
    let long = "word ".repeat(80);
    block(&conn, &plain.page_id, "divider", 1.0, None, json!({}));
    block(
        &conn,
        &plain.page_id,
        "paragraph",
        2.0,
        None,
        json!({ "content": [{ "type": "text", "text": long }] }),
    );
    block(
        &conn,
        &pictured.page_id,
        "paragraph",
        1.0,
        None,
        json!({ "content": [{ "type": "text", "text": "caption" }] }),
    );
    block(
        &conn,
        &pictured.page_id,
        "image",
        2.0,
        None,
        json!({ "attachment": { "id": "a", "hash": "abc123", "name": "cat.png" } }),
    );
    let got = previews::previews(
        &conn,
        &[plain.id.clone(), pictured.id.clone(), empty.id.clone()],
    )
    .unwrap();
    assert_eq!(got.len(), 3);
    let text = got[0].text.as_deref().unwrap();
    assert!(text.starts_with("word word") && text.ends_with('…') && text.chars().count() <= 161);
    assert!(got[0].image_hash.is_none());
    assert_eq!(got[1].image_hash.as_deref(), Some("abc123"));
    assert_eq!(got[1].image_name.as_deref(), Some("cat.png"));
    assert!(got[1].text.is_none());
    assert!(got[2].image_hash.is_none() && got[2].text.is_none());
    assert!(previews::previews(&conn, &["nope".to_string()]).is_err());
    assert!(previews::previews(&conn, &vec![plain.id.clone(); 101]).is_err());
}

// ---- project-management templates ----

fn from_template(
    conn: &mut Connection,
    ws: &Workspace,
    id: &str,
    sample: bool,
) -> templates::TemplateResult {
    templates::create_from_template(
        conn,
        templates::TemplateCreate {
            workspace_id: ws.id.clone(),
            parent_page_id: None,
            template: id.into(),
            sample_data: sample,
        },
    )
    .unwrap()
}

fn detail_of(conn: &Connection, page_id: &str) -> DatabaseDetail {
    database_detail_by_page(conn, page_id).unwrap()
}

fn all_rows(conn: &Connection, d: &DatabaseDetail, view: &DbView) -> Vec<RecordRow> {
    let mut out = Vec::new();
    let keys: Vec<(Option<String>, Option<String>)> = if view.config.group.is_some() {
        group_counts(
            conn,
            &GroupCountsQuery {
                extra_filter: None,
                database_id: d.database.id.clone(),
                view_id: Some(view.id.clone()),
            },
        )
        .unwrap()
        .into_iter()
        .map(|g| (Some(g.key), None))
        .collect()
    } else {
        vec![(None, None)]
    };
    for (g, s) in keys {
        let page = query_records(
            conn,
            &RecordQuery {
                extra_filter: None,
                database_id: d.database.id.clone(),
                view_id: Some(view.id.clone()),
                group_key: g,
                subgroup_key: s,
                cursor: None,
                limit: Some(200),
                skip_total: true,
                range: None,
            },
        );
        out.extend(page.unwrap().rows);
    }
    out
}

fn by_title(rows: &[RecordRow], title: &str) -> RecordRow {
    rows.iter()
        .find(|r| r.title == title)
        .cloned()
        .unwrap_or_else(|| panic!("no record {title}"))
}

#[test]
fn project_manager_builds_linked_databases_with_working_views() {
    let (mut conn, ws) = setup();
    let made = from_template(&mut conn, &ws, "project_manager", true);
    assert_eq!(made.database_page_ids.len(), 4);
    let root = repo::page::get(&conn, &made.page_id).unwrap().unwrap();
    assert_eq!(
        (root.title.as_str(), root.kind.as_str()),
        ("Project Manager", "page")
    );
    let [projects, milestones, sprints, tasks] = made
        .database_page_ids
        .iter()
        .map(|p| detail_of(&conn, p))
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    let stored_workspace = repo::workspace::get(&conn, &ws.id).unwrap().unwrap();
    let settings: Value = serde_json::from_str(&stored_workspace.settings_json).unwrap();
    assert!(settings["projectTaskRelationIds"]
        .as_array()
        .unwrap()
        .contains(&json!(
            tasks
                .properties
                .iter()
                .find(|p| p.name == "Project")
                .unwrap()
                .id
        )));
    for d in [&projects, &milestones, &sprints, &tasks] {
        assert_eq!(
            d.page.parent_page_id.as_deref(),
            Some(made.page_id.as_str())
        );
    }
    let names = |d: &DatabaseDetail| {
        d.properties
            .iter()
            .map(|p| p.name.clone())
            .collect::<Vec<_>>()
    };
    for n in [
        "Status",
        "Dates",
        "Owner",
        "Tasks",
        "Milestones",
        "Progress",
    ] {
        assert!(names(&projects).contains(&n.to_string()), "Projects.{n}");
    }
    for n in [
        "Project",
        "Milestone",
        "Sprint",
        "Parent",
        "Subtasks",
        "Blocked by",
        "Blocking",
        "Subtask progress",
        "Blocked",
        "Priority",
        "Status",
        "Dates",
    ] {
        assert!(names(&tasks).contains(&n.to_string()), "Tasks.{n}");
    }
    let view_names =
        |d: &DatabaseDetail| d.views.iter().map(|v| v.name.clone()).collect::<Vec<_>>();
    assert_eq!(
        view_names(&tasks),
        [
            "All tasks",
            "Board",
            "Backlog",
            "Current sprint",
            "Calendar",
            "Timeline"
        ]
    );
    assert_eq!(view_names(&projects), ["All projects", "Board", "Timeline"]);

    // Every saved view of every database can be queried.
    for d in [&projects, &milestones, &sprints, &tasks] {
        for v in &d.views {
            let rows = all_rows(&conn, d, v);
            assert!(rows.len() <= 20, "{} / {}", d.page.title, v.name);
        }
    }

    // Progress counts tasks whose status is in the Done group.
    let rows = all_rows(&conn, &projects, &projects.views[0]);
    let web = by_title(&rows, "Website relaunch");
    let progress = projects
        .properties
        .iter()
        .find(|p| p.name == "Progress")
        .unwrap();
    assert!((web.values[&progress.id].as_f64().unwrap() - 25.0).abs() < 1e-9);
    let sprint_rows = all_rows(&conn, &sprints, &sprints.views[0]);
    assert!(sprint_rows.iter().all(|r| r.values.contains_key(
        &sprints
            .properties
            .iter()
            .find(|p| p.name == "Progress")
            .unwrap()
            .id
    )));

    // Subtasks, dependencies and the Blocked formula.
    let task_rows = all_rows(&conn, &tasks, &tasks.views[0]);
    let p = |n: &str| {
        tasks
            .properties
            .iter()
            .find(|p| p.name == n)
            .unwrap()
            .id
            .clone()
    };
    let home = by_title(&task_rows, "Design homepage");
    assert!((home.values[&p("Subtask progress")].as_f64().unwrap() - 50.0).abs() < 1e-9);
    assert_eq!(
        links(
            &home,
            tasks
                .properties
                .iter()
                .find(|x| x.name == "Subtasks")
                .unwrap()
        )
        .len(),
        2
    );
    assert_eq!(
        by_title(&task_rows, "Build page templates").values[&p("Blocked")],
        json!(true)
    );
    assert_eq!(
        by_title(&task_rows, "Design article page").values[&p("Blocked")],
        json!(false)
    );
    assert_eq!(
        by_title(&task_rows, "Hero section").values[&p("Blocked")],
        json!(false)
    );

    // Backlog: no sprint and not done.
    let backlog = tasks.views.iter().find(|v| v.name == "Backlog").unwrap();
    let mut titles: Vec<String> = all_rows(&conn, &tasks, backlog)
        .into_iter()
        .map(|r| r.title)
        .collect();
    titles.sort();
    assert_eq!(
        titles,
        ["Pick tech stack", "Set up analytics", "Write launch copy"]
    );
    // Current sprint: any task with a sprint, grouped by status.
    let sprint = tasks
        .views
        .iter()
        .find(|v| v.name == "Current sprint")
        .unwrap();
    assert_eq!(all_rows(&conn, &tasks, sprint).len(), 7);
}

#[test]
fn other_templates_and_options() {
    let (mut conn, ws) = setup();
    let tracker = from_template(&mut conn, &ws, "task_tracker", true);
    assert_eq!(tracker.database_page_ids.len(), 1);
    let t = detail_of(&conn, &tracker.database_page_ids[0]);
    assert!(t.properties.iter().all(|p| p.name != "Project"));
    assert_eq!(all_rows(&conn, &t, &t.views[0]).len(), 5);
    for v in &t.views {
        all_rows(&conn, &t, v);
    }

    let software = from_template(&mut conn, &ws, "software_project", true);
    let tasks = detail_of(&conn, &software.database_page_ids[3]);
    assert!(tasks.properties.iter().any(|p| p.name == "Type"));
    let bugs = tasks.views.iter().find(|v| v.name == "Bugs").unwrap();
    assert_eq!(
        all_rows(&conn, &tasks, bugs)
            .iter()
            .map(|r| r.title.as_str())
            .collect::<Vec<_>>(),
        ["Fix broken navigation link"]
    );

    // Without sample data the databases are empty but fully set up.
    let bare = from_template(&mut conn, &ws, "project_manager", false);
    for p in &bare.database_page_ids {
        let d = detail_of(&conn, p);
        for v in &d.views {
            assert!(all_rows(&conn, &d, v).is_empty());
        }
    }
    // Templates can be created repeatedly, under any normal page.
    let parent = rec_page(&mut conn, &ws, "Work");
    let nested = templates::create_from_template(
        &mut conn,
        templates::TemplateCreate {
            workspace_id: ws.id.clone(),
            parent_page_id: Some(parent.clone()),
            template: "task_tracker".into(),
            sample_data: false,
        },
    )
    .unwrap();
    assert_eq!(
        repo::page::get(&conn, &nested.page_id)
            .unwrap()
            .unwrap()
            .parent_page_id
            .as_deref(),
        Some(parent.as_str())
    );
}

fn rec_page(conn: &mut Connection, ws: &Workspace, title: &str) -> String {
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
    .id
}

#[test]
fn bad_template_requests_create_nothing() {
    let (mut conn, ws) = setup();
    let count = |conn: &Connection| -> i64 {
        conn.query_row("SELECT COUNT(*) FROM page", [], |r| r.get(0))
            .unwrap()
    };
    let before = count(&conn);
    let attempt = |conn: &mut Connection, template: &str, parent: Option<&str>, workspace: &str| {
        templates::create_from_template(
            conn,
            templates::TemplateCreate {
                workspace_id: workspace.into(),
                parent_page_id: parent.map(String::from),
                template: template.into(),
                sample_data: true,
            },
        )
    };
    assert!(attempt(&mut conn, "nope", None, &ws.id).is_err());
    assert!(attempt(&mut conn, "task_tracker", Some("not-an-id"), &ws.id).is_err());
    assert!(attempt(&mut conn, "task_tracker", Some(&new_id()), &ws.id).is_err());
    assert!(attempt(&mut conn, "task_tracker", None, &new_id()).is_err());
    // A database page cannot hold the template.
    let db = new_db(&mut conn, &ws);
    let with_db = count(&conn);
    assert!(attempt(&mut conn, "task_tracker", Some(&db.page.id), &ws.id).is_err());
    assert_eq!(count(&conn), with_db);
    assert!(with_db > before);
}

#[test]
fn percent_done_counts_the_done_status_group() {
    let (mut conn, ws) = setup();
    let (projects, tasks) = project_and_tasks(&mut conn, &ws);
    let status = add(&mut conn, &tasks, "Status", "status", None);
    let rel = relate(&mut conn, &projects, &tasks, "Tasks", true);
    let roll = |conn: &mut Connection, target: &Property| {
        add_property(
            conn,
            PropertyCreate {
                database_id: projects.database.id.clone(),
                name: "Done %".into(),
                property_type: "rollup".into(),
                config: Some(
                    json!({ "relationPropertyId": rel.id, "targetPropertyId": target.id, "function": "percent_done" }),
                ),
            },
        )
    };
    assert!(
        roll(&mut conn, &tasks.properties[0]).is_err(),
        "only a status property can be summarized"
    );
    let progress = roll(&mut conn, &status).unwrap();
    let p = rec(&mut conn, &projects, "P", json!({}));
    let todo = opt(&status, "Not started");
    let done = opt(&status, "Done");
    let t1 = rec(&mut conn, &tasks, "a", json!({ status.id.clone(): done }));
    let t2 = rec(&mut conn, &tasks, "b", json!({ status.id.clone(): todo }));
    let t3 = rec(&mut conn, &tasks, "c", json!({}));
    let t4 = rec(&mut conn, &tasks, "d", json!({ status.id.clone(): done }));
    assert!(
        !row(&conn, &p.id).values.contains_key(&progress.id),
        "no tasks, no progress"
    );
    set(&mut conn, &p, &rel, json!([t1.id, t2.id, t3.id, t4.id])).unwrap();
    assert_eq!(row(&conn, &p.id).values[&progress.id], json!(50.0));
}

// ---------------------------------------------------------------------------------------------
// charts, forms, feed and record templates (Phase 8)
// ---------------------------------------------------------------------------------------------

use super::charts;
use super::forms;
use super::record_templates as rtpl;

fn chart_view(conn: &mut Connection, db: &DatabaseDetail, spec: ChartSpec) -> DbView {
    mk_view(
        conn,
        db,
        "chart",
        Some(ViewConfig {
            chart: Some(spec),
            ..Default::default()
        }),
    )
}

fn chart(conn: &Connection, db: &DatabaseDetail, view: &DbView) -> ChartData {
    charts::data(
        conn,
        &ChartQuery {
            database_id: db.database.id.clone(),
            view_id: Some(view.id.clone()),
            chart: None,
            filter: None,
        },
    )
    .unwrap()
}

/// (x, series, value, count) for easy comparison.
type FlatPoint = (Option<String>, Option<String>, Option<f64>, i64);

fn flat(d: &ChartData) -> Vec<FlatPoint> {
    d.points
        .iter()
        .map(|p| (p.x.clone(), p.group.clone(), p.value, p.count))
        .collect()
}

struct Sales {
    conn: Connection,
    db: DatabaseDetail,
    status: Property,
    team: Property,
    amount: Property,
    when: Property,
}

fn sales() -> Sales {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let status = select(&mut conn, &db, "Status", "status", &["Open", "Won", "Lost"]);
    let team = select(&mut conn, &db, "Team", "select", &["North", "South"]);
    let amount = add(&mut conn, &db, "Amount", "number", None);
    let when = add(&mut conn, &db, "Closed", "date", None);
    let rows = [
        ("A", "Open", "North", 100.0, "2026-01-05"),
        ("B", "Won", "North", 300.0, "2026-01-20"),
        ("C", "Won", "South", 50.0, "2026-02-02"),
        ("D", "Lost", "South", 25.0, "2026-02-10"),
        ("E", "Won", "South", 150.0, "2026-02-11"),
    ];
    for (t, s, tm, a, d) in rows {
        rec(
            &mut conn,
            &db,
            t,
            json!({
                status.id.clone(): opt(&status, s),
                team.id.clone(): opt(&team, tm),
                amount.id.clone(): a,
                when.id.clone(): { "start": d },
            }),
        );
    }
    rec(&mut conn, &db, "F", json!({})); // nothing filled in
    Sales {
        conn,
        db,
        status,
        team,
        amount,
        when,
    }
}

fn spec(kind: &str, x: Option<&Property>, agg: &str, y: Option<&Property>) -> ChartSpec {
    ChartSpec {
        chart_type: kind.into(),
        x_property_id: x.map(|p| p.id.clone()),
        aggregation: agg.into(),
        y_property_id: y.map(|p| p.id.clone()),
        ..Default::default()
    }
}

#[test]
fn charts_count_sum_and_split_by_series() {
    let mut s = sales();
    // Records per status; the record with no status is its own (empty) category.
    let v = chart_view(
        &mut s.conn,
        &s.db,
        spec("bar", Some(&s.status), "count", None),
    );
    let d = chart(&s.conn, &s.db, &v);
    assert_eq!(d.records, 6);
    let by: std::collections::HashMap<Option<String>, i64> =
        d.points.iter().map(|p| (p.x.clone(), p.count)).collect();
    assert_eq!(by[&Some(opt(&s.status, "Won"))], 3);
    assert_eq!(by[&Some(opt(&s.status, "Open"))], 1);
    assert_eq!(by[&None], 1);

    // Sum of amount per status, split by team.
    let mut sp = spec("bar", Some(&s.status), "sum", Some(&s.amount));
    sp.group_property_id = Some(s.team.id.clone());
    let v = chart_view(&mut s.conn, &s.db, sp);
    let d = chart(&s.conn, &s.db, &v);
    let won_south = d
        .points
        .iter()
        .find(|p| {
            p.x.as_deref() == Some(&opt(&s.status, "Won"))
                && p.group.as_deref() == Some(&opt(&s.team, "South"))
        })
        .unwrap();
    assert_eq!(won_south.value, Some(200.0));
    assert_eq!(won_south.count, 2);

    // Average and extremes.
    for (agg, expected) in [("average", 125.0), ("min", 25.0), ("max", 300.0)] {
        let v = chart_view(&mut s.conn, &s.db, spec("kpi", None, agg, Some(&s.amount)));
        let d = chart(&s.conn, &s.db, &v);
        assert_eq!(flat(&d), vec![(None, None, Some(expected), 6)], "{agg}");
    }
    // A KPI over no matching records is still one row.
    let v = chart_view(&mut s.conn, &s.db, spec("kpi", None, "count", None));
    assert_eq!(chart(&s.conn, &s.db, &v).points[0].value, Some(6.0));
}

#[test]
fn charts_bucket_dates_and_follow_filters() {
    let mut s = sales();
    let mut sp = spec("line", Some(&s.when), "sum", Some(&s.amount));
    sp.bucket = Some("month".into());
    let v = chart_view(&mut s.conn, &s.db, sp.clone());
    let d = chart(&s.conn, &s.db, &v);
    assert_eq!(
        flat(&d)[..2],
        [
            (Some("2026-01".into()), None, Some(400.0), 2),
            (Some("2026-02".into()), None, Some(225.0), 3)
        ]
    );
    // The record without a date comes last.
    assert_eq!(d.points.last().unwrap().x, None);

    // The view's filter narrows the chart.
    let mut cfg = v.config.clone();
    cfg.filter = Some(filter(&s.team, "=", json!(opt(&s.team, "South"))));
    let v2 = update_view(
        &mut s.conn,
        ViewUpdate {
            view_id: v.id.clone(),
            name: None,
            config: cfg,
        },
    )
    .unwrap();
    assert_eq!(chart(&s.conn, &s.db, &v2).records, 3);

    // A caller's extra filter (a dashboard filter) is added on top.
    let d = charts::data(
        &s.conn,
        &ChartQuery {
            database_id: s.db.database.id.clone(),
            view_id: Some(v2.id.clone()),
            chart: None,
            filter: Some(filter(&s.status, "=", json!(opt(&s.status, "Won")))),
        },
    )
    .unwrap();
    assert_eq!(d.records, 2);

    // A widget with no view brings its own chart and sees every record.
    let d = charts::data(
        &s.conn,
        &ChartQuery {
            database_id: s.db.database.id.clone(),
            view_id: None,
            chart: Some(spec("bar", Some(&s.team), "count", None)),
            filter: None,
        },
    )
    .unwrap();
    assert_eq!(d.records, 6);
}

#[test]
fn charts_can_use_formulas_and_validate_their_settings() {
    let mut s = sales();
    let doubled = add(
        &mut s.conn,
        &s.db,
        "Doubled",
        "formula",
        Some(json!({ "expression": "prop(\"Amount\") * 2" })),
    );
    let v = chart_view(&mut s.conn, &s.db, spec("kpi", None, "sum", Some(&doubled)));
    assert_eq!(chart(&s.conn, &s.db, &v).points[0].value, Some(1250.0));

    let bad = |sp: ChartSpec| {
        charts::normalize(sp, &load_properties(&s.conn, &s.db.database.id).unwrap()).is_err()
    };
    assert!(bad(spec("radar", Some(&s.status), "count", None)));
    assert!(bad(spec("bar", Some(&s.status), "median", None)));
    assert!(
        bad(spec("bar", Some(&s.amount), "count", None)),
        "numbers are not an axis"
    );
    assert!(
        bad(spec("bar", Some(&s.status), "sum", Some(&s.team))),
        "cannot sum options"
    );
    let mut split = spec("bar", Some(&s.status), "count", None);
    split.group_property_id = Some(s.when.id.clone());
    assert!(bad(split));
    let mut b = spec("bar", Some(&s.when), "count", None);
    b.bucket = Some("fortnight".into());
    assert!(bad(b));

    // Pies and KPIs drop what they cannot draw; the series never repeats the axis.
    let props = load_properties(&s.conn, &s.db.database.id).unwrap();
    let mut pie = spec("pie", Some(&s.status), "count", None);
    pie.group_property_id = Some(s.team.id.clone());
    assert_eq!(
        charts::normalize(pie, &props).unwrap().group_property_id,
        None
    );
    let mut same = spec("bar", Some(&s.status), "count", None);
    same.group_property_id = Some(s.status.id.clone());
    assert_eq!(
        charts::normalize(same, &props).unwrap().group_property_id,
        None
    );
    // A chart view with no settings starts from the status.
    let fresh = mk_view(&mut s.conn, &s.db, "chart", None);
    assert_eq!(
        fresh.config.chart.as_ref().unwrap().x_property_id,
        Some(s.status.id.clone()),
        "defaults to the status"
    );
}

#[test]
fn deleting_a_property_clears_it_from_charts_and_forms() {
    let mut s = sales();
    let mut sp = spec("bar", Some(&s.team), "sum", Some(&s.amount));
    sp.group_property_id = Some(s.status.id.clone());
    let c = chart_view(&mut s.conn, &s.db, sp);
    let f = mk_view(&mut s.conn, &s.db, "form", None);
    delete_property(&mut s.conn, &s.team.id).unwrap();
    delete_property(&mut s.conn, &s.amount.id).unwrap();
    let views = load_views(&s.conn, &s.db.database.id).unwrap();
    let chart_cfg = views
        .iter()
        .find(|v| v.id == c.id)
        .unwrap()
        .config
        .chart
        .clone()
        .unwrap();
    assert_eq!(chart_cfg.x_property_id, None);
    assert_eq!(chart_cfg.y_property_id, None);
    assert_eq!(chart_cfg.group_property_id, Some(s.status.id.clone()));
    let form = views
        .iter()
        .find(|v| v.id == f.id)
        .unwrap()
        .config
        .form
        .clone()
        .unwrap();
    assert!(!form.fields.iter().any(|x| x.property_id == s.team.id));
}

#[test]
fn forms_create_records_and_enforce_required_fields() {
    let mut s = sales();
    let v = mk_view(&mut s.conn, &s.db, "form", None);
    let spec = v.config.form.clone().unwrap();
    let props = load_properties(&s.conn, &s.db.database.id).unwrap();
    let title = props.iter().find(|p| p.property_type == "title").unwrap();
    assert_eq!(
        spec.fields[0].property_id, title.id,
        "the title comes first"
    );
    assert!(spec.fields[0].required);
    assert!(!spec.fields.iter().any(|f| f.property_id.is_empty()));

    // Ask for the title, the team (required) and the amount only, and relabel one.
    let cfg = ViewConfig {
        form: Some(FormSpec {
            fields: vec![
                FormField {
                    property_id: s.amount.id.clone(),
                    label: Some("  How much  ".into()),
                    help: Some("In euros".into()),
                    required: false,
                },
                FormField {
                    property_id: s.team.id.clone(),
                    label: None,
                    help: None,
                    required: true,
                },
                FormField {
                    property_id: s.amount.id.clone(),
                    label: None,
                    help: None,
                    required: true,
                },
            ],
            intro: Some("Tell us about the deal".into()),
            submit_label: None,
            success_message: None,
        }),
        ..Default::default()
    };
    let v = update_view(
        &mut s.conn,
        ViewUpdate {
            view_id: v.id.clone(),
            name: None,
            config: cfg,
        },
    )
    .unwrap();
    let spec = v.config.form.clone().unwrap();
    assert_eq!(
        spec.fields
            .iter()
            .map(|f| f.property_id.clone())
            .collect::<Vec<_>>(),
        vec![title.id.clone(), s.amount.id.clone(), s.team.id.clone()],
        "title forced first, duplicate dropped"
    );
    assert_eq!(spec.fields[1].label.as_deref(), Some("How much"));

    let submit = |conn: &mut Connection, t: Option<&str>, values: Value| {
        forms::submit(
            conn,
            FormSubmit {
                view_id: v.id.clone(),
                title: t.map(String::from),
                values: values.as_object().cloned().unwrap_or_default(),
            },
        )
    };
    let before = titles(&s.conn, &s.db).len();
    // Missing title, missing required team, and fields the form does not ask for all fail.
    assert!(submit(
        &mut s.conn,
        None,
        json!({ s.team.id.clone(): opt(&s.team, "North") })
    )
    .is_err());
    assert!(submit(&mut s.conn, Some("Deal"), json!({})).is_err());
    assert!(submit(
        &mut s.conn,
        Some("Deal"),
        json!({ s.team.id.clone(): opt(&s.team, "North"), s.status.id.clone(): opt(&s.status, "Won") })
    )
    .is_err());
    assert_eq!(
        titles(&s.conn, &s.db).len(),
        before,
        "failures create nothing"
    );

    let row = submit(
        &mut s.conn,
        Some("New deal"),
        json!({ s.team.id.clone(): opt(&s.team, "North"), s.amount.id.clone(): 70 }),
    )
    .unwrap();
    assert_eq!(row.title, "New deal");
    assert_eq!(row.values[&s.amount.id], json!(70.0));
    assert_eq!(titles(&s.conn, &s.db).len(), before + 1);

    // Only a form view accepts submissions.
    let table_id = s.db.views[0].id.clone();
    assert!(forms::submit(
        &mut s.conn,
        FormSubmit {
            view_id: table_id,
            title: Some("x".into()),
            values: Default::default()
        }
    )
    .is_err());
}

#[test]
fn feeds_list_newest_first_and_can_order_by_edits() {
    let mut s = sales();
    let v = mk_view(&mut s.conn, &s.db, "feed", None);
    assert_eq!(v.config.feed_order.as_deref(), Some("created"));
    let rows = |conn: &Connection, v: &DbView| -> Vec<String> {
        query_records(
            conn,
            &RecordQuery {
                extra_filter: None,
                database_id: s.db.database.id.clone(),
                view_id: Some(v.id.clone()),
                group_key: None,
                subgroup_key: None,
                cursor: None,
                limit: Some(50),
                skip_total: true,
                range: None,
            },
        )
        .unwrap()
        .rows
        .into_iter()
        .map(|r| r.title)
        .collect()
    };
    assert_eq!(rows(&s.conn, &v), vec!["F", "E", "D", "C", "B", "A"]);

    // Editing an old record moves it to the top of a feed ordered by last edit.
    let cfg = ViewConfig {
        feed_order: Some("updated".into()),
        // A saved custom sort must not add unused bindings or change chronological ordering.
        sorts: vec![ViewSort {
            property_id: s.amount.id.clone(),
            direction: "asc".into(),
        }],
        ..v.config.clone()
    };
    let v = update_view(
        &mut s.conn,
        ViewUpdate {
            view_id: v.id.clone(),
            name: None,
            config: cfg,
        },
    )
    .unwrap();
    let a = query_records(
        &s.conn,
        &RecordQuery {
            extra_filter: None,
            database_id: s.db.database.id.clone(),
            view_id: None,
            group_key: None,
            subgroup_key: None,
            cursor: None,
            limit: Some(50),
            skip_total: true,
            range: None,
        },
    )
    .unwrap()
    .rows
    .into_iter()
    .find(|r| r.title == "A")
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    set(&mut s.conn, &a, &s.amount, json!(1)).unwrap();
    conn_touch(&s.conn, &a.page_id);
    assert_eq!(rows(&s.conn, &v)[0], "A");
    assert!(update_view(
        &mut s.conn,
        ViewUpdate {
            view_id: v.id.clone(),
            name: None,
            config: ViewConfig {
                feed_order: Some("random".into()),
                ..v.config.clone()
            },
        }
    )
    .is_err());
}

/// Editing a value touches the record's page; this keeps the test independent of how.
fn conn_touch(conn: &Connection, page_id: &str) {
    conn.execute(
        "UPDATE page SET updated_at = ?2 WHERE id = ?1",
        params![page_id, now()],
    )
    .unwrap();
}

#[test]
fn extra_filters_narrow_records_and_group_counts() {
    let mut s = sales();
    let board = mk_view(
        &mut s.conn,
        &s.db,
        "board",
        Some(ViewConfig {
            group: Some(GroupSpec {
                property_id: s.status.id.clone(),
                bucket: None,
            }),
            ..Default::default()
        }),
    );
    let extra = Some(filter(&s.team, "=", json!(opt(&s.team, "South"))));
    let counted = group_counts(
        &s.conn,
        &GroupCountsQuery {
            extra_filter: extra.clone(),
            database_id: s.db.database.id.clone(),
            view_id: Some(board.id.clone()),
        },
    )
    .unwrap();
    let total: i64 = counted.iter().map(|g| g.count).sum();
    assert_eq!(total, 3);
    let page = query_records(
        &s.conn,
        &RecordQuery {
            extra_filter: extra,
            database_id: s.db.database.id.clone(),
            view_id: Some(board.id.clone()),
            group_key: None,
            subgroup_key: None,
            cursor: None,
            limit: Some(50),
            skip_total: false,
            range: None,
        },
    )
    .unwrap();
    assert_eq!(page.total, Some(3));
    // A bad extra filter is an error, never silently ignored.
    assert!(query_records(
        &s.conn,
        &RecordQuery {
            extra_filter: Some(filter(&s.team, ">", json!(1))),
            database_id: s.db.database.id.clone(),
            view_id: None,
            group_key: None,
            subgroup_key: None,
            cursor: None,
            limit: None,
            skip_total: false,
            range: None,
        },
    )
    .is_err());
}

fn body_of(conn: &Connection, page_id: &str) -> Vec<crate::domain::Block> {
    repo::block::list(conn, page_id).unwrap()
}

fn write_body(conn: &mut Connection, page_id: &str, ids: &[(&str, Option<&str>, &str)]) {
    services::block::apply_batch(
        conn,
        BlockBatch {
            page_id: page_id.into(),
            upserts: ids
                .iter()
                .enumerate()
                .map(|(i, (id, parent, text))| BlockUpsert {
                    id: (*id).into(),
                    parent_block_id: parent.map(String::from),
                    block_type: "paragraph".into(),
                    position: i as f64 + 1.0,
                    data_json: format!(
                        "{{\"content\":[{{\"type\":\"text\",\"text\":\"{text}\"}}]}}"
                    ),
                    schema_version: 2,
                })
                .collect(),
            delete_ids: vec![],
        },
    )
    .unwrap();
}

#[test]
fn record_templates_capture_a_record_and_start_new_ones() {
    let mut s = sales();
    let rows = |c: &Connection| {
        query_records(
            c,
            &RecordQuery {
                extra_filter: None,
                database_id: s.db.database.id.clone(),
                view_id: None,
                group_key: None,
                subgroup_key: None,
                cursor: None,
                limit: Some(50),
                skip_total: true,
                range: None,
            },
        )
        .unwrap()
        .rows
    };
    let source = rows(&s.conn).into_iter().find(|r| r.title == "B").unwrap();
    let (pid, cid) = (new_id(), new_id());
    write_body(
        &mut s.conn,
        &source.page_id,
        &[(&pid, None, "Checklist"), (&cid, Some(&pid), "Call back")],
    );
    let t = rtpl::create(
        &mut s.conn,
        rtpl::RecordTemplateCreate {
            database_id: s.db.database.id.clone(),
            name: "Won deal".into(),
            from_record_id: Some(source.id.clone()),
        },
    )
    .unwrap();
    assert!(t.is_default, "the first template is the default");
    assert_eq!(t.block_count, 2);
    assert_eq!(t.values[&s.team.id], json!(opt(&s.team, "North")));
    assert_eq!(t.title, "B");
    let second = rtpl::create(
        &mut s.conn,
        rtpl::RecordTemplateCreate {
            database_id: s.db.database.id.clone(),
            name: "Blank".into(),
            from_record_id: None,
        },
    )
    .unwrap();
    assert!(!second.is_default);
    assert_eq!(second.block_count, 0);

    // A new record gets the template's values and an independent copy of its body.
    let made = create_record(
        &mut s.conn,
        RecordCreate {
            template_id: Some(t.id.clone()),
            database_id: s.db.database.id.clone(),
            title: None,
            values: json!({ s.amount.id.clone(): 5 })
                .as_object()
                .cloned()
                .unwrap(),
        },
    )
    .unwrap();
    assert_eq!(made.title, "B", "the template's title is the default");
    assert_eq!(made.values[&s.team.id], json!(opt(&s.team, "North")));
    assert_eq!(
        made.values[&s.amount.id],
        json!(5.0),
        "what the caller passes wins"
    );
    let copy = body_of(&s.conn, &made.page_id);
    assert_eq!(copy.len(), 2);
    let original = body_of(&s.conn, &source.page_id);
    assert!(
        copy.iter().all(|b| original.iter().all(|o| o.id != b.id)),
        "new block ids"
    );
    let child = copy.iter().find(|b| b.parent_block_id.is_some()).unwrap();
    assert!(copy
        .iter()
        .any(|b| Some(&b.id) == child.parent_block_id.as_ref()));

    // An explicit title wins; a template from another database is refused.
    let titled = create_record(
        &mut s.conn,
        RecordCreate {
            template_id: Some(t.id.clone()),
            database_id: s.db.database.id.clone(),
            title: Some("Mine".into()),
            values: Default::default(),
        },
    )
    .unwrap();
    assert_eq!(titled.title, "Mine");
    let ws = repo::workspace::get_first(&s.conn).unwrap().unwrap();
    let other = new_db(&mut s.conn, &ws);
    assert!(create_record(
        &mut s.conn,
        RecordCreate {
            template_id: Some(t.id.clone()),
            database_id: other.database.id.clone(),
            title: None,
            values: Default::default(),
        },
    )
    .is_err());

    // Deleting a property the template still has a value for is harmless.
    delete_property(&mut s.conn, &s.team.id).unwrap();
    let again = create_record(
        &mut s.conn,
        RecordCreate {
            template_id: Some(t.id.clone()),
            database_id: s.db.database.id.clone(),
            title: None,
            values: Default::default(),
        },
    )
    .unwrap();
    assert!(!again.values.contains_key(&s.team.id));

    // Default flag moves; names are validated; delete works; the list is ordered.
    let updated = rtpl::update(
        &mut s.conn,
        rtpl::RecordTemplateUpdate {
            id: second.id.clone(),
            name: Some("Empty".into()),
            title: None,
            is_default: Some(true),
        },
    )
    .unwrap();
    assert!(updated.is_default);
    let list = rtpl::list(&s.conn, &s.db.database.id).unwrap();
    assert_eq!(
        list.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
        ["Won deal", "Empty"]
    );
    assert_eq!(list.iter().filter(|x| x.is_default).count(), 1);
    assert!(rtpl::update(
        &mut s.conn,
        rtpl::RecordTemplateUpdate {
            id: t.id.clone(),
            name: Some("  ".into()),
            title: None,
            is_default: None
        }
    )
    .is_err());
    rtpl::delete(&mut s.conn, &t.id).unwrap();
    assert!(rtpl::delete(&mut s.conn, &t.id).is_err());
    assert_eq!(rtpl::list(&s.conn, &s.db.database.id).unwrap().len(), 1);
}

#[test]
fn record_templates_are_limited_and_die_with_their_database() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    for i in 0..MAX_RECORD_TEMPLATES {
        rtpl::create(
            &mut conn,
            rtpl::RecordTemplateCreate {
                database_id: db.database.id.clone(),
                name: format!("T{i}"),
                from_record_id: None,
            },
        )
        .unwrap();
    }
    assert!(rtpl::create(
        &mut conn,
        rtpl::RecordTemplateCreate {
            database_id: db.database.id.clone(),
            name: "One too many".into(),
            from_record_id: None,
        },
    )
    .is_err());
    conn.execute("DELETE FROM db_database WHERE id = ?1", [&db.database.id])
        .unwrap();
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM db_record_template", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn bulk_set_changes_every_record_or_none() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let qty = add(&mut conn, &db, "Qty", "number", None);
    let a = rec(&mut conn, &db, "A", json!({}));
    let b = rec(&mut conn, &db, "B", json!({}));
    let c = rec(&mut conn, &db, "C", json!({}));
    let ids = vec![a.id.clone(), b.id.clone(), c.id.clone(), a.id.clone()];

    let rows = bulk_set_value(&mut conn, &qty.id, &ids, &json!(7)).unwrap();
    assert_eq!(rows.len(), 3, "a record listed twice is changed once");
    for r in load_rows(&conn, &ids).unwrap() {
        assert_eq!(r.values.get(&qty.id), Some(&json!(7.0)));
    }

    // One refused value undoes the whole batch: a record from another database cannot take this property.
    let other = new_db(&mut conn, &ws);
    let stranger = rec(&mut conn, &other, "Stranger", json!({}));
    let mixed = vec![a.id.clone(), stranger.id.clone()];
    assert!(bulk_set_value(&mut conn, &qty.id, &mixed, &json!(99)).is_err());
    let after = load_rows(&conn, std::slice::from_ref(&a.id)).unwrap();
    assert_eq!(
        after[0].values.get(&qty.id),
        Some(&json!(7.0)),
        "the first record was not changed either"
    );

    assert!(bulk_set_value(&mut conn, &qty.id, &[], &json!(1))
        .unwrap()
        .is_empty());
    let many: Vec<String> = (0..2001).map(|i| format!("{i}")).collect();
    assert!(bulk_set_value(&mut conn, &qty.id, &many, &json!(1)).is_err());
}

// ---------------------------------------------------------------------------------------------
// canvas views
// ---------------------------------------------------------------------------------------------

fn canvas_item(kind: &str, record: Option<&str>, x: f64) -> canvas::CanvasItem {
    canvas::CanvasItem {
        id: new_id(),
        kind: kind.into(),
        record_id: record.map(Into::into),
        page_id: None,
        text: String::new(),
        attachment_hash: (kind == "image").then(|| "abc123".to_string()),
        x,
        y: 10.0,
        w: 200.0,
        h: 100.0,
        z: 0,
        color: None,
    }
}

#[test]
fn canvas_items_and_arrows_round_trip_and_follow_their_records() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let r = rec(&mut conn, &db, "Card", json!({}));
    let view = mk_view(&mut conn, &db, "canvas", None);
    assert_eq!(view.name, "Canvas");

    let card = canvas_item("record", Some(&r.id), 0.0);
    let note = canvas_item("note", None, 300.0);
    let image = canvas_item("image", None, 600.0);
    let edge = canvas::CanvasEdge {
        id: new_id(),
        from_item: card.id.clone(),
        to_item: note.id.clone(),
        label: "depends on".into(),
    };
    canvas::apply(
        &mut conn,
        &view.id,
        &[
            canvas::CanvasOp::UpsertItem { item: card.clone() },
            canvas::CanvasOp::UpsertItem { item: note.clone() },
            canvas::CanvasOp::UpsertItem { item: image },
            canvas::CanvasOp::UpsertEdge { edge: edge.clone() },
        ],
    )
    .unwrap();
    let data = canvas::load(&conn, &view.id).unwrap();
    assert_eq!((data.items.len(), data.edges.len()), (3, 1));
    assert_eq!(data.edges[0], edge);

    // Moving an item updates it in place.
    let mut moved = card.clone();
    moved.x = 42.0;
    canvas::apply(
        &mut conn,
        &view.id,
        &[canvas::CanvasOp::UpsertItem { item: moved }],
    )
    .unwrap();
    let data = canvas::load(&conn, &view.id).unwrap();
    assert_eq!(data.items.iter().find(|i| i.id == card.id).unwrap().x, 42.0);

    // Duplicating the view copies items and arrows under new ids.
    let copy = duplicate_view(&mut conn, &view.id).unwrap();
    let copied = canvas::load(&conn, &copy.id).unwrap();
    assert_eq!((copied.items.len(), copied.edges.len()), (3, 1));
    assert!(copied.items.iter().all(|i| i.id != card.id));

    // Removing a note takes its arrows with it; deleting the record removes its card.
    canvas::apply(
        &mut conn,
        &view.id,
        &[canvas::CanvasOp::DeleteItem {
            id: note.id.clone(),
        }],
    )
    .unwrap();
    assert!(canvas::load(&conn, &view.id).unwrap().edges.is_empty());
    services::page::delete(&mut conn, &r.page_id).unwrap();
    assert!(canvas::load(&conn, &view.id)
        .unwrap()
        .items
        .iter()
        .all(|i| i.kind != "record"));
}

#[test]
fn canvas_rejects_bad_input_atomically() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let other = new_db(&mut conn, &ws);
    let foreign = rec(&mut conn, &other, "Elsewhere", json!({}));
    let table = mk_view(&mut conn, &db, "table", None);
    let view = mk_view(&mut conn, &db, "canvas", None);

    let good = canvas_item("note", None, 0.0);
    // Not a canvas view.
    assert!(canvas::apply(
        &mut conn,
        &table.id,
        &[canvas::CanvasOp::UpsertItem { item: good.clone() }]
    )
    .is_err());
    // A record from another database, an off-canvas size and an unknown kind all fail the batch.
    let mut huge = canvas_item("note", None, 0.0);
    huge.w = 1e9;
    for bad in [
        canvas_item("record", Some(&foreign.id), 0.0),
        huge,
        canvas_item("sticker", None, 0.0),
    ] {
        let res = canvas::apply(
            &mut conn,
            &view.id,
            &[
                canvas::CanvasOp::UpsertItem { item: good.clone() },
                canvas::CanvasOp::UpsertItem { item: bad },
            ],
        );
        assert!(res.is_err());
    }
    assert!(
        canvas::load(&conn, &view.id).unwrap().items.is_empty(),
        "failed batches leave nothing behind"
    );
    // An arrow must join two existing items on this canvas.
    let dangling = canvas::CanvasEdge {
        id: new_id(),
        from_item: good.id.clone(),
        to_item: new_id(),
        label: String::new(),
    };
    assert!(canvas::apply(
        &mut conn,
        &view.id,
        &[
            canvas::CanvasOp::UpsertItem { item: good },
            canvas::CanvasOp::UpsertEdge { edge: dangling }
        ]
    )
    .is_err());
}

// ---------------------------------------------------------------------------------------------
// canvas boards (workspace-level)
// ---------------------------------------------------------------------------------------------

fn page_card(page: &str, x: f64) -> canvas::CanvasItem {
    canvas::CanvasItem {
        page_id: Some(page.into()),
        ..canvas_item("page", None, x)
    }
}

fn new_page(conn: &mut Connection, ws: &Workspace, title: &str) -> String {
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
    .id
}

#[test]
fn boards_hold_page_cards_notes_and_arrows() {
    let (mut conn, ws) = setup();
    let a = new_page(&mut conn, &ws, "Alpha");
    let b = new_page(&mut conn, &ws, "Beta");
    let board = canvas::create_board(&conn, &ws.id, "  Roadmap ").unwrap();
    assert_eq!(board.name, "Roadmap");
    assert_eq!(
        canvas::create_board(&conn, &ws.id, "").unwrap().name,
        "Untitled canvas"
    );

    let (ca, cb, note) = (
        page_card(&a, 0.0),
        page_card(&b, 300.0),
        canvas_item("note", None, 600.0),
    );
    let edge = canvas::CanvasEdge {
        id: new_id(),
        from_item: ca.id.clone(),
        to_item: cb.id.clone(),
        label: "leads to".into(),
    };
    canvas::apply_board(
        &mut conn,
        &board.id,
        &[
            canvas::CanvasOp::UpsertItem { item: ca.clone() },
            canvas::CanvasOp::UpsertItem { item: cb.clone() },
            canvas::CanvasOp::UpsertItem { item: note },
            canvas::CanvasOp::UpsertEdge { edge },
        ],
    )
    .unwrap();
    let data = canvas::load_board(&conn, &board.id).unwrap();
    assert_eq!((data.items.len(), data.edges.len()), (3, 1));

    // A page can sit on a board once.
    let again = page_card(&a, 50.0);
    assert!(canvas::apply_board(
        &mut conn,
        &board.id,
        &[canvas::CanvasOp::UpsertItem { item: again }]
    )
    .is_err());

    // Duplicating copies cards and arrows under new ids.
    let copy = canvas::duplicate_board(&conn, &board.id).unwrap();
    assert_eq!(copy.name, "Roadmap copy");
    let copied = canvas::load_board(&conn, &copy.id).unwrap();
    assert_eq!((copied.items.len(), copied.edges.len()), (3, 1));
    assert!(copied.items.iter().all(|i| i.id != ca.id));

    // A trashed page's card is hidden, a deleted board takes its items with it.
    services::page::delete(&mut conn, &b).unwrap();
    let data = canvas::load_board(&conn, &board.id).unwrap();
    assert!(data
        .items
        .iter()
        .all(|i| i.page_id.as_deref() != Some(b.as_str())));
    canvas::delete_board(&conn, &board.id).unwrap();
    assert!(canvas::load_board(&conn, &board.id).is_err());
    let left: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM canvas_board_item WHERE board_id = ?1",
            [&board.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
    assert_eq!(canvas::list_boards(&conn, &ws.id).unwrap().len(), 2);
}

#[test]
fn boards_reject_bad_cards_atomically() {
    let (mut conn, ws) = setup();
    let page = new_page(&mut conn, &ws, "Real");
    let board = canvas::create_board(&conn, &ws.id, "B").unwrap();
    let other = canvas::create_board(&conn, &ws.id, "Other").unwrap();
    let good = canvas_item("note", None, 0.0);

    // Records are for database views; a page card needs a page that exists; an item belongs to one board.
    let no_page = canvas::CanvasItem {
        page_id: None,
        ..canvas_item("page", None, 0.0)
    };
    for bad in [
        canvas_item("record", Some(&new_id()), 0.0),
        page_card(&new_id(), 0.0),
        no_page,
    ] {
        let res = canvas::apply_board(
            &mut conn,
            &board.id,
            &[
                canvas::CanvasOp::UpsertItem { item: good.clone() },
                canvas::CanvasOp::UpsertItem { item: bad },
            ],
        );
        assert!(res.is_err());
    }
    assert!(canvas::load_board(&conn, &board.id)
        .unwrap()
        .items
        .is_empty());
    canvas::apply_board(
        &mut conn,
        &board.id,
        &[canvas::CanvasOp::UpsertItem {
            item: page_card(&page, 0.0),
        }],
    )
    .unwrap();
    let stolen = canvas::load_board(&conn, &board.id)
        .unwrap()
        .items
        .remove(0);
    assert!(canvas::apply_board(
        &mut conn,
        &other.id,
        &[canvas::CanvasOp::UpsertItem { item: stolen }]
    )
    .is_err());
    // A page card is not valid on a database view.
    let (mut conn2, ws2) = setup();
    let db = new_db(&mut conn2, &ws2);
    let view = mk_view(&mut conn2, &db, "canvas", None);
    let p2 = new_page(&mut conn2, &ws2, "P");
    assert!(canvas::apply(
        &mut conn2,
        &view.id,
        &[canvas::CanvasOp::UpsertItem {
            item: page_card(&p2, 0.0)
        }]
    )
    .is_err());
}

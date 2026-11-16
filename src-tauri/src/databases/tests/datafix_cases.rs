//! Milestone 3: search inside a view, data checks and defaults, duplicates, column options.

use super::*;
use crate::databases::datafix::{self, DuplicateQuery};

fn search_titles(conn: &Connection, db: &DatabaseDetail, term: &str) -> Vec<String> {
    let page = query_records(
        conn,
        &RecordQuery {
            extra_filter: Some(FilterNode::Leaf {
                property_id: "*".into(),
                operator: "search".into(),
                value: json!(term),
            }),
            view_id: None,
            group_key: None,
            subgroup_key: None,
            database_id: db.database.id.clone(),
            cursor: None,
            limit: Some(100),
            skip_total: false,
            range: None,
        },
    )
    .unwrap();
    page.rows.into_iter().map(|r| r.title).collect()
}

#[test]
fn search_matches_text_and_option_names_on_top_of_the_view_filter() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let notes = add(&mut conn, &db, "Notes", "text", None);
    let n = add(&mut conn, &db, "Size", "number", None);
    let tags = select(
        &mut conn,
        &db,
        "Labels",
        "multi_select",
        &["Urgent", "Later"],
    );
    let stat = select(&mut conn, &db, "Phase", "select", &["Backlog", "Shipping"]);
    rec(
        &mut conn,
        &db,
        "Alpha",
        json!({ notes.id.clone(): "call the plumber", n.id.clone(): 5 }),
    );
    rec(
        &mut conn,
        &db,
        "Beta",
        json!({ tags.id.clone(): [opt(&tags, "Urgent")] }),
    );
    rec(
        &mut conn,
        &db,
        "Gamma",
        json!({ stat.id.clone(): opt(&stat, "Shipping") }),
    );
    rec(&mut conn, &db, "100% done_", json!({}));
    assert_eq!(search_titles(&conn, &db, "PLUMB"), vec!["Alpha"]);
    assert_eq!(search_titles(&conn, &db, "urgent"), vec!["Beta"]);
    assert_eq!(search_titles(&conn, &db, "ship"), vec!["Gamma"]);
    assert_eq!(search_titles(&conn, &db, "gam"), vec!["Gamma"]);
    // LIKE wildcards in the search text are literal characters.
    assert_eq!(search_titles(&conn, &db, "%"), vec!["100% done_"]);
    assert_eq!(search_titles(&conn, &db, "_"), vec!["100% done_"]);
    // Numbers are not searched; nothing matches.
    assert!(search_titles(&conn, &db, "5").is_empty());
    // A blank search changes nothing.
    assert_eq!(search_titles(&conn, &db, "  ").len(), 4);
    // It narrows the view's own filter instead of replacing it.
    view(
        &mut conn,
        &db,
        ViewConfig {
            columns: db.views[0].config.columns.clone(),
            filter: Some(filter(&n, "=", json!(5))),
            ..Default::default()
        },
    );
    assert!(search_titles(&conn, &db, "Beta").is_empty());
    assert_eq!(search_titles(&conn, &db, "Alpha"), vec!["Alpha"]);
}

#[test]
fn data_checks_are_validated_and_defaults_fill_new_records() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let age = add(
        &mut conn,
        &db,
        "Age",
        "number",
        Some(json!({ "validation": { "required": true, "min": 0, "max": 120 }, "default": 18 })),
    );
    assert_eq!(age.config["validation"]["max"], json!(120.0));
    assert_eq!(age.config["default"], json!(18.0));
    let mail = add(
        &mut conn,
        &db,
        "Mail",
        "text",
        Some(json!({ "validation": { "unique": true, "format": "email", "junk": 1 } })),
    );
    assert_eq!(
        mail.config["validation"],
        json!({ "unique": true, "format": "email" })
    );
    let st = select(&mut conn, &db, "Phase", "select", &["Open", "Closed"]);
    let open = opt(&st, "Open");
    let st = update_property(
        &mut conn,
        PropertyUpdate {
            id: st.id.clone(),
            name: None,
            config: Some(json!({ "options": st.config["options"], "default": open })),
            position: None,
        },
    )
    .unwrap();
    // Invalid settings are rejected; the checks never reject a cell value.
    for bad in [
        json!({ "validation": { "min": 5, "max": 1 } }),
        json!({ "validation": { "required": "yes" } }),
        json!({ "validation": { "format": "ssn" } }),
        json!({ "default": "x" }),
    ] {
        let r = add_property(
            &mut conn,
            PropertyCreate {
                database_id: db.database.id.clone(),
                name: "Bad".into(),
                property_type: "number".into(),
                config: Some(bad),
            },
        );
        assert!(r.is_err());
    }
    assert!(add_property(
        &mut conn,
        PropertyCreate {
            database_id: db.database.id.clone(),
            name: "Done".into(),
            property_type: "checkbox".into(),
            config: Some(json!({ "validation": { "unique": true } })),
        },
    )
    .is_err());
    let fresh = rec(&mut conn, &db, "New", json!({}));
    assert_eq!(fresh.values[&age.id], json!(18.0));
    assert_eq!(fresh.values[&st.id], json!(open));
    assert!(!fresh.values.contains_key(&mail.id));
    // An explicit value wins over the default, and an out-of-range one is still stored.
    let explicit = rec(&mut conn, &db, "Old", json!({ age.id.clone(): 400 }));
    assert_eq!(explicit.values[&age.id], json!(400.0));
    // A default that points at a deleted option is dropped instead of blocking the edit.
    let st = update_property(
        &mut conn,
        PropertyUpdate {
            id: st.id.clone(),
            name: None,
            config: Some(
                json!({ "options": [{ "name": "Closed", "color": "gray" }], "default": open }),
            ),
            position: None,
        },
    )
    .unwrap();
    assert!(st.config.get("default").is_none());
}

#[test]
fn duplicates_group_by_chosen_properties_keeping_the_oldest() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let mail = add(&mut conn, &db, "Mail", "text", None);
    let city = add(&mut conn, &db, "City", "text", None);
    let a = rec(
        &mut conn,
        &db,
        "Ann",
        json!({ mail.id.clone(): "a@x.io", city.id.clone(): "Paris" }),
    );
    let b = rec(
        &mut conn,
        &db,
        "Ann B",
        json!({ mail.id.clone(): " A@X.io ", city.id.clone(): "Lyon" }),
    );
    let c = rec(
        &mut conn,
        &db,
        "Ann C",
        json!({ mail.id.clone(): "a@x.io", city.id.clone(): "Paris" }),
    );
    rec(&mut conn, &db, "Zed", json!({}));
    rec(&mut conn, &db, "Zed2", json!({}));
    let query = |ids: &[&Property]| DuplicateQuery {
        database_id: db.database.id.clone(),
        property_ids: ids.iter().map(|p| p.id.clone()).collect(),
    };
    let one = datafix::find_duplicates(&conn, &query(&[&mail])).unwrap();
    assert_eq!(one.group_count, 1);
    assert_eq!(one.extra_count, 2);
    let ids: Vec<&str> = one.groups[0]
        .records
        .iter()
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(ids, vec![a.id.as_str(), b.id.as_str(), c.id.as_str()]);
    assert_eq!(one.groups[0].label, "a@x.io");
    // Both properties must match, so only the first and third are duplicates.
    let both = datafix::find_duplicates(&conn, &query(&[&mail, &city])).unwrap();
    assert_eq!(both.extra_count, 1);
    assert_eq!(both.groups[0].records[1].id, c.id);
    // Records with nothing in the compared property are not duplicates of each other.
    assert_eq!(
        datafix::find_duplicates(&conn, &query(&[&city]))
            .unwrap()
            .group_count,
        1
    );
    assert!(datafix::find_duplicates(&conn, &query(&[])).is_err());
    let unknown = DuplicateQuery {
        database_id: db.database.id.clone(),
        property_ids: vec!["nope".into()],
    };
    assert!(datafix::find_duplicates(&conn, &unknown).is_err());
}

#[test]
fn a_property_can_be_duplicated_with_its_values() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let notes = add(&mut conn, &db, "Notes", "text", None);
    let phase = select(&mut conn, &db, "Phase", "select", &["Open"]);
    let r = rec(
        &mut conn,
        &db,
        "A",
        json!({ notes.id.clone(): "hello", phase.id.clone(): opt(&phase, "Open") }),
    );
    let copy = datafix::duplicate_property(&mut conn, &notes.id).unwrap();
    assert_eq!(copy.name, "Notes copy");
    assert_ne!(copy.id, notes.id);
    let again = datafix::duplicate_property(&mut conn, &notes.id).unwrap();
    assert_eq!(again.name, "Notes copy 2");
    let sel = datafix::duplicate_property(&mut conn, &phase.id).unwrap();
    let rows = load_rows(&conn, &[r.id.clone()]).unwrap();
    assert_eq!(rows[0].values[&copy.id], json!("hello"));
    assert_eq!(rows[0].values[&sel.id], json!(opt(&phase, "Open")));
    let detail = database_detail(&conn, &db.database.id).unwrap();
    assert!(detail.views[0]
        .config
        .columns
        .iter()
        .any(|c| c.property_id == copy.id));
    let title = detail
        .properties
        .iter()
        .find(|p| p.property_type == "title")
        .unwrap();
    assert!(datafix::duplicate_property(&mut conn, &title.id).is_err());
}

#[test]
fn column_options_round_trip_and_old_views_load() {
    let (mut conn, ws) = setup();
    let db = new_db(&mut conn, &ws);
    let notes = add(&mut conn, &db, "Notes", "text", None);
    let detail = database_detail(&conn, &db.database.id).unwrap();
    let saved = view(
        &mut conn,
        &db,
        ViewConfig {
            columns: detail.views[0].config.columns.clone(),
            frozen_columns: 9,
            row_height: Some("tall".into()),
            wrap_columns: vec![notes.id.clone(), notes.id.clone(), "gone".into()],
            ..Default::default()
        },
    );
    assert_eq!(saved.config.frozen_columns, MAX_FROZEN_COLUMNS);
    assert_eq!(saved.config.row_height.as_deref(), Some("tall"));
    assert_eq!(saved.config.wrap_columns, vec![notes.id.clone()]);
    let bad = update_view(
        &mut conn,
        ViewUpdate {
            name: None,
            view_id: db.views[0].id.clone(),
            config: ViewConfig {
                row_height: Some("huge".into()),
                ..Default::default()
            },
        },
    );
    assert!(bad.is_err());
    // A view saved before these options existed has none of them.
    let old: ViewConfig = serde_json::from_str(r#"{"columns":[],"sorts":[]}"#).unwrap();
    assert_eq!(old.frozen_columns, 0);
    assert!(old.row_height.is_none() && old.wrap_columns.is_empty());
    assert!(!serde_json::to_string(&old)
        .unwrap()
        .contains("frozenColumns"));
}

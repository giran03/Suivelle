use super::*;
use crate::database::open_in_memory;
use crate::domain::*;
use crate::services;
use serde_json::json;

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

fn make(conn: &mut Connection, ws: &Workspace, parent: Option<&str>) -> AppResult<DashboardDetail> {
    create(
        conn,
        DashboardCreate {
            workspace_id: ws.id.clone(),
            parent_page_id: parent.map(String::from),
            title: Some("Overview".into()),
        },
    )
}

fn widget(id: &str, kind: &str, x: i64, y: i64, w: i64, h: i64) -> Widget {
    Widget {
        id: id.into(),
        kind: kind.into(),
        x,
        y,
        w,
        h,
        title: None,
        text: None,
        database_id: None,
        view_id: None,
        chart: None,
        filter: None,
    }
}

fn db_id() -> String {
    new_id()
}

#[test]
fn a_dashboard_is_a_page_with_a_layout_that_round_trips() {
    let (mut conn, ws) = setup();
    let d = make(&mut conn, &ws, None).unwrap();
    assert_eq!(d.page.kind, "dashboard");
    assert_eq!(d.page.title, "Overview");
    assert!(d.layout.widgets.is_empty());

    let mut text = widget("w1", "text", 0, 0, 6, 2);
    text.text = Some("Welcome".into());
    text.title = Some("  ".into());
    let mut chart = widget("w2", "chart", 6, 0, 6, 4);
    chart.database_id = Some(db_id());
    chart.chart = Some(ChartSpec {
        chart_type: "donut".into(),
        ..Default::default()
    });
    let mut linked = widget("w3", "linked_view", 0, 4, 12, 6);
    linked.database_id = Some(db_id());
    linked.view_id = Some(new_id());
    linked.chart = Some(ChartSpec::default());
    let saved = save(
        &mut conn,
        DashboardSave {
            page_id: d.page.id.clone(),
            layout: Layout {
                widgets: vec![text, chart, linked],
                filters: vec![SharedFilter {
                    id: "f1".into(),
                    property_name: " Status ".into(),
                    kind: "option".into(),
                    value: json!("Done"),
                }],
            },
        },
    )
    .unwrap();
    assert_eq!(saved.widgets[0].title, None, "blank titles are dropped");
    assert!(
        saved.widgets[2].chart.is_none(),
        "settings a widget type does not use are dropped"
    );
    assert_eq!(saved.filters[0].property_name, "Status");

    let loaded = get(&conn, &d.page.id).unwrap();
    assert_eq!(loaded.layout.widgets.len(), 3);
    assert_eq!(
        loaded.layout.widgets[1].chart.as_ref().unwrap().chart_type,
        "donut"
    );
    assert_eq!(loaded.layout.filters.len(), 1);
}

#[test]
fn bad_layouts_are_rejected_without_changing_anything() {
    let (mut conn, ws) = setup();
    let d = make(&mut conn, &ws, None).unwrap();
    let ok = Layout {
        widgets: vec![widget("a", "text", 0, 0, 4, 2)],
        filters: vec![],
    };
    save(
        &mut conn,
        DashboardSave {
            page_id: d.page.id.clone(),
            layout: ok,
        },
    )
    .unwrap();

    let attempts: Vec<Layout> = vec![
        Layout {
            widgets: vec![
                widget("a", "text", 0, 0, 4, 2),
                widget("a", "text", 4, 0, 4, 2),
            ],
            filters: vec![],
        },
        Layout {
            widgets: vec![widget("a", "carousel", 0, 0, 4, 2)],
            filters: vec![],
        },
        Layout {
            widgets: vec![widget("a", "text", 10, 0, 4, 2)],
            filters: vec![],
        },
        Layout {
            widgets: vec![widget("a", "text", 0, 0, 1, 2)],
            filters: vec![],
        },
        Layout {
            widgets: vec![widget("a", "text", 0, -1, 4, 2)],
            filters: vec![],
        },
        Layout {
            widgets: vec![widget("a", "text", 0, 0, 4, 0)],
            filters: vec![],
        },
        Layout {
            widgets: vec![widget("bad id!", "text", 0, 0, 4, 2)],
            filters: vec![],
        },
        Layout {
            widgets: vec![widget("a", "chart", 0, 0, 4, 2)],
            filters: vec![],
        },
        Layout {
            widgets: vec![widget("a", "linked_view", 0, 0, 4, 2)],
            filters: vec![],
        },
        Layout {
            widgets: (0..=MAX_WIDGETS)
                .map(|i| widget(&format!("w{i}"), "text", 0, i as i64, 4, 1))
                .collect(),
            filters: vec![],
        },
        Layout {
            widgets: vec![],
            filters: vec![SharedFilter {
                id: "f".into(),
                property_name: "X".into(),
                kind: "regex".into(),
                value: json!("a"),
            }],
        },
        Layout {
            widgets: vec![],
            filters: vec![SharedFilter {
                id: "f".into(),
                property_name: "X".into(),
                kind: "checkbox".into(),
                value: json!("yes"),
            }],
        },
        Layout {
            widgets: vec![],
            filters: vec![SharedFilter {
                id: "f".into(),
                property_name: "  ".into(),
                kind: "text".into(),
                value: json!("a"),
            }],
        },
    ];
    for (i, layout) in attempts.into_iter().enumerate() {
        assert!(
            save(
                &mut conn,
                DashboardSave {
                    page_id: d.page.id.clone(),
                    layout
                }
            )
            .is_err(),
            "attempt {i} should fail"
        );
    }
    let still = get(&conn, &d.page.id).unwrap();
    assert_eq!(
        still.layout.widgets.len(),
        1,
        "failed saves changed nothing"
    );
    assert_eq!(still.layout.widgets[0].id, "a");
}

#[test]
fn dashboards_live_in_pages_but_hold_none() {
    let (mut conn, ws) = setup();
    let parent = services::page::create(
        &mut conn,
        PageCreate {
            workspace_id: ws.id.clone(),
            parent_page_id: None,
            title: Some("Parent".into()),
            icon: None,
        },
    )
    .unwrap();
    let d = make(&mut conn, &ws, Some(&parent.id)).unwrap();
    assert_eq!(d.page.parent_page_id.as_deref(), Some(parent.id.as_str()));
    // A dashboard cannot be a parent, and only dashboards have layouts.
    assert!(make(&mut conn, &ws, Some(&d.page.id)).is_err());
    assert!(get(&conn, &parent.id).is_err());
    assert!(save(
        &mut conn,
        DashboardSave {
            page_id: parent.id.clone(),
            layout: Layout::default()
        }
    )
    .is_err());

    // Trashing hides it; the layout is kept for a restore.
    let mut layout = Layout::default();
    layout.widgets.push(widget("a", "text", 0, 0, 4, 2));
    save(
        &mut conn,
        DashboardSave {
            page_id: d.page.id.clone(),
            layout,
        },
    )
    .unwrap();
    services::page::delete(&mut conn, &d.page.id).unwrap();
    assert!(get(&conn, &d.page.id).is_err());
    services::page::restore(&mut conn, &d.page.id).unwrap();
    assert_eq!(get(&conn, &d.page.id).unwrap().layout.widgets.len(), 1);
}

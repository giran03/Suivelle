use super::{edit::*, *};
use crate::{
    database::open_in_memory,
    databases::{self, service as dbs},
    domain::*,
    repositories as repo, services,
};
use rusqlite::params;
use serde_json::json;
fn setup() -> (Connection, Workspace, Page, Page) {
    let mut c = open_in_memory().unwrap();
    let ws = services::workspace::create(
        &mut c,
        WorkspaceCreate {
            name: "Map".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let a = services::page::create(
        &mut c,
        PageCreate {
            workspace_id: ws.id.clone(),
            title: Some("A".into()),
            parent_page_id: None,
            icon: None,
        },
    )
    .unwrap();
    let b = services::page::create(
        &mut c,
        PageCreate {
            workspace_id: ws.id.clone(),
            title: Some("B".into()),
            parent_page_id: None,
            icon: None,
        },
    )
    .unwrap();
    (c, ws, a, b)
}
#[test]
fn references_undo_redo_and_reject_overwriting_editor_changes() {
    let (mut c, _, a, b) = setup();
    let undo = apply(
        &mut c,
        MapEdit::Reference {
            source: a.id.clone(),
            target: b.id.clone(),
        },
    )
    .unwrap();
    let count: i64 = c
        .query_row("SELECT COUNT(*) FROM page_reference", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let redo = apply(&mut c, undo).unwrap();
    assert!(repo::block::list(&c, &a.id).unwrap().is_empty());
    let undo = apply(&mut c, redo).unwrap();
    let block = repo::block::list(&c, &a.id).unwrap().remove(0);
    c.execute(
        "UPDATE block SET revision=revision+1,data_json='{}' WHERE id=?",
        [&block.id],
    )
    .unwrap();
    assert!(apply(&mut c, undo).is_err());
    assert_eq!(repo::block::list(&c, &a.id).unwrap().len(), 1);
}
#[test]
fn moves_restore_parent_and_order_and_reject_cycles() {
    let (mut c, _, a, b) = setup();
    let undo = apply(
        &mut c,
        MapEdit::Move {
            source: b.id.clone(),
            target: Some(a.id.clone()),
        },
    )
    .unwrap();
    assert!(apply(
        &mut c,
        MapEdit::Move {
            source: a.id.clone(),
            target: Some(b.id.clone())
        }
    )
    .is_err());
    // Undoing a later content edit must not invalidate undo of the earlier nesting change.
    let undo_tag = apply(
        &mut c,
        MapEdit::Tag {
            page_ids: vec![b.id.clone()],
            tag: "later".into(),
        },
    )
    .unwrap();
    apply(&mut c, undo_tag).unwrap();
    apply(&mut c, undo).unwrap();
    let restored = repo::page::get(&c, &b.id).unwrap().unwrap();
    assert_eq!(restored.parent_page_id, b.parent_page_id);
    assert_eq!(restored.position, b.position);
}

#[test]
fn ten_thousand_pages_remain_searchable_beyond_the_render_limit() {
    let (mut c, ws, _, _) = setup();
    let tx = c.transaction().unwrap();
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO page(id,workspace_id,title,created_at,updated_at) VALUES(?,?,?,?,?)",
            )
            .unwrap();
        let stamp = now();
        for i in 0..10000 {
            insert
                .execute(params![
                    new_id(),
                    ws.id,
                    format!("Benchmark page {i}"),
                    stamp,
                    stamp
                ])
                .unwrap();
        }
    }
    tx.commit().unwrap();
    let start = std::time::Instant::now();
    let graph = snapshot(
        &c,
        &MapQuery {
            workspace_ids: vec![ws.id.clone()],
            limit: Some(5000),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(graph.total_nodes, 10002);
    assert!(graph.truncated);
    assert_eq!(
        graph.nodes.iter().filter(|n| n.kind != "workspace").count(),
        5000
    );
    let hit = snapshot(
        &c,
        &MapQuery {
            search: "Benchmark page 9999".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(hit.total_nodes, 1);
    assert!(hit.nodes.iter().any(|n| n.title == "Benchmark page 9999"));
    println!(
        "10,002-page scoped snapshot and global search: {:?}",
        start.elapsed()
    );
}
#[test]
fn bulk_tags_roll_back_every_page_on_failure_and_update_search() {
    let (mut c, ws, a, b) = setup();
    assert!(apply(
        &mut c,
        MapEdit::Tag {
            page_ids: vec![a.id.clone(), new_id()],
            tag: "focus".into()
        }
    )
    .is_err());
    assert!(repo::block::list(&c, &a.id).unwrap().is_empty());
    let undo = apply(
        &mut c,
        MapEdit::Tag {
            page_ids: vec![a.id.clone(), b.id.clone()],
            tag: "focus".into(),
        },
    )
    .unwrap();
    let graph = snapshot(
        &c,
        &MapQuery {
            workspace_ids: vec![ws.id],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        graph
            .nodes
            .iter()
            .filter(|n| n.tags.contains(&"focus".into()))
            .count(),
        2
    );
    apply(&mut c, undo).unwrap();
    let count: i64 = c
        .query_row("SELECT COUNT(*) FROM block_tag", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
#[test]
fn cross_workspace_references_appear_in_global_summary() {
    let (mut c, _, a, _) = setup();
    let w = services::workspace::create(
        &mut c,
        WorkspaceCreate {
            name: "Other".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let b = services::page::create(
        &mut c,
        PageCreate {
            workspace_id: w.id.clone(),
            title: None,
            parent_page_id: None,
            icon: None,
        },
    )
    .unwrap();
    apply(
        &mut c,
        MapEdit::Reference {
            source: a.id.clone(),
            target: b.id.clone(),
        },
    )
    .unwrap();
    let graph = snapshot(&c, &MapQuery::default()).unwrap();
    assert_eq!(graph.edges.len(), 1);
    assert_eq!(graph.edges[0].target, format!("workspace:{}", w.id));
    let neighborhood = snapshot(
        &c,
        &MapQuery {
            page_id: Some(a.id),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(neighborhood.nodes.iter().any(|n| n.id == b.id));
}
#[test]
fn bulk_cells_are_atomic_undo_is_guarded_and_dependencies_cannot_cycle() {
    let (mut c, ws, _, _) = setup();
    let db = dbs::create_database(
        &mut c,
        databases::DatabaseCreate {
            workspace_id: ws.id,
            parent_page_id: None,
            title: Some("Tasks".into()),
        },
    )
    .unwrap();
    let p = dbs::add_property(
        &mut c,
        databases::PropertyCreate {
            database_id: db.database.id.clone(),
            name: "Notes".into(),
            property_type: "text".into(),
            config: None,
        },
    )
    .unwrap();
    let deps = dbs::add_property(
        &mut c,
        databases::PropertyCreate {
            database_id: db.database.id.clone(),
            name: "Blocks".into(),
            property_type: "relation".into(),
            config: Some(json!({"targetDatabaseId":db.database.id,"twoWay":false})),
        },
    )
    .unwrap();
    let create = |c: &mut Connection, name: &str| {
        dbs::create_record(
            c,
            databases::RecordCreate {
                database_id: db.database.id.clone(),
                title: Some(name.into()),
                values: Default::default(),
                template_id: None,
            },
        )
        .unwrap()
    };
    let a = create(&mut c, "A");
    let b = create(&mut c, "B");
    assert!(apply(
        &mut c,
        MapEdit::SetProperty {
            page_ids: vec![a.page_id.clone(), new_id()],
            property_id: p.id.clone(),
            value: json!("changed")
        }
    )
    .is_err());
    assert!(dbs::load_rows(&c, &[a.id.clone()]).unwrap()[0]
        .values
        .get(&p.id)
        .is_none());
    let undo = apply(
        &mut c,
        MapEdit::SetProperty {
            page_ids: vec![a.page_id.clone(), b.page_id.clone()],
            property_id: p.id.clone(),
            value: json!("changed"),
        },
    )
    .unwrap();
    dbs::set_value(
        &mut c,
        databases::SetValue {
            record_id: b.id.clone(),
            property_id: p.id.clone(),
            value: json!("newer"),
        },
    )
    .unwrap();
    assert!(apply(&mut c, undo).is_err());
    assert_eq!(
        dbs::load_rows(&c, &[a.id.clone()]).unwrap()[0].values[&p.id],
        json!("changed")
    );
    let undo = apply(
        &mut c,
        MapEdit::Relation {
            source: a.page_id.clone(),
            target: b.page_id.clone(),
            property_id: deps.id.clone(),
            dependency: true,
        },
    )
    .unwrap();
    assert!(apply(
        &mut c,
        MapEdit::Relation {
            source: b.page_id.clone(),
            target: a.page_id.clone(),
            property_id: deps.id.clone(),
            dependency: true
        }
    )
    .is_err());
    apply(&mut c, undo).unwrap();
    let count: i64 = c
        .query_row("SELECT COUNT(*) FROM db_relation", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

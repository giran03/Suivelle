//! Opt-in release probes. Fixtures live in a unique temp directory, never in app data.
use crate::{database, domain::*, history, repositories, services, transfer};
use rusqlite::params;
use std::{collections::HashMap, time::Instant};

#[test]
#[ignore = "benchmark"]
fn workspace_performance() {
    let root = std::env::temp_dir().join(format!("tako-perf-{}", new_id()));
    std::fs::create_dir_all(&root).unwrap();
    let db_path = root.join("workspace.db");
    let mut conn = database::open(&db_path).unwrap();
    let ws = services::workspace::create(
        &mut conn,
        WorkspaceCreate {
            name: "Benchmark".into(),
            icon: None,
            ..Default::default()
        },
    )
    .unwrap();
    let page = services::page::create(
        &mut conn,
        PageCreate {
            workspace_id: ws.id.clone(),
            parent_page_id: None,
            title: Some("Large document".into()),
            icon: None,
        },
    )
    .unwrap();
    let tx = conn.transaction().unwrap();
    for i in 0..10_000 {
        tx.execute("INSERT INTO block (id,page_id,type,position,data_json,schema_version,created_at,updated_at) VALUES (?1,?2,'paragraph',?3,?4,2,'t','t')", params![new_id(), page.id, i, serde_json::json!({"content":[{"type":"text","text":format!("Paragraph {i}: local workspace benchmark text")}]}).to_string()]).unwrap();
        tx.execute("INSERT INTO page (id,workspace_id,title,position,created_at,updated_at) VALUES (?1,?2,?3,?4,'t','t')", params![new_id(), ws.id, format!("Note {i}"), i]).unwrap();
    }
    tx.commit().unwrap();
    let start = Instant::now();
    let blocks = repositories::block::list(&conn, &page.id).unwrap();
    println!(
        "10k block load: {:?}; serialized bytes: {}",
        start.elapsed(),
        serde_json::to_vec(&blocks).unwrap().len()
    );
    assert_eq!(blocks.len(), 10_000);
    let start = Instant::now();
    let version = history::snapshot(&conn, &page.id, "auto").unwrap().unwrap();
    println!("10k block snapshot: {:?}", start.elapsed());
    let start = Instant::now();
    assert!(history::snapshot(&conn, &page.id, "auto")
        .unwrap()
        .is_none());
    println!("unchanged checkpoint: {:?}", start.elapsed());
    let start = Instant::now();
    assert_eq!(
        history::get(&conn, &version.id).unwrap().blocks.len(),
        10_000
    );
    println!("history preview: {:?}", start.elapsed());
    drop(blocks);
    drop(conn);
    let start = Instant::now();
    let mut conn = database::open(&db_path).unwrap();
    println!(
        "existing database open + integrity check: {:?}; file bytes: {}",
        start.elapsed(),
        std::fs::metadata(&db_path).unwrap().len()
    );
    let csv_path = root.join("records.csv");
    let mut csv = String::from("Title,Points,Notes\n");
    for i in 0..10_000 {
        csv.push_str(&format!("Task {i},{},Benchmark note {i}\n", i % 100));
    }
    std::fs::write(&csv_path, csv).unwrap();
    let start = Instant::now();
    let staged = transfer::import::stage_files(vec![csv_path]).unwrap();
    println!("10k CSV stage: {:?}", start.elapsed());
    let start = Instant::now();
    let result = transfer::import::apply(
        &mut conn,
        &root.join("attachments"),
        &ws.id,
        &staged,
        &HashMap::new(),
    )
    .unwrap();
    println!("10k CSV atomic apply: {:?}", start.elapsed());
    assert_eq!(result.records, 10_000);
    drop(conn);
    std::fs::remove_dir_all(root).unwrap();
}

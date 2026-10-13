use super::*;
use crate::database::open_in_memory;
use crate::domain::*;
use crate::search::{search, SearchInput};
use crate::services;
use chrono::TimeZone;

fn setup() -> (Connection, Workspace, Page) {
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
    let page = services::page::create(
        &mut conn,
        PageCreate {
            workspace_id: ws.id.clone(),
            parent_page_id: None,
            title: Some("Notes".into()),
            icon: None,
        },
    )
    .unwrap();
    (conn, ws, page)
}

fn upsert(id: &str, parent: Option<&str>, pos: f64, text: &str) -> BlockUpsert {
    BlockUpsert {
        id: id.into(),
        parent_block_id: parent.map(String::from),
        block_type: "paragraph".into(),
        position: pos,
        data_json: format!("{{\"content\":[{{\"type\":\"text\",\"text\":\"{text}\"}}]}}"),
        schema_version: 2,
    }
}

fn edit(conn: &mut Connection, page: &str, upserts: Vec<BlockUpsert>, deletes: Vec<String>) {
    services::block::apply_batch(
        conn,
        BlockBatch {
            page_id: page.into(),
            upserts,
            delete_ids: deletes,
        },
    )
    .unwrap();
}

fn bid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn texts(conn: &Connection, page: &str) -> Vec<String> {
    let mut blocks = repo::block::list(conn, page).unwrap();
    blocks.sort_by(|a, b| a.position.total_cmp(&b.position));
    blocks
        .iter()
        .map(|b| crate::search::text::plain_text(&b.block_type, b.schema_version, &b.data_json))
        .collect()
}

fn count(conn: &Connection, page: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM page_revision WHERE page_id = ?1",
        [page],
        |r| r.get(0),
    )
    .unwrap()
}

fn age_latest(conn: &Connection, page: &str, minutes: i64) {
    let t = (Utc::now() - Duration::minutes(minutes))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    conn.execute("UPDATE page_revision SET created_at = ?2 WHERE page_id = ?1 AND seq = (SELECT MAX(seq) FROM page_revision WHERE page_id = ?1)", params![page, t]).unwrap();
}

fn find(conn: &Connection, ws: &str, q: &str) -> Vec<crate::search::SearchHit> {
    search(
        conn,
        &SearchInput {
            workspace_id: ws.into(),
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
fn edits_snapshot_the_page_as_it_was_but_not_every_time() {
    let (mut conn, _ws, page) = setup();
    // An empty page has nothing worth saving.
    edit(
        &mut conn,
        &page.id,
        vec![upsert(&bid(1), None, 1.0, "first")],
        vec![],
    );
    assert_eq!(count(&conn, &page.id), 0);
    // The next edit saves "first" because the page has no snapshot yet.
    edit(
        &mut conn,
        &page.id,
        vec![upsert(&bid(1), None, 1.0, "second")],
        vec![],
    );
    assert_eq!(count(&conn, &page.id), 1);
    assert_eq!(
        get(&conn, &list(&conn, &page.id).unwrap()[0].id)
            .unwrap()
            .blocks[0]
            .text,
        "first"
    );
    // Quick follow-up edits do not add more.
    edit(
        &mut conn,
        &page.id,
        vec![upsert(&bid(1), None, 1.0, "third")],
        vec![],
    );
    edit(
        &mut conn,
        &page.id,
        vec![upsert(&bid(2), None, 2.0, "x")],
        vec![],
    );
    assert_eq!(count(&conn, &page.id), 1);
    // After ten quiet minutes the next edit saves the state before it.
    age_latest(&conn, &page.id, 11);
    edit(
        &mut conn,
        &page.id,
        vec![upsert(&bid(1), None, 1.0, "fourth")],
        vec![],
    );
    assert_eq!(count(&conn, &page.id), 2);
    // A large change saves immediately.
    let many: Vec<BlockUpsert> = (10..10 + STRUCTURAL_OPS as u32)
        .map(|i| upsert(&bid(i), None, i as f64, "bulk"))
        .collect();
    edit(&mut conn, &page.id, many, vec![]);
    assert_eq!(count(&conn, &page.id), 3);
    // Identical states are not stored twice.
    checkpoint(&conn, &page.id).unwrap();
    checkpoint(&conn, &page.id).unwrap();
    assert_eq!(count(&conn, &page.id), 4);
}

#[test]
fn manual_versions_always_save_and_are_never_pruned() {
    let (mut conn, _ws, page) = setup();
    edit(
        &mut conn,
        &page.id,
        vec![upsert(&bid(1), None, 1.0, "a")],
        vec![],
    );
    let a = save_version(&conn, &page.id).unwrap();
    let b = save_version(&conn, &page.id).unwrap();
    assert_eq!((a.kind.as_str(), b.seq), ("manual", a.seq + 1));
    for i in 0..70 {
        edit(
            &mut conn,
            &page.id,
            vec![upsert(&bid(1), None, 1.0, &format!("v{i}"))],
            vec![],
        );
        checkpoint(&conn, &page.id).unwrap();
    }
    let all = list(&conn, &page.id).unwrap();
    assert_eq!(all.iter().filter(|r| r.kind == "manual").count(), 2);
    assert_eq!(
        all.iter().filter(|r| r.kind != "manual").count(),
        KEEP_RECENT
    );
    assert!(all.windows(2).all(|w| w[0].seq > w[1].seq), "newest first");
}

#[test]
fn pruning_keeps_the_newest_of_each_recent_day() {
    let (conn, _ws, page) = setup();
    let now = Utc.with_ymd_and_hms(2026, 6, 30, 12, 0, 0).unwrap();
    let insert = |seq: i64, at: DateTime<Utc>| {
        conn.execute(
            "INSERT INTO page_revision (id, page_id, seq, kind, title, block_count, content_hash, snapshot, created_at) VALUES (?1, ?2, ?3, 'auto', 't', 0, ?4, x'00', ?5)",
            params![new_id(), page.id, seq, format!("h{seq}"), at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)],
        )
        .unwrap();
    };
    // 50 recent ones, then two on each of three older days (inside 30 days), then two 40 days old.
    for i in 0..50 {
        insert(100 + i, now - Duration::minutes(i));
    }
    for (day, base) in [(5, 10), (6, 20), (7, 30)] {
        insert(base, now - Duration::days(day) - Duration::hours(1));
        insert(base + 1, now - Duration::days(day));
    }
    insert(1, now - Duration::days(40));
    insert(2, now - Duration::days(40) - Duration::hours(1));
    let removed = prune(&conn, &page.id, now).unwrap();
    assert_eq!(removed, 5);
    assert_eq!(count(&conn, &page.id), 50 + 3);
    let kept: Vec<i64> = list(&conn, &page.id)
        .unwrap()
        .into_iter()
        .map(|r| r.seq)
        .filter(|s| *s < 100)
        .collect();
    assert_eq!(kept, [31, 21, 11], "the newest of each day survives");
}

#[test]
fn preview_marks_what_restoring_would_change() {
    let (mut conn, _ws, page) = setup();
    edit(
        &mut conn,
        &page.id,
        vec![
            upsert(&bid(1), None, 1.0, "keep"),
            upsert(&bid(2), None, 2.0, "will change"),
            upsert(&bid(3), None, 3.0, "will vanish"),
            upsert(&bid(4), Some(&bid(3)), 1.0, "child"),
        ],
        vec![],
    );
    let v = save_version(&conn, &page.id).unwrap();
    edit(
        &mut conn,
        &page.id,
        vec![
            upsert(&bid(2), None, 2.0, "changed now"),
            upsert(&bid(5), None, 5.0, "new block"),
        ],
        vec![bid(3)],
    );
    let d = get(&conn, &v.id).unwrap();
    let flags: Vec<(&str, &str, usize)> = d
        .blocks
        .iter()
        .map(|b| (b.text.as_str(), b.change, b.depth))
        .collect();
    assert_eq!(
        flags,
        [
            ("keep", "same", 0),
            ("will change", "changed", 0),
            ("will vanish", "added", 0),
            ("child", "added", 1)
        ]
    );
    assert_eq!(
        d.removed
            .iter()
            .map(|b| b.text.as_str())
            .collect::<Vec<_>>(),
        ["new block"]
    );
    assert_eq!(d.current_title, "Notes");
}

#[test]
fn restore_replaces_the_page_and_can_itself_be_undone() {
    let (mut conn, ws, page) = setup();
    edit(
        &mut conn,
        &page.id,
        vec![
            upsert(&bid(1), None, 1.0, "original alpha"),
            upsert(&bid(2), None, 2.0, "second"),
        ],
        vec![],
    );
    let v = save_version(&conn, &page.id).unwrap();
    // Change text, remove a block, add one, and retitle.
    edit(
        &mut conn,
        &page.id,
        vec![
            upsert(&bid(1), None, 1.0, "rewritten zeta"),
            upsert(&bid(3), None, 3.0, "extra"),
        ],
        vec![bid(2)],
    );
    let mut p = repo::page::get(&conn, &page.id).unwrap().unwrap();
    p.title = "Renamed".into();
    repo::page::update(&conn, &p).unwrap();

    let safety = restore(&mut conn, &v.id)
        .unwrap()
        .expect("the current state was saved first");
    assert_eq!(texts(&conn, &page.id), ["original alpha", "second"]);
    assert_eq!(
        repo::page::get(&conn, &page.id).unwrap().unwrap().title,
        "Notes"
    );

    // Search follows the restored content.
    assert!(!find(&conn, &ws.id, "alpha").is_empty());
    assert!(find(&conn, &ws.id, "zeta").is_empty());
    assert!(find(&conn, &ws.id, "extra").is_empty());

    // Restoring the safety snapshot undoes the restore.
    restore(&mut conn, &safety).unwrap();
    assert_eq!(texts(&conn, &page.id), ["rewritten zeta", "extra"]);
    assert_eq!(
        repo::page::get(&conn, &page.id).unwrap().unwrap().title,
        "Renamed"
    );
    assert!(!find(&conn, &ws.id, "zeta").is_empty());
    assert!(find(&conn, &ws.id, "alpha").is_empty());
}

#[test]
fn restoring_nested_blocks_and_guarding_bad_requests() {
    let (mut conn, _ws, page) = setup();
    edit(
        &mut conn,
        &page.id,
        vec![
            upsert(&bid(1), None, 1.0, "parent"),
            upsert(&bid(2), Some(&bid(1)), 1.0, "child"),
            upsert(&bid(3), Some(&bid(2)), 1.0, "grandchild"),
        ],
        vec![],
    );
    let v = save_version(&conn, &page.id).unwrap();
    edit(&mut conn, &page.id, vec![], vec![bid(1)]);
    assert!(texts(&conn, &page.id).is_empty());
    restore(&mut conn, &v.id).unwrap();
    assert_eq!(texts(&conn, &page.id).len(), 3);
    let blocks = repo::block::list(&conn, &page.id).unwrap();
    assert_eq!(
        blocks
            .iter()
            .find(|b| b.id == bid(3))
            .unwrap()
            .parent_block_id
            .as_deref(),
        Some(bid(2).as_str())
    );

    assert!(matches!(
        restore(&mut conn, "not-an-id"),
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        restore(&mut conn, &new_id()),
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        save_version(&conn, &new_id()),
        Err(AppError::NotFound(_))
    ));
    // A trashed page cannot be restored into.
    services::page::delete(&mut conn, &page.id).unwrap();
    assert!(matches!(
        restore(&mut conn, &v.id),
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        save_version(&conn, &page.id),
        Err(AppError::NotFound(_))
    ));
    // History leaves with the page.
    services::page::restore(&mut conn, &page.id).unwrap();
    assert!(count(&conn, &page.id) > 0);
    services::page::delete(&mut conn, &page.id).unwrap();
    services::page::delete_permanent(&mut conn, &page.id).unwrap();
    assert_eq!(count(&conn, &page.id), 0);
}

#[test]
fn a_corrupt_snapshot_is_reported_not_applied() {
    let (mut conn, _ws, page) = setup();
    edit(
        &mut conn,
        &page.id,
        vec![upsert(&bid(1), None, 1.0, "text")],
        vec![],
    );
    let v = save_version(&conn, &page.id).unwrap();
    conn.execute(
        "UPDATE page_revision SET snapshot = x'deadbeef' WHERE id = ?1",
        [&v.id],
    )
    .unwrap();
    assert!(get(&conn, &v.id).is_err());
    assert!(restore(&mut conn, &v.id).is_err());
    assert_eq!(texts(&conn, &page.id), ["text"], "the page is untouched");
}

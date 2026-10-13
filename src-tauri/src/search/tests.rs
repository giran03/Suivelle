use super::*;
use crate::database::open_in_memory;
use crate::domain::*;
use crate::repositories as repo;
use crate::services;

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

fn page(conn: &mut Connection, ws: &Workspace, parent: Option<&str>, title: &str) -> Page {
    services::page::create(
        conn,
        PageCreate {
            workspace_id: ws.id.clone(),
            parent_page_id: parent.map(String::from),
            title: Some(title.into()),
            icon: None,
        },
    )
    .unwrap()
}

fn rich(text: &str) -> String {
    format!(r#"{{"content":[{{"type":"text","text":"{text}"}}]}}"#)
}

fn add_block(conn: &mut Connection, page: &Page, block_type: &str, data: String) -> String {
    let id = new_id();
    services::block::apply_batch(
        conn,
        BlockBatch {
            page_id: page.id.clone(),
            upserts: vec![BlockUpsert {
                id: id.clone(),
                parent_block_id: None,
                block_type: block_type.into(),
                position: 0.0,
                data_json: data,
                schema_version: 2,
            }],
            delete_ids: vec![],
        },
    )
    .unwrap();
    id
}

fn find(conn: &Connection, ws: &Workspace, q: &str) -> Vec<SearchHit> {
    search(
        conn,
        &SearchInput {
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
fn finds_pages_by_title_prefix_and_text_inside_pages() {
    let (mut conn, ws) = setup();
    let p = page(&mut conn, &ws, None, "Combat design");
    add_block(
        &mut conn,
        &p,
        "paragraph",
        rich("The parry window is six frames"),
    );
    page(&mut conn, &ws, None, "Sprint planning");

    let by_title = find(&conn, &ws, "comb");
    assert_eq!(by_title.len(), 1);
    assert_eq!(by_title[0].kind, "page");
    assert!(by_title[0].snippet.contains(MARK_START));

    let by_text = find(&conn, &ws, "parry fra");
    assert_eq!(by_text.len(), 1);
    assert_eq!(by_text[0].kind, "block");
    assert_eq!(by_text[0].page_title, "Combat design");
    assert!(by_text[0]
        .snippet
        .contains(&format!("{MARK_START}parry{MARK_END}")));
    assert!(find(&conn, &ws, "nonexistent").is_empty());
}

#[test]
fn ranks_title_and_heading_matches_above_body_text() {
    let (mut conn, ws) = setup();
    let a = page(&mut conn, &ws, None, "Notes about dragons");
    let b = page(&mut conn, &ws, None, "Bestiary");
    add_block(
        &mut conn,
        &b,
        "paragraph",
        rich("dragons are large and dangerous"),
    );
    add_block(&mut conn, &b, "heading_2", rich("Dragons"));
    let hits = find(&conn, &ws, "dragons");
    assert_eq!(hits.len(), 3);
    assert_eq!(hits.last().unwrap().kind, "block");
    assert!(hits
        .iter()
        .take(2)
        .all(|h| h.page_id == a.id || h.block_id.is_some()));
    assert_eq!(hits[0].page_id.len(), 36);
    // The body-only match is last.
    assert!(!hits[2].snippet.contains("Dragons"));
}

#[test]
fn titles_only_ignores_body_text() {
    let (mut conn, ws) = setup();
    let p = page(&mut conn, &ws, None, "Plans");
    add_block(&mut conn, &p, "paragraph", rich("secret roadmap"));
    let hits = search(
        &conn,
        &SearchInput {
            workspace_id: ws.id.clone(),
            query: "roadmap".into(),
            titles_only: true,
            modified_within_days: None,
            limit: None,
            offset: None,
        },
    )
    .unwrap();
    assert!(hits.is_empty());
    assert_eq!(find(&conn, &ws, "roadmap").len(), 1);
}

#[test]
fn odd_queries_never_error() {
    let (mut conn, ws) = setup();
    page(
        &mut conn,
        &ws,
        None,
        "C++ and \"quotes\" (parens): AND OR NOT",
    );
    for q in [
        "\"",
        "(",
        "a AND",
        "NEAR(a b)",
        "*",
        "title:",
        "x -y",
        "'; DROP TABLE page; --",
        "😀",
        "  ",
        "-",
        "\\",
    ] {
        find(&conn, &ws, q);
    }
    assert_eq!(find(&conn, &ws, "quotes").len(), 1);
    assert!(search(
        &conn,
        &SearchInput {
            workspace_id: ws.id.clone(),
            query: "x".repeat(MAX_QUERY_CHARS + 1),
            titles_only: false,
            modified_within_days: None,
            limit: None,
            offset: None
        }
    )
    .is_err());
}

#[test]
fn matches_accented_and_non_latin_text() {
    let (mut conn, ws) = setup();
    page(&mut conn, &ws, None, "Café résumé");
    page(&mut conn, &ws, None, "日本語のメモ");
    assert_eq!(find(&conn, &ws, "cafe resume").len(), 1);
    assert_eq!(find(&conn, &ws, "日本語").len(), 1);
}

#[test]
fn index_follows_renames_edits_and_deletes() {
    let (mut conn, ws) = setup();
    let p = page(&mut conn, &ws, None, "Alpha");
    let b = add_block(&mut conn, &p, "paragraph", rich("first draft text"));
    assert_eq!(find(&conn, &ws, "draft").len(), 1);

    // Edit the block.
    services::block::apply_batch(
        &mut conn,
        BlockBatch {
            page_id: p.id.clone(),
            upserts: vec![BlockUpsert {
                id: b.clone(),
                parent_block_id: None,
                block_type: "paragraph".into(),
                position: 0.0,
                data_json: rich("final copy"),
                schema_version: 2,
            }],
            delete_ids: vec![],
        },
    )
    .unwrap();
    assert!(find(&conn, &ws, "draft").is_empty());
    assert_eq!(find(&conn, &ws, "final").len(), 1);

    // Rename the page.
    services::page::update(
        &mut conn,
        PageUpdate {
            id: p.id.clone(),
            title: Some("Omega".into()),
            icon: None,
            cover: None,
            position: None,
            favorite: None,
            archived: None,
        },
    )
    .unwrap();
    assert!(find(&conn, &ws, "alpha").is_empty());
    assert_eq!(find(&conn, &ws, "omega").len(), 1);

    // Delete the block.
    services::block::delete(&mut conn, &b).unwrap();
    assert!(find(&conn, &ws, "final").is_empty());
}

#[test]
fn deleting_a_parent_block_removes_its_children_from_the_index() {
    let (mut conn, ws) = setup();
    let p = page(&mut conn, &ws, None, "Lists");
    let (parent, child) = (new_id(), new_id());
    let up = |id: &str, parent: Option<&str>, text: &str| BlockUpsert {
        id: id.into(),
        parent_block_id: parent.map(String::from),
        block_type: "bullet_list".into(),
        position: 0.0,
        data_json: rich(text),
        schema_version: 2,
    };
    services::block::apply_batch(
        &mut conn,
        BlockBatch {
            page_id: p.id.clone(),
            upserts: vec![
                up(&parent, None, "outer"),
                up(&child, Some(&parent), "innermost"),
            ],
            delete_ids: vec![],
        },
    )
    .unwrap();
    assert_eq!(find(&conn, &ws, "innermost").len(), 1);
    services::block::apply_batch(
        &mut conn,
        BlockBatch {
            page_id: p.id.clone(),
            upserts: vec![],
            delete_ids: vec![parent],
        },
    )
    .unwrap();
    assert!(find(&conn, &ws, "innermost").is_empty());
    assert!(find(&conn, &ws, "outer").is_empty());
}

#[test]
fn trashed_pages_are_hidden_and_return_on_restore_without_reindexing() {
    let (mut conn, ws) = setup();
    let p = page(&mut conn, &ws, None, "Hideaway");
    add_block(&mut conn, &p, "paragraph", rich("hidden words"));
    services::page::delete(&mut conn, &p.id).unwrap();
    assert!(find(&conn, &ws, "hideaway").is_empty());
    assert!(find(&conn, &ws, "hidden").is_empty());
    services::page::restore(&mut conn, &p.id).unwrap();
    assert_eq!(find(&conn, &ws, "hideaway").len(), 1);
    assert_eq!(find(&conn, &ws, "hidden").len(), 1);
}

#[test]
fn permanent_delete_and_empty_trash_clear_the_index_and_references() {
    let (mut conn, ws) = setup();
    let target = page(&mut conn, &ws, None, "Target");
    let src = page(&mut conn, &ws, None, "Source");
    let child = page(&mut conn, &ws, Some(&src.id), "Nested source");
    add_block(&mut conn, &child, "paragraph", rich("needle"));
    add_block(
        &mut conn,
        &src,
        "paragraph",
        format!(
            r#"{{"content":[{{"type":"pageMention","attrs":{{"pageId":"{}"}}}}]}}"#,
            target.id
        ),
    );
    services::page::delete(&mut conn, &src.id).unwrap();
    services::page::delete_permanent(&mut conn, &src.id).unwrap();
    let docs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM search_doc WHERE page_id IN (?1, ?2)",
            params![src.id, child.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(docs, 0);
    assert!(backlinks(&conn, &target.id).unwrap().is_empty());

    // Empty trash removes pages with all their documents; references *to* a deleted page go too.
    let gone = page(&mut conn, &ws, None, "Gone soon");
    add_block(
        &mut conn,
        &target,
        "paragraph",
        format!(
            r#"{{"content":[{{"type":"pageMention","attrs":{{"pageId":"{}"}}}}]}}"#,
            gone.id
        ),
    );
    services::page::delete(&mut conn, &gone.id).unwrap();
    services::page::empty_trash(&mut conn, &ws.id).unwrap();
    assert!(find(&conn, &ws, "gone soon").is_empty());
    let refs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM page_reference WHERE target_page_id = ?1",
            [&gone.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(refs, 0);
}

#[test]
fn code_and_equations_are_not_indexed_but_media_names_are() {
    let (mut conn, ws) = setup();
    let p = page(&mut conn, &ws, None, "Assets");
    add_block(
        &mut conn,
        &p,
        "code",
        r#"{"language":"rust","text":"fn uniquefunction() {}"}"#.into(),
    );
    add_block(
        &mut conn,
        &p,
        "equation",
        r#"{"latex":"uniquelatex"}"#.into(),
    );
    add_block(&mut conn, &p, "image", r#"{"attachment":{"id":"a","hash":"h","name":"arena-map.png","mime":"image/png","size":1}}"#.into());
    assert!(find(&conn, &ws, "uniquefunction").is_empty());
    assert!(find(&conn, &ws, "uniquelatex").is_empty());
    assert_eq!(find(&conn, &ws, "arena").len(), 1);
}

#[test]
fn modified_filter_uses_content_edits() {
    let (mut conn, ws) = setup();
    let p = page(&mut conn, &ws, None, "Recent work");
    conn.execute(
        "UPDATE page SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
        [&p.id],
    )
    .unwrap();
    let recent = |conn: &Connection| {
        search(
            conn,
            &SearchInput {
                workspace_id: ws.id.clone(),
                query: "recent".into(),
                titles_only: false,
                modified_within_days: Some(7),
                limit: None,
                offset: None,
            },
        )
        .unwrap()
    };
    assert!(recent(&conn).is_empty());
    add_block(&mut conn, &p, "paragraph", rich("edited today"));
    assert_eq!(recent(&conn).len(), 1);
}

#[test]
fn paging_and_limits() {
    let (mut conn, ws) = setup();
    for i in 0..12 {
        page(&mut conn, &ws, None, &format!("Chapter {i}"));
    }
    let first = search(
        &conn,
        &SearchInput {
            workspace_id: ws.id.clone(),
            query: "chapter".into(),
            titles_only: true,
            modified_within_days: None,
            limit: Some(5),
            offset: Some(0),
        },
    )
    .unwrap();
    let second = search(
        &conn,
        &SearchInput {
            workspace_id: ws.id.clone(),
            query: "chapter".into(),
            titles_only: true,
            modified_within_days: None,
            limit: Some(5),
            offset: Some(5),
        },
    )
    .unwrap();
    assert_eq!((first.len(), second.len()), (5, 5));
    assert!(first
        .iter()
        .all(|a| second.iter().all(|b| a.page_id != b.page_id)));
    let all = search(
        &conn,
        &SearchInput {
            workspace_id: ws.id.clone(),
            query: "chapter".into(),
            titles_only: true,
            modified_within_days: None,
            limit: Some(500),
            offset: None,
        },
    )
    .unwrap();
    assert_eq!(all.len(), 12);
}

#[test]
fn backlinks_list_mentions_and_internal_links_with_context() {
    let (mut conn, ws) = setup();
    let target = page(&mut conn, &ws, None, "Target");
    let a = page(&mut conn, &ws, None, "Mentions it");
    let b = page(&mut conn, &ws, None, "Links it");
    let c = page(&mut conn, &ws, None, "Ignores it");
    add_block(
        &mut conn,
        &a,
        "paragraph",
        format!(
            r#"{{"content":[{{"type":"text","text":"see "}},{{"type":"pageMention","attrs":{{"pageId":"{}"}}}},{{"type":"text","text":" for details"}}]}}"#,
            target.id
        ),
    );
    add_block(
        &mut conn,
        &b,
        "paragraph",
        format!(
            r#"{{"content":[{{"type":"text","text":"docs","marks":[{{"type":"link","attrs":{{"href":"suivelle://page/{}"}}}}]}}]}}"#,
            target.id
        ),
    );
    add_block(&mut conn, &c, "paragraph", rich("nothing here"));
    add_block(
        &mut conn,
        &target,
        "paragraph",
        format!(
            r#"{{"content":[{{"type":"pageMention","attrs":{{"pageId":"{}"}}}}]}}"#,
            target.id
        ),
    );

    let links = backlinks(&conn, &target.id).unwrap();
    let mut titles: Vec<_> = links.iter().map(|l| l.source_page_title.as_str()).collect();
    titles.sort();
    assert_eq!(titles, ["Links it", "Mentions it"]); // self reference excluded
    assert!(links.iter().any(|l| l.snippet == "see for details"));

    // Trashing a source hides it; removing the mention removes the reference.
    services::page::delete(&mut conn, &a.id).unwrap();
    assert_eq!(backlinks(&conn, &target.id).unwrap().len(), 1);
    services::page::restore(&mut conn, &a.id).unwrap();
    let block_id = links
        .iter()
        .find(|l| l.source_page_id == a.id)
        .unwrap()
        .source_block_id
        .clone();
    services::block::apply_batch(
        &mut conn,
        BlockBatch {
            page_id: a.id.clone(),
            upserts: vec![BlockUpsert {
                id: block_id,
                parent_block_id: None,
                block_type: "paragraph".into(),
                position: 0.0,
                data_json: rich("no link now"),
                schema_version: 2,
            }],
            delete_ids: vec![],
        },
    )
    .unwrap();
    assert_eq!(backlinks(&conn, &target.id).unwrap().len(), 1);
}

#[test]
fn rebuild_reproduces_the_incremental_index_and_startup_repairs_an_empty_one() {
    let (mut conn, ws) = setup();
    let t = page(&mut conn, &ws, None, "Target");
    let p = page(&mut conn, &ws, None, "Rebuild me");
    add_block(&mut conn, &p, "heading_1", rich("Heading words"));
    add_block(
        &mut conn,
        &p,
        "paragraph",
        format!(
            r#"{{"content":[{{"type":"text","text":"body words "}},{{"type":"pageMention","attrs":{{"pageId":"{}"}}}}]}}"#,
            t.id
        ),
    );
    let before = (
        find(&conn, &ws, "words").len(),
        backlinks(&conn, &t.id).unwrap().len(),
    );

    conn.execute("DELETE FROM search_fts", []).unwrap();
    conn.execute("DELETE FROM search_doc", []).unwrap();
    conn.execute("DELETE FROM page_reference", []).unwrap();
    assert!(find(&conn, &ws, "words").is_empty());

    index::ensure_index(&conn).unwrap();
    assert_eq!(
        (
            find(&conn, &ws, "words").len(),
            backlinks(&conn, &t.id).unwrap().len()
        ),
        before
    );
    let n = index::rebuild_workspace(&conn, &ws.id).unwrap();
    assert_eq!(n, 4); // two page titles + two blocks
    assert_eq!(find(&conn, &ws, "words").len(), before.0);
}

#[test]
fn page_titles_and_recents() {
    let (mut conn, ws) = setup();
    let a = page(&mut conn, &ws, None, "First");
    let b = page(&mut conn, &ws, None, "Second");
    services::page::delete(&mut conn, &b.id).unwrap();
    let titles = page_titles(&conn, &[a.id.clone(), b.id.clone(), new_id()]).unwrap();
    assert_eq!(titles.len(), 2);
    assert!(!titles.iter().find(|t| t.id == a.id).unwrap().deleted);
    assert!(titles.iter().find(|t| t.id == b.id).unwrap().deleted);
    assert!(page_titles(&conn, &["nope".into()]).is_err());

    let c = page(&mut conn, &ws, None, "Third");
    assert!(repo::page::list_recent(&conn, &ws.id, 8)
        .unwrap()
        .is_empty());
    repo::page::touch_opened(&conn, &a.id, "2026-01-01T00:00:00.000Z").unwrap();
    repo::page::touch_opened(&conn, &c.id, "2026-01-02T00:00:00.000Z").unwrap();
    assert_eq!(
        repo::page::touch_opened(&conn, &b.id, "2026-01-03T00:00:00.000Z").unwrap(),
        0
    ); // trashed pages are not tracked
    let recent = repo::page::list_recent(&conn, &ws.id, 8).unwrap();
    assert_eq!(
        recent.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(),
        ["Third", "First"]
    );
    // Opening a page does not count as editing it.
    assert_eq!(repo::page::get(&conn, &a.id).unwrap().unwrap().revision, 1);
}

#[test]
fn deleting_a_workspace_clears_its_index() {
    let (mut conn, ws) = setup();
    let other = services::workspace::create(
        &mut conn,
        WorkspaceCreate {
            name: "Other".into(),
            icon: None,
            ..Default::default()
        },
    )
    .unwrap();
    page(&mut conn, &other, None, "In other");
    services::workspace::delete(&mut conn, &other.id).unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM search_doc WHERE workspace_id = ?1",
            [&other.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
    assert!(find(&conn, &ws, "other").is_empty());
}

/// Run with `cargo test --release search_scales -- --ignored --nocapture`.
#[test]
#[ignore = "benchmark"]
fn search_scales_to_the_design_target() {
    let (mut conn, ws) = setup();
    let words = [
        "parry", "combat", "dragon", "sprint", "backlog", "wiki", "design", "release", "boss",
        "arena",
    ];
    let start = std::time::Instant::now();
    let tx = conn.transaction().unwrap();
    let mut n = 0u64;
    for i in 0..10_000 {
        let pid = new_id();
        let title = format!("{} {} {}", words[i % 10], words[(i / 10) % 10], i);
        tx.execute(
            "INSERT INTO page (id, workspace_id, title, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 't', 't')",
            params![pid, ws.id, title, i as f64],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO search_doc (key, workspace_id, page_id, block_id) VALUES (?1, ?2, ?3, NULL)",
            params![format!("p:{pid}"), ws.id, pid],
        )
        .unwrap();
        let id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO search_fts (rowid, title, body) VALUES (?1, ?2, '')",
            params![id, title],
        )
        .unwrap();
        for b in 0..10 {
            let text = format!(
                "{} {} notes number {} about {}",
                words[(i + b) % 10],
                words[(i * 3 + b) % 10],
                b,
                i
            );
            let bid = new_id();
            tx.execute(
                "INSERT INTO block (id, page_id, type, position, data_json, schema_version, created_at, updated_at) VALUES (?1, ?2, 'paragraph', ?3, ?4, 2, 't', 't')",
                params![bid, pid, b as f64, rich(&text)],
            )
            .unwrap();
            index::upsert_block(&tx, &ws.id, &pid, &bid, "paragraph", 2, &rich(&text)).unwrap();
            n += 1;
        }
    }
    tx.commit().unwrap();
    println!("indexed 10k pages / {n} blocks in {:?}", start.elapsed());
    for q in [
        "parry",
        "parry combat",
        "dragon notes 5",
        "sprint back",
        "zzzz",
    ] {
        let t = std::time::Instant::now();
        let hits = find(&conn, &ws, q);
        println!("{q:>16}: {:>3} hits in {:?}", hits.len(), t.elapsed());
    }
    let t = std::time::Instant::now();
    let r = index::rebuild_workspace(&conn, &ws.id).unwrap();
    println!("rebuild of {r} docs took {:?}", t.elapsed());
}

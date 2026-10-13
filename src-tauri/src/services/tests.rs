use super::*;
use crate::database::open_in_memory;

#[test]
fn create_with_image_is_atomic_and_owns_its_attachment() {
    let mut conn = open_in_memory().unwrap();
    let root = std::env::temp_dir().join(format!("suivelle-icon-{}", new_id()));
    let w = workspace::create_with_image(
        &mut conn,
        &root,
        WorkspaceCreate {
            name: "Studio".into(),
            ..Default::default()
        },
        "icon.gif",
        b"GIF89a",
    )
    .unwrap();
    let hash: String = conn
        .query_row(
            "SELECT hash FROM attachment WHERE workspace_id = ?1",
            [&w.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(w.icon, Some(format!("image:{hash}")));
    assert_eq!(
        repo::workspace::get(&conn, &w.id).unwrap().unwrap().icon,
        w.icon
    );
    // A write failure rolls back workspace creation too.
    let blocked = root.join("blocked");
    std::fs::write(&blocked, b"file").unwrap();
    assert!(workspace::create_with_image(
        &mut conn,
        &blocked,
        WorkspaceCreate {
            name: "Failed".into(),
            ..Default::default()
        },
        "icon.png",
        &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
    )
    .is_err());
    // A file that is not an image is refused even when its name says otherwise.
    assert!(workspace::create_with_image(
        &mut conn,
        &root,
        WorkspaceCreate {
            name: "Disguised".into(),
            ..Default::default()
        },
        "icon.png",
        b"plain text pretending to be a picture"
    )
    .is_err());
    assert!(workspace::create_with_image(
        &mut conn,
        &root,
        WorkspaceCreate {
            name: "Invalid".into(),
            ..Default::default()
        },
        "icon.txt",
        b"text"
    )
    .is_err());
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspace", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    std::fs::remove_dir_all(root).unwrap();
}

fn setup() -> (Connection, Workspace) {
    let mut conn = open_in_memory().unwrap();
    let ws = workspace::create(
        &mut conn,
        WorkspaceCreate {
            name: "Test".into(),
            icon: None,
            ..Default::default()
        },
    )
    .unwrap();
    (conn, ws)
}

fn new_page(conn: &mut Connection, ws: &Workspace, parent: Option<&str>, title: &str) -> Page {
    page::create(
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

fn new_block(conn: &mut Connection, page_id: &str, after: Option<&str>, text: &str) -> Block {
    block::create(
        conn,
        BlockCreate {
            page_id: page_id.into(),
            parent_block_id: None,
            block_type: "paragraph".into(),
            data_json: Some(format!("{{\"text\":\"{text}\"}}")),
            after_block_id: after.map(String::from),
        },
    )
    .unwrap()
}

#[test]
fn workspace_roundtrip_and_settings() {
    let (mut conn, ws) = setup();
    assert_eq!(
        repo::workspace::get_first(&conn).unwrap().unwrap().id,
        ws.id
    );
    let updated = workspace::update_settings(
        &mut conn,
        WorkspaceUpdateSettings {
            id: ws.id.clone(),
            settings_json: "{\"theme\":\"dark\"}".into(),
        },
    )
    .unwrap();
    assert_eq!(updated.settings_json, "{\"theme\":\"dark\"}");
    assert_eq!(updated.revision, 2);
}

#[test]
fn workspace_rejects_bad_input() {
    let (mut conn, ws) = setup();
    assert!(matches!(
        workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "  ".into(),
                icon: None,
                ..Default::default()
            }
        ),
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        workspace::update_settings(
            &mut conn,
            WorkspaceUpdateSettings {
                id: ws.id,
                settings_json: "[1]".into()
            }
        ),
        Err(AppError::Validation(_))
    ));
}

#[test]
fn page_hierarchy_and_ordering() {
    let (mut conn, ws) = setup();
    let a = new_page(&mut conn, &ws, None, "A");
    let b = new_page(&mut conn, &ws, None, "B");
    let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
    let roots = repo::page::list_children(&conn, &ws.id, None).unwrap();
    assert_eq!(
        roots.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(),
        ["A", "B"]
    );
    assert!(b.position > a.position);
    let kids = repo::page::list_children(&conn, &ws.id, Some(&a.id)).unwrap();
    assert_eq!(kids.len(), 1);
    assert_eq!(kids[0].id, a1.id);
}

#[test]
fn page_update_bumps_revision() {
    let (mut conn, ws) = setup();
    let p = new_page(&mut conn, &ws, None, "Old");
    let u = page::update(
        &mut conn,
        PageUpdate {
            id: p.id.clone(),
            title: Some("New".into()),
            icon: None,
            cover: None,
            position: None,
            favorite: Some(true),
            archived: None,
        },
    )
    .unwrap();
    assert_eq!(u.title, "New");
    assert!(u.favorite);
    let stored = repo::page::get(&conn, &p.id).unwrap().unwrap();
    assert_eq!(stored.revision, 2);
    assert_eq!(stored.title, "New");
}

#[test]
fn page_delete_is_soft_and_recursive() {
    let (mut conn, ws) = setup();
    let a = new_page(&mut conn, &ws, None, "A");
    let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
    page::delete(&mut conn, &a.id).unwrap();
    assert!(repo::page::list_children(&conn, &ws.id, None)
        .unwrap()
        .is_empty());
    let stored = repo::page::get(&conn, &a1.id).unwrap().unwrap();
    assert!(stored.deleted_at.is_some());
    assert!(matches!(
        page::delete(&mut conn, &a.id),
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        page::create(
            &mut conn,
            PageCreate {
                workspace_id: ws.id.clone(),
                parent_page_id: Some(a.id),
                title: None,
                icon: None
            }
        ),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn page_validation() {
    let (mut conn, ws) = setup();
    let long = "x".repeat(MAX_TITLE_LEN + 1);
    assert!(matches!(
        page::create(
            &mut conn,
            PageCreate {
                workspace_id: ws.id.clone(),
                parent_page_id: None,
                title: Some(long),
                icon: None
            }
        ),
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        page::create(
            &mut conn,
            PageCreate {
                workspace_id: "nope".into(),
                parent_page_id: None,
                title: None,
                icon: None
            }
        ),
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        page::create(
            &mut conn,
            PageCreate {
                workspace_id: new_id(),
                parent_page_id: None,
                title: None,
                icon: None
            }
        ),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn block_crud_and_ordering() {
    let (mut conn, ws) = setup();
    let p = new_page(&mut conn, &ws, None, "P");
    let b1 = new_block(&mut conn, &p.id, None, "one");
    let b3 = new_block(&mut conn, &p.id, None, "three");
    let b2 = new_block(&mut conn, &p.id, Some(&b1.id), "two");
    let listed = repo::block::list(&conn, &p.id).unwrap();
    assert_eq!(
        listed.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(),
        [&b1.id, &b2.id, &b3.id]
    );

    let u = block::update(
        &mut conn,
        BlockUpdate {
            id: b2.id.clone(),
            block_type: Some("heading_1".into()),
            data_json: Some("{\"text\":\"2\"}".into()),
            position: None,
        },
    )
    .unwrap();
    assert_eq!(u.block_type, "heading_1");
    assert_eq!(
        repo::block::get(&conn, &b2.id).unwrap().unwrap().revision,
        2
    );

    block::delete(&mut conn, &b2.id).unwrap();
    assert_eq!(repo::block::list(&conn, &p.id).unwrap().len(), 2);
    assert!(matches!(
        block::delete(&mut conn, &b2.id),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn block_validation() {
    let (mut conn, ws) = setup();
    let p = new_page(&mut conn, &ws, None, "P");
    let bad = |t: &str, d: Option<&str>| BlockCreate {
        page_id: p.id.clone(),
        parent_block_id: None,
        block_type: t.into(),
        data_json: d.map(String::from),
        after_block_id: None,
    };
    // Cloned inputs so `conn` can be reborrowed.
    assert!(matches!(
        block::create(&mut conn, bad("not_a_block", None)),
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        block::create(&mut conn, bad("paragraph", Some("not json"))),
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        block::create(&mut conn, bad("paragraph", Some("[1]"))),
        Err(AppError::Validation(_))
    ));
    let huge = format!("{{\"t\":\"{}\"}}", "x".repeat(MAX_BLOCK_DATA_BYTES));
    assert!(matches!(
        block::create(&mut conn, bad("paragraph", Some(&huge))),
        Err(AppError::Validation(_))
    ));
}

#[test]
fn blocks_cannot_cross_pages() {
    let (mut conn, ws) = setup();
    let p1 = new_page(&mut conn, &ws, None, "P1");
    let p2 = new_page(&mut conn, &ws, None, "P2");
    let b = new_block(&mut conn, &p1.id, None, "x");
    let res = block::create(
        &mut conn,
        BlockCreate {
            page_id: p2.id,
            parent_block_id: Some(b.id),
            block_type: "paragraph".into(),
            data_json: None,
            after_block_id: None,
        },
    );
    assert!(matches!(res, Err(AppError::NotFound(_))));
}

#[test]
fn nested_blocks_cascade_on_delete() {
    let (mut conn, ws) = setup();
    let p = new_page(&mut conn, &ws, None, "P");
    let parent = new_block(&mut conn, &p.id, None, "parent");
    block::create(
        &mut conn,
        BlockCreate {
            page_id: p.id.clone(),
            parent_block_id: Some(parent.id.clone()),
            block_type: "paragraph".into(),
            data_json: None,
            after_block_id: None,
        },
    )
    .unwrap();
    assert_eq!(repo::block::list(&conn, &p.id).unwrap().len(), 2);
    block::delete(&mut conn, &parent.id).unwrap();
    assert!(repo::block::list(&conn, &p.id).unwrap().is_empty());
}

fn titles(pages: &[Page]) -> Vec<&str> {
    pages.iter().map(|p| p.title.as_str()).collect()
}

fn mv(
    conn: &mut Connection,
    id: &str,
    parent: Option<&str>,
    before: Option<&str>,
) -> AppResult<Page> {
    page::move_page(
        conn,
        PageMove {
            id: id.into(),
            parent_page_id: parent.map(String::from),
            before_page_id: before.map(String::from),
        },
    )
}

#[test]
fn child_count_tracks_live_children() {
    let (mut conn, ws) = setup();
    let a = new_page(&mut conn, &ws, None, "A");
    let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
    new_page(&mut conn, &ws, Some(&a.id), "A2");
    assert_eq!(
        repo::page::get(&conn, &a.id).unwrap().unwrap().child_count,
        2
    );
    page::delete(&mut conn, &a1.id).unwrap();
    assert_eq!(
        repo::page::get(&conn, &a.id).unwrap().unwrap().child_count,
        1
    );
}

#[test]
fn move_reorders_among_siblings() {
    let (mut conn, ws) = setup();
    let a = new_page(&mut conn, &ws, None, "A");
    let b = new_page(&mut conn, &ws, None, "B");
    let c = new_page(&mut conn, &ws, None, "C");
    mv(&mut conn, &c.id, None, Some(&a.id)).unwrap(); // C first
    assert_eq!(
        titles(&repo::page::list_children(&conn, &ws.id, None).unwrap()),
        ["C", "A", "B"]
    );
    mv(&mut conn, &c.id, None, Some(&b.id)).unwrap(); // C between A and B
    assert_eq!(
        titles(&repo::page::list_children(&conn, &ws.id, None).unwrap()),
        ["A", "C", "B"]
    );
    mv(&mut conn, &a.id, None, None).unwrap(); // A last
    assert_eq!(
        titles(&repo::page::list_children(&conn, &ws.id, None).unwrap()),
        ["C", "B", "A"]
    );
}

#[test]
fn move_reparents_and_blocks_cycles() {
    let (mut conn, ws) = setup();
    let a = new_page(&mut conn, &ws, None, "A");
    let b = new_page(&mut conn, &ws, Some(&a.id), "B");
    let c = new_page(&mut conn, &ws, Some(&b.id), "C");
    let x = new_page(&mut conn, &ws, None, "X");
    let moved = mv(&mut conn, &x.id, Some(&c.id), None).unwrap();
    assert_eq!(moved.parent_page_id.as_deref(), Some(c.id.as_str()));
    // A cannot move under its own descendant, or under itself.
    assert!(matches!(
        mv(&mut conn, &a.id, Some(&c.id), None),
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        mv(&mut conn, &a.id, Some(&a.id), None),
        Err(AppError::Validation(_))
    ));
    // Back to the top level.
    let top = mv(&mut conn, &x.id, None, None).unwrap();
    assert!(top.parent_page_id.is_none());
}

#[test]
fn move_rejects_foreign_or_trashed_targets() {
    let (mut conn, ws) = setup();
    let a = new_page(&mut conn, &ws, None, "A");
    let b = new_page(&mut conn, &ws, None, "B");
    let trashed = new_page(&mut conn, &ws, None, "T");
    page::delete(&mut conn, &trashed.id).unwrap();
    assert!(matches!(
        mv(&mut conn, &a.id, Some(&trashed.id), None),
        Err(AppError::NotFound(_))
    ));
    // `before` must be a sibling under the target parent.
    let child = new_page(&mut conn, &ws, Some(&b.id), "child");
    assert!(matches!(
        mv(&mut conn, &a.id, None, Some(&child.id)),
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        mv(&mut conn, &trashed.id, None, None),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn repeated_inserts_at_front_keep_order() {
    let (mut conn, ws) = setup();
    let anchor = new_page(&mut conn, &ws, None, "anchor");
    let first = new_page(&mut conn, &ws, None, "first");
    mv(&mut conn, &first.id, None, Some(&anchor.id)).unwrap();
    // Repeatedly squeeze pages between `first` and `anchor` to force midpoint renumbering.
    for i in 0..60 {
        let p = new_page(&mut conn, &ws, None, &format!("p{i}"));
        mv(&mut conn, &p.id, None, Some(&anchor.id)).unwrap();
    }
    let list = repo::page::list_children(&conn, &ws.id, None).unwrap();
    assert_eq!(list.len(), 62);
    assert_eq!(list.first().unwrap().title, "first");
    assert_eq!(list.last().unwrap().title, "anchor");
    assert_eq!(list[list.len() - 2].title, "p59");
}

#[test]
fn trash_lists_batch_roots_and_restores_tree() {
    let (mut conn, ws) = setup();
    let a = new_page(&mut conn, &ws, None, "A");
    let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
    let a2 = new_page(&mut conn, &ws, Some(&a1.id), "A2");
    page::delete(&mut conn, &a.id).unwrap();
    let trash = repo::page::list_trash(&conn, &ws.id).unwrap();
    assert_eq!(titles(&trash), ["A"]);
    let restored = page::restore(&mut conn, &a.id).unwrap();
    assert!(restored.deleted_at.is_none());
    assert!(repo::page::get(&conn, &a2.id)
        .unwrap()
        .unwrap()
        .deleted_at
        .is_none());
    assert!(repo::page::list_trash(&conn, &ws.id).unwrap().is_empty());
    assert!(matches!(
        page::restore(&mut conn, &a.id),
        Err(AppError::Validation(_))
    ));
}

#[test]
fn restore_keeps_independently_trashed_descendants_in_trash() {
    let (mut conn, ws) = setup();
    let a = new_page(&mut conn, &ws, None, "A");
    let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
    page::delete(&mut conn, &a1.id).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    page::delete(&mut conn, &a.id).unwrap();
    // A1 was trashed first, so it is its own trash root.
    assert_eq!(repo::page::list_trash(&conn, &ws.id).unwrap().len(), 2);
    page::restore(&mut conn, &a.id).unwrap();
    assert!(repo::page::get(&conn, &a1.id)
        .unwrap()
        .unwrap()
        .deleted_at
        .is_some());
    // Restoring A1 while its parent is live puts it back under A.
    let r = page::restore(&mut conn, &a1.id).unwrap();
    assert_eq!(r.parent_page_id.as_deref(), Some(a.id.as_str()));
}

#[test]
fn restore_child_of_trashed_parent_goes_to_top_level() {
    let (mut conn, ws) = setup();
    let a = new_page(&mut conn, &ws, None, "A");
    let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
    page::delete(&mut conn, &a1.id).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    page::delete(&mut conn, &a.id).unwrap();
    let r = page::restore(&mut conn, &a1.id).unwrap();
    assert!(r.parent_page_id.is_none());
    assert!(r.deleted_at.is_none());
    assert_eq!(
        titles(&repo::page::list_children(&conn, &ws.id, None).unwrap()),
        ["A1"]
    );
}

#[test]
fn permanent_delete_requires_trash_and_removes_everything() {
    let (mut conn, ws) = setup();
    let a = new_page(&mut conn, &ws, None, "A");
    let a1 = new_page(&mut conn, &ws, Some(&a.id), "A1");
    let b = new_block(&mut conn, &a1.id, None, "x");
    assert!(matches!(
        page::delete_permanent(&mut conn, &a.id),
        Err(AppError::Validation(_))
    ));
    page::delete(&mut conn, &a.id).unwrap();
    page::delete_permanent(&mut conn, &a.id).unwrap();
    assert!(repo::page::get(&conn, &a.id).unwrap().is_none());
    assert!(repo::page::get(&conn, &a1.id).unwrap().is_none());
    assert!(repo::block::get(&conn, &b.id).unwrap().is_none());
}

#[test]
fn empty_trash_only_removes_trashed_pages() {
    let (mut conn, ws) = setup();
    let keep = new_page(&mut conn, &ws, None, "keep");
    let gone = new_page(&mut conn, &ws, None, "gone");
    page::delete(&mut conn, &gone.id).unwrap();
    page::empty_trash(&mut conn, &ws.id).unwrap();
    assert!(repo::page::get(&conn, &gone.id).unwrap().is_none());
    assert!(repo::page::get(&conn, &keep.id).unwrap().is_some());
}

#[test]
fn favorites_exclude_trashed_pages() {
    let (mut conn, ws) = setup();
    let a = new_page(&mut conn, &ws, None, "Alpha");
    let b = new_page(&mut conn, &ws, None, "beta");
    for id in [&a.id, &b.id] {
        page::update(
            &mut conn,
            PageUpdate {
                id: id.clone(),
                title: None,
                icon: None,
                cover: None,
                position: None,
                favorite: Some(true),
                archived: None,
            },
        )
        .unwrap();
    }
    assert_eq!(
        titles(&repo::page::list_favorites(&conn, &ws.id).unwrap()),
        ["Alpha", "beta"]
    );
    page::delete(&mut conn, &a.id).unwrap();
    assert_eq!(
        titles(&repo::page::list_favorites(&conn, &ws.id).unwrap()),
        ["beta"]
    );
}

#[test]
fn workspace_update_and_delete_rules() {
    let (mut conn, ws) = setup();
    let u = workspace::update(
        &mut conn,
        WorkspaceUpdate {
            id: ws.id.clone(),
            name: Some("  Renamed ".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(u.name, "Renamed");
    assert!(matches!(
        workspace::update(
            &mut conn,
            WorkspaceUpdate {
                id: ws.id.clone(),
                name: Some(" ".into()),
                ..Default::default()
            }
        ),
        Err(AppError::Validation(_))
    ));
    // The last workspace is protected.
    assert!(matches!(
        workspace::delete(&mut conn, &ws.id),
        Err(AppError::Validation(_))
    ));
    let other = workspace::create(
        &mut conn,
        WorkspaceCreate {
            name: "Other".into(),
            icon: None,
            ..Default::default()
        },
    )
    .unwrap();
    let p = new_page(&mut conn, &other, None, "inside");
    workspace::delete(&mut conn, &other.id).unwrap();
    assert!(repo::page::get(&conn, &p.id).unwrap().is_none());
    assert!(repo::workspace::get(&conn, &ws.id).unwrap().is_some());
}

#[test]
fn workspace_profiles_are_atomic_validated_and_resettable() {
    let (mut conn, ws) = setup();
    let updated = workspace::update(&mut conn, WorkspaceUpdate { id: ws.id.clone(), name: Some("Studio".into()), icon: Some("symbol:code".into()), settings_json: Some(r#"{"theme":"dark","description":"Research","accent":"blue","sidebarDensity":"compact","future":42}"#.into()), ..Default::default() }).unwrap();
    assert_eq!(updated.revision, ws.revision + 1);
    assert_eq!(updated.icon.as_deref(), Some("symbol:code"));
    let cleared = workspace::update(
        &mut conn,
        WorkspaceUpdate {
            id: ws.id.clone(),
            clear_icon: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(cleared.icon.is_none());
    assert!(cleared.settings_json.contains("future"));
    for json in [
        r#"{"accent":"unknown"}"#,
        r##"{"accent":"#12345678"}"##,
        r##"{"accent":"#ggg"}"##,
        r#"{"accent":"url(x)"}"#,
        r#"{"theme":42}"#,
        r#"{"sidebarDensity":"tiny"}"#,
        r#"{"autoBackup":"false"}"#,
    ] {
        assert!(workspace::update(
            &mut conn,
            WorkspaceUpdate {
                id: ws.id.clone(),
                name: Some("Should not stick".into()),
                settings_json: Some(json.into()),
                ..Default::default()
            }
        )
        .is_err());
        assert_eq!(
            repo::workspace::get(&conn, &ws.id).unwrap().unwrap().name,
            "Studio"
        );
    }
    let before = repo::workspace::count(&conn).unwrap();
    assert!(workspace::create(
        &mut conn,
        WorkspaceCreate {
            name: "Bad".into(),
            settings_json: Some(r#"{"accent":"invalid"}"#.into()),
            ..Default::default()
        }
    )
    .is_err());
    assert_eq!(repo::workspace::count(&conn).unwrap(), before);
    assert!(workspace::create(
        &mut conn,
        WorkspaceCreate {
            name: "Bad icon".into(),
            icon: Some("x".repeat(65)),
            ..Default::default()
        }
    )
    .is_err());
}

#[test]
fn workspace_listing_stats_and_backup_policy_are_scoped() {
    let (mut conn, ws) = setup();
    let other = workspace::create(
        &mut conn,
        WorkspaceCreate {
            name: "Other".into(),
            ..Default::default()
        },
    )
    .unwrap();
    new_page(&mut conn, &ws, None, "A");
    new_page(&mut conn, &other, None, "B");
    let p = new_page(&mut conn, &other, None, "C");
    page::delete(&mut conn, &p.id).unwrap();
    assert_eq!(repo::workspace::list(&conn).unwrap().len(), 2);
    assert_eq!(repo::workspace::stats(&conn, &ws.id).unwrap().pages, 1);
    let stats = repo::workspace::stats(&conn, &other.id).unwrap();
    assert_eq!((stats.pages, stats.trashed), (2, 1));
    let all = workspace::set_auto_backup(&mut conn, false).unwrap();
    assert!(all.iter().all(
        |w| serde_json::from_str::<serde_json::Value>(&w.settings_json).unwrap()["autoBackup"]
            == false
    ));
    for invalid in [0, 1001] {
        assert!(workspace::set_backup_policy(&mut conn, None, Some(invalid)).is_err());
    }
    let all = workspace::set_backup_policy(&mut conn, None, Some(7)).unwrap();
    assert!(all.iter().all(|w| {
        let settings: serde_json::Value = serde_json::from_str(&w.settings_json).unwrap();
        settings["backupKeep"] == 7 && settings["autoBackup"] == false
    }));
    let created = workspace::create(
        &mut conn,
        WorkspaceCreate {
            name: "New".into(),
            settings_json: Some(r#"{"accent":"green","autoBackup":true}"#.into()),
            ..Default::default()
        },
    )
    .unwrap();
    let settings: serde_json::Value = serde_json::from_str(&created.settings_json).unwrap();
    assert_eq!(settings["autoBackup"], false);
    assert_eq!(settings["backupKeep"], 7);
    assert_eq!(settings["accent"], "green");
    assert!(workspace::validate_deletion(&conn, &other.id, "Wrong").is_err());
    workspace::validate_deletion(&conn, &other.id, "Other").unwrap();
}

fn upsert(id: &str, parent: Option<&str>, position: f64, text: &str) -> BlockUpsert {
    BlockUpsert {
        id: id.into(),
        parent_block_id: parent.map(String::from),
        block_type: "paragraph".into(),
        position,
        data_json: format!("{{\"content\":[{{\"type\":\"text\",\"text\":\"{text}\"}}]}}"),
        schema_version: 2,
    }
}

fn batch(page: &Page, upserts: Vec<BlockUpsert>, deletes: &[&str]) -> BlockBatch {
    BlockBatch {
        page_id: page.id.clone(),
        upserts,
        delete_ids: deletes.iter().map(|s| s.to_string()).collect(),
    }
}

#[test]
fn batch_inserts_updates_and_deletes_atomically() {
    let (mut conn, ws) = setup();
    let p = new_page(&mut conn, &ws, None, "P");
    let (a, b, c) = (new_id(), new_id(), new_id());
    block::apply_batch(
        &mut conn,
        batch(
            &p,
            vec![upsert(&a, None, 0.0, "a"), upsert(&b, None, 1.0, "b")],
            &[],
        ),
    )
    .unwrap();
    assert_eq!(repo::block::list(&conn, &p.id).unwrap().len(), 2);
    // Update a, add c between, delete b.
    block::apply_batch(
        &mut conn,
        batch(
            &p,
            vec![upsert(&a, None, 0.0, "a2"), upsert(&c, None, 0.5, "c")],
            &[&b],
        ),
    )
    .unwrap();
    let list = repo::block::list(&conn, &p.id).unwrap();
    assert_eq!(
        list.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
        [a.as_str(), c.as_str()]
    );
    let a_row = repo::block::get(&conn, &a).unwrap().unwrap();
    assert_eq!(a_row.revision, 2);
    assert!(a_row.data_json.contains("a2"));
    assert_eq!(a_row.schema_version, 2);
}

#[test]
fn batch_orders_children_after_parents_and_cascades_deletes() {
    let (mut conn, ws) = setup();
    let p = new_page(&mut conn, &ws, None, "P");
    let (parent, child) = (new_id(), new_id());
    // Child listed first on purpose.
    block::apply_batch(
        &mut conn,
        batch(
            &p,
            vec![
                upsert(&child, Some(&parent), 0.0, "kid"),
                upsert(&parent, None, 0.0, "top"),
            ],
            &[],
        ),
    )
    .unwrap();
    assert_eq!(
        repo::block::get(&conn, &child)
            .unwrap()
            .unwrap()
            .parent_block_id
            .as_deref(),
        Some(parent.as_str())
    );
    block::apply_batch(&mut conn, batch(&p, vec![], &[&parent])).unwrap();
    assert!(repo::block::list(&conn, &p.id).unwrap().is_empty());
}

#[test]
fn batch_can_reparent_without_losing_the_child() {
    let (mut conn, ws) = setup();
    let p = new_page(&mut conn, &ws, None, "P");
    let (a, b, kid) = (new_id(), new_id(), new_id());
    block::apply_batch(
        &mut conn,
        batch(
            &p,
            vec![
                upsert(&a, None, 0.0, "a"),
                upsert(&b, None, 1.0, "b"),
                upsert(&kid, Some(&a), 0.0, "k"),
            ],
            &[],
        ),
    )
    .unwrap();
    // Move the child to b and delete a in the same batch.
    block::apply_batch(
        &mut conn,
        batch(&p, vec![upsert(&kid, Some(&b), 0.0, "k")], &[&a]),
    )
    .unwrap();
    let k = repo::block::get(&conn, &kid).unwrap().unwrap();
    assert_eq!(k.parent_block_id.as_deref(), Some(b.as_str()));
}

#[test]
fn batch_rejects_cycles_foreign_blocks_and_bad_input() {
    let (mut conn, ws) = setup();
    let p = new_page(&mut conn, &ws, None, "P");
    let other = new_page(&mut conn, &ws, None, "Other");
    let (a, b) = (new_id(), new_id());
    block::apply_batch(
        &mut conn,
        batch(
            &p,
            vec![upsert(&a, None, 0.0, "a"), upsert(&b, Some(&a), 0.0, "b")],
            &[],
        ),
    )
    .unwrap();
    // a under its own child b.
    assert!(matches!(
        block::apply_batch(
            &mut conn,
            batch(&p, vec![upsert(&a, Some(&b), 0.0, "a")], &[])
        ),
        Err(AppError::Validation(_))
    ));
    // Self parent.
    assert!(matches!(
        block::apply_batch(
            &mut conn,
            batch(&p, vec![upsert(&a, Some(&a), 0.0, "a")], &[])
        ),
        Err(AppError::Validation(_))
    ));
    // Block id owned by another page.
    assert!(matches!(
        block::apply_batch(
            &mut conn,
            batch(&other, vec![upsert(&a, None, 0.0, "x")], &[])
        ),
        Err(AppError::Validation(_))
    ));
    // Missing parent never resolves.
    assert!(matches!(
        block::apply_batch(
            &mut conn,
            batch(&p, vec![upsert(&new_id(), Some(&new_id()), 0.0, "x")], &[])
        ),
        Err(AppError::Validation(_))
    ));
    let mut bad = upsert(&new_id(), None, 0.0, "x");
    bad.block_type = "not_a_block".into();
    assert!(matches!(
        block::apply_batch(&mut conn, batch(&p, vec![bad], &[])),
        Err(AppError::Validation(_))
    ));
    let mut bad = upsert(&new_id(), None, f64::NAN, "x");
    bad.schema_version = 2;
    assert!(matches!(
        block::apply_batch(&mut conn, batch(&p, vec![bad], &[])),
        Err(AppError::Validation(_))
    ));
    let mut bad = upsert(&new_id(), None, 0.0, "x");
    bad.schema_version = 3;
    assert!(matches!(
        block::apply_batch(&mut conn, batch(&p, vec![bad], &[])),
        Err(AppError::Validation(_))
    ));
    // Nothing from the failed batches leaked in.
    assert_eq!(repo::block::list(&conn, &p.id).unwrap().len(), 2);
}

#[test]
fn failed_batch_rolls_back_earlier_operations() {
    let (mut conn, ws) = setup();
    let p = new_page(&mut conn, &ws, None, "P");
    let good = new_id();
    let mut bad = upsert(&new_id(), None, 1.0, "x");
    bad.block_type = "not_a_block".into();
    assert!(block::apply_batch(
        &mut conn,
        batch(&p, vec![upsert(&good, None, 0.0, "g"), bad], &[])
    )
    .is_err());
    assert!(repo::block::get(&conn, &good).unwrap().is_none());
    // A trashed page cannot be edited.
    page::delete(&mut conn, &p.id).unwrap();
    assert!(matches!(
        block::apply_batch(
            &mut conn,
            batch(&p, vec![upsert(&new_id(), None, 0.0, "x")], &[])
        ),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn error_serializes_as_typed_object() {
    let v = serde_json::to_value(AppError::Validation("bad".into())).unwrap();
    assert_eq!(v["code"], "validation");
    assert_eq!(v["message"], "bad");
}

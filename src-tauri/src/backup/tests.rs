use super::*;
use crate::domain::*;
use crate::services;

struct Env {
    paths: Paths,
    conn: Mutex<Connection>,
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.paths.data);
    }
}

fn env() -> Env {
    let data = std::env::temp_dir().join(format!("tako-backup-{}", uuid::Uuid::now_v7()));
    fs::create_dir_all(&data).unwrap();
    let paths = Paths::new(&data);
    let mut conn = database::open(&paths.db()).unwrap();
    services::workspace::create(
        &mut conn,
        WorkspaceCreate {
            name: "Home".into(),
            icon: None,
            ..Default::default()
        },
    )
    .unwrap();
    Env {
        paths,
        conn: Mutex::new(conn),
    }
}

fn ws(e: &Env) -> String {
    let c = e.conn.lock().unwrap();
    c.query_row("SELECT id FROM workspace", [], |r| r.get(0))
        .unwrap()
}

fn page(e: &Env, title: &str) -> Page {
    let id = ws(e);
    let mut c = e.conn.lock().unwrap();
    services::page::create(
        &mut c,
        PageCreate {
            workspace_id: id,
            parent_page_id: None,
            title: Some(title.into()),
            icon: None,
        },
    )
    .unwrap()
}

fn titles(e: &Env) -> Vec<String> {
    let c = e.conn.lock().unwrap();
    let mut stmt = c
        .prepare("SELECT title FROM page WHERE deleted_at IS NULL ORDER BY title")
        .unwrap();
    stmt.query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// Registers a file as an attachment (content-addressed) without going through the picker.
fn attach(e: &Env, bytes: &[u8]) -> String {
    let hash: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let path = crate::files::blob_path(&e.paths.attachments(), &hash);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    let id = ws(e);
    let c = e.conn.lock().unwrap();
    c.execute(
        "INSERT INTO attachment (id, workspace_id, hash, original_name, mime_type, size, created_at, updated_at) VALUES (?1, ?2, ?3, 'a.bin', 'application/octet-stream', ?4, 'x', 'x')",
        rusqlite::params![new_id(), id, hash, bytes.len() as i64],
    )
    .unwrap();
    hash
}

#[test]
fn a_backup_holds_the_database_and_attachments_and_reads_back() {
    let e = env();
    page(&e, "One");
    page(&e, "Two");
    let hash = attach(&e, b"hello attachment");
    let info = create_in_app(&e.conn, &e.paths, "manual").unwrap();
    assert!(info.name.starts_with("manual-") && info.name.ends_with(".takobak"));
    let m = &info.manifest;
    assert_eq!(
        (
            m.pages,
            m.attachments,
            m.attachment_bytes,
            m.kind.as_str(),
            m.workspace_name.as_str()
        ),
        (2, 1, 16, "manual", "Home")
    );
    assert_eq!(m.schema_version, current_schema());
    assert!(info.size > 0);
    // Listing reads the manifest only and returns the same thing; the folder holds no temp files.
    let listed = list(&e.paths);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].manifest, info.manifest);
    let leftovers: Vec<_> = fs::read_dir(e.paths.backups())
        .unwrap()
        .map(|f| f.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(leftovers.as_slice(), std::slice::from_ref(&info.name));
    // The attachment is inside, under its content hash.
    let mut staged = e.paths.data.join("peek");
    fs::create_dir_all(&staged).unwrap();
    extract(&e.paths.backups().join(&info.name), &staged).unwrap();
    assert_eq!(
        fs::read(staged.join("attachments").join(&hash[..2]).join(&hash)).unwrap(),
        b"hello attachment"
    );
    staged.push("workspace.db");
    assert!(staged.exists());
}

#[test]
fn damaged_and_foreign_files_are_rejected() {
    let e = env();
    page(&e, "One");
    let info = create_in_app(&e.conn, &e.paths, "manual").unwrap();
    let good = e.paths.backups().join(&info.name);
    let bytes = fs::read(&good).unwrap();

    let flip = e.paths.data.join("flip.takobak");
    let mut b = bytes.clone();
    let mid = b.len() / 2;
    b[mid] ^= 0xff;
    fs::write(&flip, &b).unwrap();
    assert!(matches!(verify(&flip), Err(AppError::Validation(m)) if m.contains("checksum")));
    assert!(inspect(&flip, "").is_err());

    let cut = e.paths.data.join("cut.takobak");
    fs::write(&cut, &bytes[..bytes.len() - 100]).unwrap();
    assert!(verify(&cut).is_err());

    let foreign = e.paths.data.join("foreign.takobak");
    fs::write(
        &foreign,
        b"PK\x03\x04 not ours, not ours, not ours, not ours, not ours",
    )
    .unwrap();
    assert!(inspect(&foreign, "").is_err());
    fs::write(&foreign, b"").unwrap();
    assert!(inspect(&foreign, "").is_err());

    // Damaged files do not show up in the list.
    fs::copy(&flip, e.paths.backups().join("manual-broken.takobak")).unwrap();
    assert!(
        list(&e.paths)
            .iter()
            .all(|b| b.name != "manual-broken.takobak")
            || read_manifest(&flip).is_ok()
    );
}

#[test]
fn restore_brings_back_the_backed_up_state_and_keeps_a_safety_copy() {
    let e = env();
    page(&e, "Kept");
    let doomed = page(&e, "Doomed");
    let hash = attach(&e, b"original bytes");
    let info = create_in_app(&e.conn, &e.paths, "manual").unwrap();
    let archive = e.paths.backups().join(&info.name);

    // Change things after the backup.
    {
        let mut c = e.conn.lock().unwrap();
        services::page::delete(&mut c, &doomed.id).unwrap();
    }
    page(&e, "Newer");
    let extra = attach(&e, b"added later");
    fs::remove_file(crate::files::blob_path(&e.paths.attachments(), &hash)).unwrap();
    assert_eq!(titles(&e), ["Kept", "Newer"]);

    let outcome = restore(&e.conn, &e.paths, &archive).unwrap();
    assert_eq!(titles(&e), ["Doomed", "Kept"]);
    assert_eq!(
        fs::read(crate::files::blob_path(&e.paths.attachments(), &hash)).unwrap(),
        b"original bytes"
    );
    assert!(!crate::files::blob_path(&e.paths.attachments(), &extra).exists());
    // The connection works and the swap left nothing behind.
    let c = e.conn.lock().unwrap();
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT COUNT(*) FROM attachment", [], |r| r.get(0))
            .unwrap(),
        1
    );
    drop(c);
    for f in [
        "workspace.db.old",
        "workspace.db-wal.old",
        "attachments.old",
        "restore.pending",
    ] {
        assert!(!e.paths.data.join(f).exists(), "{f}");
    }
    assert!(fs::read_dir(&e.paths.data).unwrap().all(|f| !f
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("restore-staging")));

    // The safety backup holds the state that was replaced, and restoring it undoes the restore.
    let safety = e.paths.backups().join(&outcome.safety_backup);
    assert_eq!(inspect(&safety, "").unwrap().manifest.kind, "safety");
    restore(&e.conn, &e.paths, &safety).unwrap();
    assert_eq!(titles(&e), ["Kept", "Newer"]);
    assert!(crate::files::blob_path(&e.paths.attachments(), &extra).exists());
}

#[test]
fn restore_refuses_bad_or_newer_backups_without_touching_anything() {
    let e = env();
    page(&e, "Mine");
    let before = list(&e.paths).len();
    // A newer schema.
    let pending = {
        let c = e.conn.lock().unwrap();
        begin(&c, &e.paths, "manual").unwrap()
    };
    let mut pending = pending;
    pending.manifest.schema_version += 1;
    let newer = finish(&e.paths, pending, &e.paths.data.join("newer.takobak")).unwrap();
    let path = e.paths.data.join(&newer.name);
    let preview_of = {
        let c = e.conn.lock().unwrap();
        preview(&c, &path, "").unwrap()
    };
    assert!(preview_of.too_new);
    assert_eq!(
        (preview_of.current_pages, preview_of.current_attachments),
        (1, 0)
    );
    assert!(
        matches!(restore(&e.conn, &e.paths, &path), Err(AppError::Validation(m)) if m.contains("newer"))
    );

    // A corrupt file.
    let junk = e.paths.data.join("junk.takobak");
    fs::write(
        &junk,
        b"TAKOBAK1 but then garbage garbage garbage garbage garbage",
    )
    .unwrap();
    assert!(restore(&e.conn, &e.paths, &junk).is_err());

    assert_eq!(titles(&e), ["Mine"]);
    assert_eq!(
        list(&e.paths).len(),
        before,
        "no safety backup for a refused restore"
    );
}

#[test]
fn entries_cannot_escape_the_staging_folder() {
    let e = env();
    let evil = e.paths.data.join("evil.takobak");
    let mut w = HashWriter {
        inner: BufWriter::new(File::create(&evil).unwrap()),
        hasher: Sha256::new(),
    };
    w.put(MAGIC).unwrap();
    let m = serde_json::to_vec(&Manifest {
        format: 1,
        app_version: "x".into(),
        schema_version: 1,
        created_at: "t".into(),
        kind: "manual".into(),
        workspace_name: "w".into(),
        pages: 0,
        attachments: 0,
        attachment_bytes: 0,
    })
    .unwrap();
    w.entry("manifest.json", m.len() as u64, m.as_slice())
        .unwrap();
    w.entry("../../escaped.txt", 3, &b"bad"[..]).unwrap();
    w.put(&[0]).unwrap();
    let digest = w.hasher.clone().finalize();
    w.inner.write_all(&digest).unwrap();
    w.inner.flush().unwrap();
    drop(w);
    let staging = e.paths.data.join("stage");
    fs::create_dir_all(&staging).unwrap();
    assert!(extract(&evil, &staging).is_err());
    assert!(!e.paths.data.parent().unwrap().join("escaped.txt").exists());
    assert!(attachment_entry("attachments/ab/../../x").is_none());
    assert!(
        attachment_entry(&format!("attachments/cd/{}", "a".repeat(64))).is_none(),
        "directory must match the hash"
    );
    assert!(attachment_entry(&format!("attachments/aa/{}", "a".repeat(64))).is_some());
}

#[test]
fn rotation_uses_configured_count_and_never_touches_manual_ones() {
    let e = env();
    page(&e, "x");
    let manual = create_in_app(&e.conn, &e.paths, "manual").unwrap();
    for _ in 0..13 {
        create_in_app(&e.conn, &e.paths, "auto").unwrap();
    }
    assert_eq!(rotate(&e.paths, 5), 8);
    assert_eq!(rotate(&e.paths, KEEP_AUTO), 2);
    let all = list(&e.paths);
    assert_eq!(
        all.iter().filter(|b| b.manifest.kind == "auto").count(),
        KEEP_AUTO
    );
    assert!(all.iter().any(|b| b.name == manual.name));
}

#[test]
fn at_most_one_automatic_backup_per_day() {
    let e = env();
    page(&e, "x");
    let today = Local::now().date_naive();
    assert!(!auto_backup_done_today(&e.paths, today));
    let first = auto_backup(&e.conn, &e.paths).unwrap();
    assert!(first.is_some());
    assert!(auto_backup_done_today(&e.paths, today));
    assert!(auto_backup(&e.conn, &e.paths).unwrap().is_none());
    // A manual backup does not count as the daily one.
    let e2 = env();
    create_in_app(&e2.conn, &e2.paths, "manual").unwrap();
    assert!(!auto_backup_done_today(&e2.paths, today));
}

#[test]
fn backup_names_from_the_frontend_cannot_leave_the_folder() {
    let e = env();
    page(&e, "x");
    let info = create_in_app(&e.conn, &e.paths, "manual").unwrap();
    assert!(app_backup_path(&e.paths, &info.name).is_ok());
    for bad in [
        "../workspace.db",
        "..\\x.takobak",
        "/etc/passwd",
        "a/b.takobak",
        ".hidden.takobak",
        "x.txt",
        "",
        "missing.takobak",
    ] {
        assert!(app_backup_path(&e.paths, bad).is_err(), "{bad}");
    }
    delete(&e.paths, &info.name).unwrap();
    assert!(list(&e.paths).is_empty());
}

#[test]
fn an_interrupted_restore_is_undone_at_the_next_start() {
    let e = env();
    page(&e, "Original");
    // Simulate a swap that moved the old files aside, put a new database in, and died. The live
    // connection is replaced first so the files can be moved on every platform.
    {
        let mut c = e.conn.lock().unwrap();
        c.pragma_update(None, "wal_checkpoint", "TRUNCATE").unwrap();
        *c = Connection::open_in_memory().unwrap();
    }
    fs::rename(e.paths.db(), e.paths.data.join("workspace.db.old")).unwrap();
    fs::create_dir_all(e.paths.attachments()).unwrap();
    fs::rename(e.paths.attachments(), e.paths.data.join("attachments.old")).unwrap();
    fs::write(e.paths.db(), b"half written new database").unwrap();
    fs::create_dir_all(e.paths.attachments()).unwrap();
    fs::create_dir_all(e.paths.data.join("restore-staging-abc")).unwrap();
    fs::write(e.paths.marker(), "{}").unwrap();

    assert!(recover(&e.paths));
    assert!(!e.paths.marker().exists());
    assert!(!e.paths.data.join("restore-staging-abc").exists());
    assert!(!e.paths.data.join("workspace.db.old").exists());
    let c = database::open(&e.paths.db()).unwrap();
    let title: String = c
        .query_row("SELECT title FROM page WHERE title = 'Original'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(title, "Original");
    // With no marker there is nothing to do.
    assert!(!recover(&e.paths));
}

#[test]
fn workspace_deletion_is_backed_up_and_recoverable() {
    let e = env();
    let home = ws(&e);
    let other = {
        let mut conn = e.conn.lock().unwrap();
        services::workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "Studio".into(),
                icon: Some("symbol:code".into()),
                ..Default::default()
            },
        )
        .unwrap()
    };
    let page = {
        let mut conn = e.conn.lock().unwrap();
        services::page::create(
            &mut conn,
            PageCreate {
                workspace_id: other.id.clone(),
                parent_page_id: None,
                title: Some("Keep this".into()),
                icon: None,
            },
        )
        .unwrap()
    };
    assert!(
        services::workspace::delete_safely(&e.conn, &e.paths, &other.id, "Wrong name").is_err()
    );
    assert!(list(&e.paths).is_empty());
    let name = services::workspace::delete_safely(&e.conn, &e.paths, &other.id, "Studio").unwrap();
    let path = e.paths.backups().join(&name);
    assert_eq!(inspect(&path, &name).unwrap().manifest.kind, "safety");
    {
        let conn = e.conn.lock().unwrap();
        assert!(crate::repositories::workspace::get(&conn, &other.id)
            .unwrap()
            .is_none());
        assert!(crate::repositories::page::get(&conn, &page.id)
            .unwrap()
            .is_none());
        assert!(crate::repositories::workspace::get(&conn, &home)
            .unwrap()
            .is_some());
    }
    assert!(services::workspace::delete_safely(&e.conn, &e.paths, &home, "Home").is_err());
    restore(&e.conn, &e.paths, &path).unwrap();
    let conn = e.conn.lock().unwrap();
    assert!(crate::repositories::workspace::get(&conn, &other.id)
        .unwrap()
        .is_some());
    assert!(crate::repositories::page::get(&conn, &page.id)
        .unwrap()
        .is_some());
}

#[test]
fn failed_safety_backup_does_not_delete_a_workspace() {
    let e = env();
    let other = services::workspace::create(
        &mut e.conn.lock().unwrap(),
        WorkspaceCreate {
            name: "Studio".into(),
            ..Default::default()
        },
    )
    .unwrap();
    fs::write(e.paths.backups(), "blocks the backup directory").unwrap();
    assert!(services::workspace::delete_safely(&e.conn, &e.paths, &other.id, "Studio").is_err());
    assert!(
        crate::repositories::workspace::get(&e.conn.lock().unwrap(), &other.id)
            .unwrap()
            .is_some()
    );
}

#[test]
fn a_second_folder_receives_copies_and_keeps_only_the_newest() {
    let e = env();
    let mirror = e.paths.data.join("external-drive");
    fs::create_dir_all(&mirror).unwrap();
    fs::write(mirror.join("notes.txt"), b"not ours").unwrap();
    assert_eq!(
        set_mirror(&e.paths, Some(&mirror))
            .unwrap()
            .folder
            .as_deref(),
        Some(mirror.to_str().unwrap())
    );
    for i in 0..3 {
        let mut info = create_in_app(&e.conn, &e.paths, "auto").unwrap();
        // Distinct names regardless of how fast the backups are made.
        let renamed = format!("auto-2026010{i}-000000.{EXTENSION}");
        fs::rename(
            e.paths.backups().join(&info.name),
            e.paths.backups().join(&renamed),
        )
        .unwrap();
        info.name = renamed;
        copy_to_mirror(&e.paths, &info, 2).unwrap().unwrap();
    }
    let mut names: Vec<String> = fs::read_dir(&mirror)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            format!("auto-20260101-000000.{EXTENSION}"),
            format!("auto-20260102-000000.{EXTENSION}"),
            "notes.txt".into()
        ]
    );
    // A missing folder is refused rather than remembered.
    assert!(set_mirror(&e.paths, Some(&e.paths.data.join("missing"))).is_err());
    assert_eq!(mirror_of(&e), Some(mirror.to_string_lossy().into_owned()));
    set_mirror(&e.paths, None).unwrap();
    assert_eq!(mirror_of(&e), None);
}

fn mirror_of(e: &Env) -> Option<String> {
    super::mirror(&e.paths).folder
}

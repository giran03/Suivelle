//! Files that arrive by paste or drop, and the attachment manager: where each stored file is used,
//! and removing the ones nothing uses. Blobs are content-addressed, so a file is only removed from
//! disk when no attachment record in any workspace still points at its hash.

use super::{
    attachment_row, blob_path, insert_attachment_in, mime_for, store_reader, COLS,
    MAX_ATTACHMENT_BYTES,
};
use crate::domain::{validate_id, Attachment};
use crate::errors::{AppError, AppResult};
use flate2::read::DeflateDecoder;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

/// Pasted and dropped files travel through memory, so they are capped well below the 1 GiB the
/// file picker allows.
pub const MAX_PASTED_BYTES: usize = 256 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;

/// A file name that is safe to show and to save under: no folders, no control characters.
pub fn clean_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let kept: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .collect();
    let name: String = kept.trim().trim_matches('.').chars().take(200).collect();
    if name.is_empty() {
        "pasted-file".into()
    } else {
        name
    }
}

/// Stores bytes that arrived by paste or drop. Identical content in a workspace is stored once.
pub fn import_bytes(
    conn: &mut Connection,
    root: &Path,
    workspace_id: &str,
    raw_name: &str,
    bytes: &[u8],
) -> AppResult<Attachment> {
    validate_id(workspace_id, "workspace")?;
    if bytes.is_empty() {
        return Err(AppError::Validation("the file is empty".into()));
    }
    if bytes.len() > MAX_PASTED_BYTES {
        return Err(AppError::Validation(
            "files over 256 MB cannot be pasted or dropped; use an Add file block instead".into(),
        ));
    }
    let tx = conn.transaction()?;
    let att = import_bytes_in(&tx, root, workspace_id, raw_name, bytes)?;
    tx.commit()?;
    Ok(att)
}

/// Stores `bytes` and records them for `workspace_id` inside the caller's transaction, so the
/// attachment can be created together with whatever uses it.
pub fn import_bytes_in(
    tx: &Connection,
    root: &Path,
    workspace_id: &str,
    raw_name: &str,
    bytes: &[u8],
) -> AppResult<Attachment> {
    let name = clean_name(raw_name);
    let mime = mime_for(&name);
    let (hash, size) = store_reader(root, &mut &bytes[..], MAX_ATTACHMENT_BYTES)?;
    insert_attachment_in(tx, workspace_id, &hash, &name, mime, size)
}

/// Whether `bytes` really are an image of a kind the app displays, whatever the file is called.
pub fn looks_like_image(bytes: &[u8]) -> bool {
    if image::guess_format(bytes).is_ok() || bytes.get(4..12) == Some(b"ftypavif") {
        return true;
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]);
    let head = head.trim_start_matches(|c: char| c.is_whitespace() || c as u32 == 0xFEFF);
    head.starts_with('<') && head.contains("<svg")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUse {
    pub page_id: String,
    pub title: String,
    pub trashed: bool,
    /// Used as the page's cover rather than inside its content.
    pub cover: bool,
    /// Used as the page's custom icon.
    pub icon: bool,
    /// This use refers to the workspace itself, not a page.
    pub workspace: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub id: String,
    pub hash: String,
    pub original_name: String,
    pub mime_type: String,
    pub size: i64,
    pub created_at: String,
    /// Pages whose content, cover or icon show this file. Trashed pages count: they can be restored.
    pub uses: Vec<AttachmentUse>,
    /// Only meaningful when `uses` is empty: a saved version of some page still refers to it.
    pub in_history: bool,
}

fn inflate(blob: &[u8]) -> Option<String> {
    let mut out = Vec::new();
    DeflateDecoder::new(blob)
        .take(MAX_SNAPSHOT_BYTES)
        .read_to_end(&mut out)
        .ok()?;
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// Every stored file in a workspace with the pages that use it, newest first.
pub fn list_usage(conn: &Connection, workspace_id: &str) -> AppResult<Vec<AttachmentInfo>> {
    validate_id(workspace_id, "workspace")?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM attachment WHERE workspace_id = ?1 ORDER BY created_at DESC, id"
    ))?;
    let atts: Vec<Attachment> = stmt
        .query_map([workspace_id], attachment_row)?
        .collect::<Result<_, _>>()?;

    let mut by_id: HashMap<String, Vec<AttachmentUse>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT b.page_id, p.title, p.deleted_at IS NOT NULL, b.data_json
         FROM block b JOIN page p ON p.id = b.page_id
         WHERE p.workspace_id = ?1 AND b.type IN ('image', 'audio', 'video', 'file', 'pdf')",
    )?;
    let rows = stmt.query_map([workspace_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, bool>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (page_id, title, trashed, data) = row?;
        let Ok(v) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if let Some(id) = v.pointer("/attachment/id").and_then(Value::as_str) {
            let uses = by_id.entry(id.to_string()).or_default();
            if !uses.iter().any(|u| u.page_id == page_id && !u.cover) {
                uses.push(AttachmentUse {
                    page_id,
                    title,
                    trashed,
                    cover: false,
                    icon: false,
                    workspace: false,
                });
            }
        }
    }

    let mut by_hash: HashMap<String, Vec<AttachmentUse>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT id, title, cover, deleted_at IS NOT NULL, 0 FROM page
         WHERE workspace_id = ?1 AND cover LIKE 'image:%'
         UNION ALL SELECT id, title, icon, deleted_at IS NOT NULL, 1 FROM page
         WHERE workspace_id = ?1 AND icon LIKE 'image:%'",
    )?;
    let rows = stmt.query_map([workspace_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, bool>(3)?,
            r.get::<_, bool>(4)?,
        ))
    })?;
    for row in rows {
        let (page_id, title, image, trashed, icon) = row?;
        if let Some(hash) = image.strip_prefix("image:") {
            by_hash
                .entry(hash.to_string())
                .or_default()
                .push(AttachmentUse {
                    page_id,
                    title,
                    trashed,
                    cover: !icon,
                    icon,
                    workspace: false,
                });
        }
    }

    if let Some(w) = crate::repositories::workspace::get(conn, workspace_id)? {
        if let Some(hash) = w.icon.as_deref().and_then(|i| i.strip_prefix("image:")) {
            by_hash
                .entry(hash.to_string())
                .or_default()
                .push(AttachmentUse {
                    page_id: w.id,
                    title: w.name,
                    trashed: false,
                    cover: false,
                    icon: true,
                    workspace: true,
                });
        }
    }
    let mut out: Vec<AttachmentInfo> = atts
        .into_iter()
        .map(|a| {
            let mut uses = by_id.remove(&a.id).unwrap_or_default();
            uses.extend(
                by_hash
                    .get(&a.hash)
                    .into_iter()
                    .flatten()
                    .map(|u| AttachmentUse {
                        page_id: u.page_id.clone(),
                        title: u.title.clone(),
                        trashed: u.trashed,
                        cover: u.cover,
                        icon: u.icon,
                        workspace: u.workspace,
                    }),
            );
            AttachmentInfo {
                id: a.id,
                hash: a.hash,
                original_name: a.original_name,
                mime_type: a.mime_type,
                size: a.size,
                created_at: a.created_at,
                uses,
                in_history: false,
            }
        })
        .collect();

    // Saved versions are compressed, so only look inside them for files that are otherwise unused.
    if out.iter().any(|a| a.uses.is_empty()) {
        let mut stmt = conn.prepare(
            "SELECT r.snapshot FROM page_revision r JOIN page p ON p.id = r.page_id WHERE p.workspace_id = ?1",
        )?;
        let blobs = stmt.query_map([workspace_id], |r| r.get::<_, Vec<u8>>(0))?;
        for blob in blobs {
            let Some(text) = inflate(&blob?) else {
                continue;
            };
            for a in out
                .iter_mut()
                .filter(|a| a.uses.is_empty() && !a.in_history)
            {
                if text.contains(&a.id) || text.contains(&a.hash) {
                    a.in_history = true;
                }
            }
            if out.iter().all(|a| !a.uses.is_empty() || a.in_history) {
                break;
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    pub deleted: usize,
    pub skipped: usize,
    pub freed_bytes: u64,
}

fn remove_blob(root: &Path, hash: &str) {
    if !super::is_hash(hash) {
        return;
    }
    let _ = std::fs::remove_file(blob_path(root, hash));
    let thumbs = root.join("thumbnails").join(&hash[..2]);
    if let Ok(entries) = std::fs::read_dir(thumbs) {
        let prefix = format!("{hash}-");
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

/// Deletes the chosen files, but only those the server itself finds unused. Anything a page still
/// shows is skipped, and so is anything an old saved version needs unless `include_history`.
pub fn delete_unused(
    conn: &mut Connection,
    root: &Path,
    workspace_id: &str,
    ids: &[String],
    include_history: bool,
) -> AppResult<Deleted> {
    for id in ids {
        validate_id(id, "attachment")?;
    }
    let usage = list_usage(conn, workspace_id)?;
    let mut result = Deleted {
        deleted: 0,
        skipped: 0,
        freed_bytes: 0,
    };
    let mut hashes: Vec<(String, i64)> = Vec::new();
    let tx = conn.transaction()?;
    for id in ids {
        let Some(info) = usage.iter().find(|a| &a.id == id) else {
            result.skipped += 1;
            continue;
        };
        if !info.uses.is_empty() || (info.in_history && !include_history) {
            result.skipped += 1;
            continue;
        }
        tx.execute(
            "DELETE FROM attachment WHERE id = ?1 AND workspace_id = ?2",
            params![id, workspace_id],
        )?;
        hashes.push((info.hash.clone(), info.size));
        result.deleted += 1;
    }
    tx.commit()?;
    // Another workspace may hold the same content; the blob stays while any record points at it.
    for (hash, size) in hashes {
        let still_used: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM attachment WHERE hash = ?1)",
            [&hash],
            |r| r.get(0),
        )?;
        if !still_used {
            remove_blob(root, &hash);
            result.freed_bytes += size.max(0) as u64;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::open_in_memory;
    use crate::domain::{new_id, now, WorkspaceCreate};
    use crate::services;
    use std::path::PathBuf;

    fn setup() -> (Connection, String, PathBuf) {
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
        let dir = std::env::temp_dir().join(format!("tako-manage-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        (conn, ws.id, dir.join("attachments"))
    }

    fn page(
        conn: &Connection,
        ws: &str,
        title: &str,
        cover: Option<&str>,
        trashed: bool,
    ) -> String {
        let id = new_id();
        conn.execute(
            "INSERT INTO page (id, workspace_id, title, cover, deleted_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, ws, title, cover, trashed.then(now), now()],
        )
        .unwrap();
        id
    }

    fn media_block(conn: &Connection, page: &str, att: &Attachment) {
        conn.execute(
            "INSERT INTO block (id, page_id, type, data_json, schema_version, created_at, updated_at) VALUES (?1, ?2, 'image', ?3, 2, ?4, ?4)",
            params![new_id(), page, serde_json::json!({ "attachment": { "id": att.id, "hash": att.hash } }).to_string(), now()],
        )
        .unwrap();
    }

    #[test]
    fn names_are_made_safe() {
        assert_eq!(clean_name("..\\..\\evil/photo.png"), "photo.png");
        assert_eq!(clean_name("a<b>:c?.png"), "abc.png");
        assert_eq!(clean_name("   "), "pasted-file");
        assert_eq!(clean_name(""), "pasted-file");
        assert_eq!(clean_name(&"x".repeat(500)).chars().count(), 200);
    }

    #[test]
    fn pasted_bytes_are_stored_once() {
        let (mut conn, ws, root) = setup();
        let a = import_bytes(&mut conn, &root, &ws, "shot.png", b"\x89PNG bytes").unwrap();
        let b = import_bytes(&mut conn, &root, &ws, "other.png", b"\x89PNG bytes").unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.mime_type, "image/png");
        assert!(blob_path(&root, &a.hash).exists());
        assert!(import_bytes(&mut conn, &root, &ws, "x.png", b"").is_err());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn usage_counts_content_covers_and_trashed_pages() {
        let (mut conn, ws, root) = setup();
        let used = import_bytes(&mut conn, &root, &ws, "used.png", b"used one").unwrap();
        let cover = import_bytes(&mut conn, &root, &ws, "cover.png", b"cover one").unwrap();
        let trashed = import_bytes(&mut conn, &root, &ws, "trashed.png", b"trashed one").unwrap();
        let unused = import_bytes(&mut conn, &root, &ws, "unused.png", b"unused one").unwrap();
        let p1 = page(&conn, &ws, "In use", None, false);
        media_block(&conn, &p1, &used);
        page(
            &conn,
            &ws,
            "Has cover",
            Some(&format!("image:{}", cover.hash)),
            false,
        );
        let p3 = page(&conn, &ws, "In the bin", None, true);
        media_block(&conn, &p3, &trashed);

        let list = list_usage(&conn, &ws).unwrap();
        let find = |id: &str| list.iter().find(|a| a.id == id).unwrap();
        assert_eq!(find(&used.id).uses.len(), 1);
        assert_eq!(find(&used.id).uses[0].title, "In use");
        assert!(find(&cover.id).uses[0].cover);
        assert!(find(&trashed.id).uses[0].trashed);
        assert!(find(&unused.id).uses.is_empty());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn page_icon_images_are_kept_until_their_last_reference_is_removed() {
        let (mut conn, ws, root) = setup();
        let image = import_bytes(&mut conn, &root, &ws, "icon.png", b"page icon image").unwrap();
        let live = page(&conn, &ws, "Icon page", None, false);
        let trashed = page(&conn, &ws, "Trashed icon page", None, true);
        conn.execute(
            "UPDATE page SET icon = ?1 WHERE id IN (?2, ?3)",
            params![format!("image:{}", image.hash), live, trashed],
        )
        .unwrap();
        let usage = list_usage(&conn, &ws).unwrap();
        let uses = &usage.iter().find(|a| a.id == image.id).unwrap().uses;
        assert_eq!(uses.len(), 2);
        assert!(uses.iter().all(|u| u.icon && !u.cover));
        assert!(uses.iter().any(|u| u.trashed));
        assert_eq!(
            delete_unused(&mut conn, &root, &ws, std::slice::from_ref(&image.id), true)
                .unwrap()
                .skipped,
            1
        );
        assert!(blob_path(&root, &image.hash).exists());
        conn.execute(
            "UPDATE page SET icon = NULL WHERE id IN (?1, ?2)",
            params![live, trashed],
        )
        .unwrap();
        assert_eq!(
            delete_unused(
                &mut conn,
                &root,
                &ws,
                std::slice::from_ref(&image.id),
                false
            )
            .unwrap()
            .deleted,
            1
        );
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn workspace_icons_validate_ownership_and_survive_file_cleanup() {
        let (mut conn, ws, root) = setup();
        let other = services::workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "Other".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let image = import_bytes(
            &mut conn,
            &root,
            &other.id,
            "icon.gif",
            b"workspace icon image",
        )
        .unwrap();
        let update = || crate::domain::WorkspaceUpdate {
            id: ws.clone(),
            icon: Some(format!("image:{}", image.hash)),
            settings_json: Some(r##"{"accent":"#23ABEF"}"##.into()),
            ..Default::default()
        };
        assert!(services::workspace::update(&mut conn, update()).is_err());
        let mine =
            import_bytes(&mut conn, &root, &ws, "icon.gif", b"workspace icon image").unwrap();
        let saved = services::workspace::update(&mut conn, update()).unwrap();
        assert!(saved.settings_json.contains("#23ABEF"));
        let usage = list_usage(&conn, &ws).unwrap();
        assert!(usage[0].uses[0].workspace && usage[0].uses[0].icon);
        assert_eq!(
            delete_unused(&mut conn, &root, &ws, std::slice::from_ref(&mine.id), true)
                .unwrap()
                .skipped,
            1
        );
        services::workspace::update(
            &mut conn,
            crate::domain::WorkspaceUpdate {
                id: ws.clone(),
                clear_icon: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            delete_unused(&mut conn, &root, &ws, std::slice::from_ref(&mine.id), false)
                .unwrap()
                .deleted,
            1
        );
        assert!(
            blob_path(&root, &image.hash).exists(),
            "the other workspace still owns the original"
        );
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn only_unused_files_are_deleted_and_blobs_follow() {
        let (mut conn, ws, root) = setup();
        let used = import_bytes(&mut conn, &root, &ws, "used.png", b"used one").unwrap();
        let unused = import_bytes(&mut conn, &root, &ws, "unused.png", b"unused one").unwrap();
        let p = page(&conn, &ws, "P", None, false);
        media_block(&conn, &p, &used);

        let r = delete_unused(
            &mut conn,
            &root,
            &ws,
            &[used.id.clone(), unused.id.clone(), new_id()],
            false,
        )
        .unwrap();
        assert_eq!((r.deleted, r.skipped), (1, 2));
        assert_eq!(r.freed_bytes, unused.size as u64);
        assert!(
            blob_path(&root, &used.hash).exists(),
            "a used file is never removed"
        );
        assert!(!blob_path(&root, &unused.hash).exists());
        assert!(get_attachment(&conn, &unused.id).is_none());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn a_blob_shared_with_another_workspace_stays() {
        let (mut conn, ws, root) = setup();
        let other = services::workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "Other".into(),
                icon: None,
                ..Default::default()
            },
        )
        .unwrap();
        let mine = import_bytes(&mut conn, &root, &ws, "same.png", b"shared bytes").unwrap();
        let theirs =
            import_bytes(&mut conn, &root, &other.id, "same.png", b"shared bytes").unwrap();
        assert_eq!(mine.hash, theirs.hash);
        delete_unused(&mut conn, &root, &ws, std::slice::from_ref(&mine.id), false).unwrap();
        assert!(
            blob_path(&root, &mine.hash).exists(),
            "the other workspace still needs the content"
        );
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    fn get_attachment(conn: &Connection, id: &str) -> Option<Attachment> {
        super::super::get(conn, id).unwrap()
    }
}

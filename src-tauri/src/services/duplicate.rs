//! Duplicating pages: the basis of "Duplicate" in the page menu and of page templates (a template
//! is an ordinary page that gets copied). Blocks are copied through the normal batch path, so the
//! search index and page references stay correct. Files, mentions and embedded databases are
//! shared with the original rather than copied.
//!
//! A copy can also go to another workspace (`target_workspace_id`): the pages and their blocks are
//! copied there, and every file a block uses gets a record in the destination workspace, so the copy
//! keeps working on its own. Mentions of other pages and embedded databases still point at the
//! original workspace.

use super::block as block_service;
use crate::domain::*;
use crate::errors::{AppError, AppResult};
use crate::files;
use crate::repositories as repo;
use crate::search;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

const MAX_PAGES: usize = 500;
const MAX_DEPTH: usize = 16;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDuplicate {
    pub id: String,
    /// Where the copy goes (top level when absent). Ignored when `beside` is set.
    pub parent_page_id: Option<String>,
    /// Put the copy next to the original instead of under `parent_page_id`.
    #[serde(default)]
    pub beside: bool,
    pub title: Option<String>,
    /// Copy the pages inside it too.
    #[serde(default)]
    pub include_children: bool,
    /// Copy into another workspace. `parent_page_id` must then belong to it, and `beside` is ignored.
    #[serde(default)]
    pub target_workspace_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Duplicated {
    pub page: Page,
    /// Pages created, including the copy itself.
    pub pages: usize,
    /// Pages inside the original that were left out because they are not ordinary pages.
    pub skipped: usize,
}

/// Points the file a block uses at a record in `dest`, creating the record when the workspace has none yet.
fn retarget_files(tx: &Connection, data_json: &str, dest: &str) -> AppResult<String> {
    let Ok(mut data) = serde_json::from_str::<Value>(data_json) else {
        return Ok(data_json.to_string());
    };
    let Some(att) = data.get_mut("attachment").and_then(Value::as_object_mut) else {
        return Ok(data_json.to_string());
    };
    let Some(found) = att
        .get("id")
        .and_then(Value::as_str)
        .map(|id| files::get(tx, id))
        .transpose()?
        .flatten()
    else {
        return Ok(data_json.to_string());
    };
    let there = files::insert_attachment_in(
        tx,
        dest,
        &found.hash,
        &found.original_name,
        &found.mime_type,
        found.size.max(0) as u64,
    )?;
    att.insert("id".into(), Value::String(there.id));
    Ok(data.to_string())
}

fn copy_one(
    tx: &Connection,
    src: &Page,
    dest: &str,
    parent: Option<&str>,
    title: String,
    count: &mut usize,
) -> AppResult<Page> {
    if *count >= MAX_PAGES {
        return Err(AppError::Validation(format!(
            "that would copy more than {MAX_PAGES} pages at once"
        )));
    }
    let stamp = now();
    let page = Page {
        id: new_id(),
        workspace_id: dest.to_string(),
        parent_page_id: parent.map(String::from),
        title,
        icon: src.icon.clone(),
        cover: src.cover.clone(),
        position: repo::page::next_position(tx, dest, parent)?,
        favorite: false,
        archived: false,
        deleted_at: None,
        revision: 1,
        created_at: stamp.clone(),
        updated_at: stamp,
        child_count: 0,
        kind: "page".into(),
    };
    repo::page::insert(tx, &page)?;
    search::index::upsert_page(tx, &page)?;

    copy_blocks(tx, src, &page, vec![])?;
    *count += 1;
    Ok(page)
}

fn copy_blocks(tx: &Connection, src: &Page, page: &Page, delete_ids: Vec<String>) -> AppResult<()> {
    let dest = &page.workspace_id;
    let blocks = repo::block::list(tx, &src.id)?;
    let ids: HashMap<&str, String> = blocks.iter().map(|b| (b.id.as_str(), new_id())).collect();
    let moving = *dest != src.workspace_id;
    let upserts = blocks
        .iter()
        .map(|b| {
            Ok(BlockUpsert {
                id: ids[b.id.as_str()].clone(),
                parent_block_id: b
                    .parent_block_id
                    .as_ref()
                    .and_then(|p| ids.get(p.as_str()).cloned()),
                block_type: b.block_type.clone(),
                position: b.position,
                data_json: if moving {
                    retarget_files(tx, &b.data_json, dest)?
                } else {
                    b.data_json.clone()
                },
                schema_version: b.schema_version,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    block_service::apply_batch_in(
        tx,
        &BlockBatch {
            page_id: page.id.clone(),
            upserts,
            delete_ids,
        },
    )?;
    Ok(())
}

/// Apply a template only while the destination is still empty. Keep its identity and title.
pub fn apply_template(conn: &mut Connection, template_id: &str, page_id: &str) -> AppResult<()> {
    validate_id(template_id, "template")?;
    validate_id(page_id, "page")?;
    let tx = conn.transaction()?;
    let src = repo::page::get(&tx, template_id)?
        .filter(|p| p.deleted_at.is_none() && p.kind == "page")
        .ok_or_else(|| AppError::NotFound("template page".into()))?;
    let dest = repo::page::get(&tx, page_id)?
        .filter(|p| p.deleted_at.is_none() && p.kind == "page")
        .ok_or_else(|| AppError::NotFound("destination page".into()))?;
    if src.id == dest.id || src.workspace_id != dest.workspace_id {
        return Err(AppError::Validation(
            "Choose a different page template from this workspace.".into(),
        ));
    }
    let existing = repo::block::list(&tx, page_id)?;
    let blank = existing.is_empty()
        || (existing.len() == 1 && existing[0].block_type == "paragraph" && {
            let data: Value = serde_json::from_str(&existing[0].data_json).map_err(|_| {
                AppError::Validation(
                    "This page contains unreadable content. It cannot be replaced by a template."
                        .into(),
                )
            })?;
            data.get("content")
                .and_then(Value::as_array)
                .is_some_and(|c| c.is_empty())
                || (data.get("content").is_none()
                    && data
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .is_empty())
        });
    if !blank {
        return Err(AppError::Validation(
            "This page has content now. Apply a template to an empty page instead.".into(),
        ));
    }
    copy_blocks(
        &tx,
        &src,
        &dest,
        existing.into_iter().map(|b| b.id).collect(),
    )?;
    let kids = repo::page::list_children(&tx, &src.workspace_id, Some(&src.id))?;
    let (mut count, mut skipped) = (0, 0);
    copy_children(
        &tx,
        kids,
        &dest.workspace_id,
        &dest.id,
        1,
        &mut count,
        &mut skipped,
    )?;
    if skipped > 0 {
        return Err(AppError::Validation(
            "This template contains a database or dashboard. Create a new page from it instead."
                .into(),
        ));
    }
    tx.commit()?;
    Ok(())
}

fn copy_children(
    tx: &Connection,
    kids: Vec<Page>,
    dest: &str,
    new_parent: &str,
    depth: usize,
    count: &mut usize,
    skipped: &mut usize,
) -> AppResult<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    for kid in kids {
        if kid.kind != "page" {
            *skipped += 1;
            continue;
        }
        // Listed before the copy exists, so a copy placed inside its own source is never revisited.
        let grandkids = repo::page::list_children(tx, &kid.workspace_id, Some(&kid.id))?;
        let copy = copy_one(tx, &kid, dest, Some(new_parent), kid.title.clone(), count)?;
        copy_children(tx, grandkids, dest, &copy.id, depth + 1, count, skipped)?;
    }
    Ok(())
}

pub fn duplicate(conn: &mut Connection, input: PageDuplicate) -> AppResult<Duplicated> {
    validate_id(&input.id, "page")?;
    if let Some(p) = &input.parent_page_id {
        validate_id(p, "parent page")?;
    }
    if let Some(t) = &input.title {
        validate_title(t)?;
    }
    let tx = conn.transaction()?;
    let src = repo::page::get(&tx, &input.id)?
        .filter(|p| p.deleted_at.is_none())
        .ok_or_else(|| AppError::NotFound("page".into()))?;
    if src.kind != "page" {
        return Err(AppError::Validation(
            "only ordinary pages can be duplicated; databases and dashboards cannot be copied yet"
                .into(),
        ));
    }
    let dest = input
        .target_workspace_id
        .clone()
        .unwrap_or_else(|| src.workspace_id.clone());
    let elsewhere = dest != src.workspace_id;
    if elsewhere {
        validate_id(&dest, "workspace")?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace WHERE id = ?1)",
            [&dest],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(AppError::NotFound("workspace".into()));
        }
    }
    let beside = input.beside && !elsewhere;
    let parent = if beside {
        src.parent_page_id.clone()
    } else {
        input.parent_page_id.clone()
    };
    if let Some(p) = &parent {
        let ok = repo::page::get(&tx, p)?.is_some_and(|pp| {
            pp.deleted_at.is_none() && pp.workspace_id == dest && pp.kind == "page"
        });
        if !ok {
            return Err(AppError::NotFound("parent page".into()));
        }
    }
    let title = match input.title {
        Some(t) => t,
        None if beside => {
            let t = format!("{} copy", src.title);
            t.chars().take(MAX_TITLE_LEN).collect()
        }
        None => src.title.clone(),
    };
    let kids = if input.include_children {
        repo::page::list_children(&tx, &src.workspace_id, Some(&src.id))?
    } else {
        Vec::new()
    };
    let (mut count, mut skipped) = (0usize, 0usize);
    let page = copy_one(&tx, &src, &dest, parent.as_deref(), title, &mut count)?;
    copy_children(&tx, kids, &dest, &page.id, 1, &mut count, &mut skipped)?;
    tx.commit()?;
    let page = repo::page::get(conn, &page.id)?.unwrap_or(page);
    Ok(Duplicated {
        page,
        pages: count,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::open_in_memory;
    use crate::services;

    #[test]
    fn applies_template_body_and_children_without_replacing_identity_and_refuses_nonempty() {
        let (mut conn, ws) = setup();
        let src = page(&mut conn, &ws, None, "Template");
        let child = page(&mut conn, &ws, Some(&src.id), "Child");
        let dest = page(&mut conn, &ws, None, "Keep this title");
        let original = block(&mut conn, &src.id, None, "paragraph", "Reusable content");
        block(&mut conn, &child.id, None, "paragraph", "Nested content");
        apply_template(&mut conn, &src.id, &dest.id).unwrap();
        let after = repo::page::get(&conn, &dest.id).unwrap().unwrap();
        assert_eq!(after.title, "Keep this title");
        let body = repo::block::list(&conn, &dest.id).unwrap();
        assert_eq!(body.len(), 1);
        assert_ne!(body[0].id, original.id);
        assert!(body[0].data_json.contains("Reusable content"));
        assert_eq!(
            repo::page::list_children(&conn, &ws, Some(&dest.id))
                .unwrap()
                .len(),
            1
        );
        assert!(apply_template(&mut conn, &src.id, &dest.id).is_err());
        assert_eq!(repo::block::list(&conn, &dest.id).unwrap().len(), 1);
    }

    fn setup() -> (Connection, String) {
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
        (conn, ws.id)
    }

    fn page(conn: &mut Connection, ws: &str, parent: Option<&str>, title: &str) -> Page {
        services::page::create(
            conn,
            PageCreate {
                workspace_id: ws.into(),
                parent_page_id: parent.map(String::from),
                title: Some(title.into()),
                icon: None,
            },
        )
        .unwrap()
    }

    fn block(
        conn: &mut Connection,
        page: &str,
        parent: Option<&str>,
        kind: &str,
        text: &str,
    ) -> Block {
        services::block::create(
            conn,
            BlockCreate {
                page_id: page.into(),
                parent_block_id: parent.map(String::from),
                block_type: kind.into(),
                data_json: Some(
                    serde_json::json!({ "content": [{ "type": "text", "text": text }] })
                        .to_string(),
                ),
                after_block_id: None,
            },
        )
        .unwrap()
    }

    fn texts(conn: &Connection, page: &str) -> Vec<(String, String)> {
        repo::block::list(conn, page)
            .unwrap()
            .into_iter()
            .map(|b| (b.block_type, b.data_json))
            .collect()
    }

    #[test]
    fn copies_blocks_with_new_ids_and_keeps_nesting() {
        let (mut conn, ws) = setup();
        let src = page(&mut conn, &ws, None, "Plan");
        let outer = block(&mut conn, &src.id, None, "toggle", "outer");
        block(&mut conn, &src.id, Some(&outer.id), "paragraph", "inner");
        block(&mut conn, &src.id, None, "paragraph", "after");

        let out = duplicate(
            &mut conn,
            PageDuplicate {
                id: src.id.clone(),
                parent_page_id: None,
                beside: true,
                title: None,
                include_children: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(out.page.title, "Plan copy");
        assert_eq!(out.pages, 1);
        let original = repo::block::list(&conn, &src.id).unwrap();
        let copy = repo::block::list(&conn, &out.page.id).unwrap();
        assert_eq!(copy.len(), original.len());
        assert!(
            copy.iter().all(|c| original.iter().all(|o| o.id != c.id)),
            "every block gets a fresh id"
        );
        let toggle = copy.iter().find(|b| b.block_type == "toggle").unwrap();
        let inner = copy.iter().find(|b| b.data_json.contains("inner")).unwrap();
        assert_eq!(inner.parent_block_id.as_deref(), Some(toggle.id.as_str()));
        assert_eq!(texts(&conn, &out.page.id).len(), 3);
    }

    #[test]
    fn the_original_is_untouched() {
        let (mut conn, ws) = setup();
        let src = page(&mut conn, &ws, None, "Keep");
        block(&mut conn, &src.id, None, "paragraph", "same");
        let before = texts(&conn, &src.id);
        duplicate(
            &mut conn,
            PageDuplicate {
                id: src.id.clone(),
                parent_page_id: None,
                beside: true,
                title: None,
                include_children: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(texts(&conn, &src.id), before);
    }

    #[test]
    fn beside_keeps_the_parent_and_otherwise_uses_the_one_given() {
        let (mut conn, ws) = setup();
        let folder = page(&mut conn, &ws, None, "Folder");
        let other = page(&mut conn, &ws, None, "Other");
        let src = page(&mut conn, &ws, Some(&folder.id), "Doc");
        let beside = duplicate(
            &mut conn,
            PageDuplicate {
                id: src.id.clone(),
                parent_page_id: None,
                beside: true,
                title: None,
                include_children: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            beside.page.parent_page_id.as_deref(),
            Some(folder.id.as_str())
        );
        let moved = duplicate(
            &mut conn,
            PageDuplicate {
                id: src.id.clone(),
                parent_page_id: Some(other.id.clone()),
                beside: false,
                title: Some("Fresh".into()),
                include_children: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            moved.page.parent_page_id.as_deref(),
            Some(other.id.as_str())
        );
        assert_eq!(moved.page.title, "Fresh");
        let top = duplicate(
            &mut conn,
            PageDuplicate {
                id: src.id.clone(),
                parent_page_id: None,
                beside: false,
                title: None,
                include_children: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(top.page.parent_page_id, None);
        assert_eq!(
            top.page.title, "Doc",
            "a copy placed elsewhere keeps its name"
        );
    }

    #[test]
    fn can_copy_the_pages_inside_too() {
        let (mut conn, ws) = setup();
        let root = page(&mut conn, &ws, None, "Root");
        let child = page(&mut conn, &ws, Some(&root.id), "Child");
        block(&mut conn, &child.id, None, "paragraph", "deep");
        page(&mut conn, &ws, Some(&child.id), "Grandchild");
        let out = duplicate(
            &mut conn,
            PageDuplicate {
                id: root.id.clone(),
                parent_page_id: None,
                beside: true,
                title: None,
                include_children: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            out.pages, 3,
            "the copy of Root, its Child and the Grandchild"
        );
        let kids = repo::page::list_children(&conn, &ws, Some(&out.page.id)).unwrap();
        assert_eq!(kids.len(), 1);
        assert_eq!(kids[0].title, "Child");
        assert_eq!(
            repo::page::list_children(&conn, &ws, Some(&kids[0].id))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(texts(&conn, &kids[0].id).len(), 1);
    }

    #[test]
    fn copying_into_itself_does_not_loop() {
        let (mut conn, ws) = setup();
        let root = page(&mut conn, &ws, None, "Root");
        page(&mut conn, &ws, Some(&root.id), "Child");
        let out = duplicate(
            &mut conn,
            PageDuplicate {
                id: root.id.clone(),
                parent_page_id: Some(root.id.clone()),
                beside: false,
                title: Some("Inside".into()),
                include_children: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            out.pages, 2,
            "the copy and one copied child, not an endless chain"
        );
    }

    #[test]
    fn copies_into_another_workspace_with_its_pages_and_files() {
        let (mut conn, ws) = setup();
        let other = services::workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "Other".into(),
                icon: None,
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let root = page(&mut conn, &ws, None, "Root");
        let child = page(&mut conn, &ws, Some(&root.id), "Child");
        block(&mut conn, &child.id, None, "paragraph", "deep");
        let att =
            files::insert_attachment_in(&conn, &ws, &"a".repeat(64), "pic.png", "image/png", 10)
                .unwrap();
        let media = services::block::create(
            &mut conn,
            BlockCreate {
                page_id: root.id.clone(),
                parent_block_id: None,
                block_type: "image".into(),
                data_json: Some(serde_json::json!({ "attachment": { "id": att.id, "hash": att.hash, "name": "pic.png", "mime": "image/png", "size": 10 } }).to_string()),
                after_block_id: None,
            },
        )
        .unwrap();
        let out = duplicate(
            &mut conn,
            PageDuplicate {
                id: root.id.clone(),
                target_workspace_id: Some(other.clone()),
                include_children: true,
                beside: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(out.page.workspace_id, other);
        assert_eq!(
            out.page.parent_page_id, None,
            "beside is ignored for another workspace"
        );
        assert_eq!(out.pages, 2);
        let kids = repo::page::list_children(&conn, &other, Some(&out.page.id)).unwrap();
        assert_eq!(kids.len(), 1);
        assert_eq!(kids[0].workspace_id, other);
        let copied = repo::block::list(&conn, &out.page.id)
            .unwrap()
            .into_iter()
            .find(|b| b.block_type == "image")
            .unwrap();
        let data: Value = serde_json::from_str(&copied.data_json).unwrap();
        let new_id = data["attachment"]["id"].as_str().unwrap();
        assert_ne!(
            new_id, att.id,
            "the copy points at a file record of its own workspace"
        );
        assert_eq!(
            files::get(&conn, new_id).unwrap().unwrap().workspace_id,
            other
        );
        assert_eq!(
            files::get(&conn, &att.id).unwrap().unwrap().workspace_id,
            ws,
            "the original is untouched"
        );
        assert!(repo::block::list(&conn, &root.id)
            .unwrap()
            .iter()
            .any(|b| b.id == media.id));
    }

    #[test]
    fn a_parent_in_another_workspace_or_a_missing_workspace_is_refused() {
        let (mut conn, ws) = setup();
        let other = services::workspace::create(
            &mut conn,
            WorkspaceCreate {
                name: "Other".into(),
                icon: None,
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let src = page(&mut conn, &ws, None, "Doc");
        let stranger = page(&mut conn, &ws, None, "Stranger");
        let wrong_parent = duplicate(
            &mut conn,
            PageDuplicate {
                id: src.id.clone(),
                parent_page_id: Some(stranger.id),
                target_workspace_id: Some(other),
                ..Default::default()
            },
        );
        assert!(matches!(wrong_parent, Err(AppError::NotFound(_))));
        let no_workspace = duplicate(
            &mut conn,
            PageDuplicate {
                id: src.id,
                target_workspace_id: Some(new_id()),
                ..Default::default()
            },
        );
        assert!(matches!(no_workspace, Err(AppError::NotFound(_))));
    }

    #[test]
    fn databases_and_missing_pages_are_refused() {
        let (mut conn, ws) = setup();
        let missing = duplicate(
            &mut conn,
            PageDuplicate {
                id: new_id(),
                parent_page_id: None,
                beside: true,
                title: None,
                include_children: false,
                ..Default::default()
            },
        );
        assert!(matches!(missing, Err(AppError::NotFound(_))));
        let db = services::page::create(
            &mut conn,
            PageCreate {
                workspace_id: ws.clone(),
                parent_page_id: None,
                title: Some("DB".into()),
                icon: None,
            },
        )
        .unwrap();
        conn.execute("UPDATE page SET kind = 'database' WHERE id = ?1", [&db.id])
            .unwrap();
        let refused = duplicate(
            &mut conn,
            PageDuplicate {
                id: db.id,
                parent_page_id: None,
                beside: true,
                title: None,
                include_children: false,
                ..Default::default()
            },
        );
        assert!(matches!(refused, Err(AppError::Validation(_))));
    }
}

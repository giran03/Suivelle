//! Explicit map edits and inverse operations. Every multi-page change is one transaction.
use crate::{
    databases::{self, service as dbs},
    domain::*,
    errors::{AppError, AppResult},
    repositories as repo, search,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockChange {
    pub page_id: String,
    pub block_id: String,
    pub data_json: String,
    pub position: f64,
    pub expected_revision: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellChange {
    pub record_id: String,
    pub value: Value,
    pub expected: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MapEdit {
    Reference {
        source: String,
        target: String,
    },
    Move {
        source: String,
        target: Option<String>,
    },
    Relation {
        source: String,
        target: String,
        property_id: String,
        #[serde(default)]
        dependency: bool,
    },
    SetProperty {
        page_ids: Vec<String>,
        property_id: String,
        value: Value,
    },
    Tag {
        page_ids: Vec<String>,
        tag: String,
    },
    RestoreParent {
        source: String,
        parent: Option<String>,
        position: f64,
        expected_parent: Option<String>,
        expected_position: f64,
    },
    Blocks {
        changes: Vec<BlockChange>,
    },
    Cells {
        property_id: String,
        changes: Vec<CellChange>,
        #[serde(default)]
        dependency: bool,
    },
}

fn bad<T>(message: &str) -> AppResult<T> {
    Err(AppError::Validation(message.into()))
}
fn live(conn: &Connection, id: &str) -> AppResult<Page> {
    validate_id(id, "page")?;
    repo::page::get(conn, id)?
        .filter(|p| p.deleted_at.is_none())
        .ok_or_else(|| AppError::NotFound("page".into()))
}
fn editable_body(conn: &Connection, id: &str) -> AppResult<Page> {
    let p = live(conn, id)?;
    if !matches!(p.kind.as_str(), "page" | "record") {
        return bad("Only notes and record pages can contain a new reference or tag.");
    }
    Ok(p)
}
fn record_id(conn: &Connection, page_id: &str) -> AppResult<String> {
    live(conn, page_id)?;
    conn.query_row("SELECT id FROM db_record WHERE page_id=?", [page_id], |r| {
        r.get(0)
    })
    .optional()?
    .ok_or_else(|| {
        AppError::Validation("Choose records from the same database for this property.".into())
    })
}
fn cell(conn: &Connection, record_id: &str, property_id: &str) -> AppResult<Value> {
    validate_id(record_id, "record")?;
    validate_id(property_id, "property")?;
    let rows = dbs::load_rows(conn, &[record_id.into()])?;
    let row = rows
        .first()
        .ok_or_else(|| AppError::NotFound("record".into()))?;
    Ok(row.values.get(property_id).cloned().unwrap_or(Value::Null))
}
fn validate_parent(conn: &Connection, page: &Page, parent: Option<&str>) -> AppResult<()> {
    if page.kind == "record" {
        return bad("Records stay inside their database.");
    }
    if let Some(id) = parent {
        let target = live(conn, id)?;
        if target.workspace_id != page.workspace_id || target.kind != "page" {
            return bad("Choose a normal parent page in the same workspace.");
        }
        if repo::page::in_subtree(conn, &page.id, id)? {
            return bad("A page cannot be moved into itself or a descendant.");
        }
    }
    Ok(())
}
fn apply_blocks(conn: &Connection, changes: &[BlockChange]) -> AppResult<MapEdit> {
    if changes.is_empty() || changes.len() > 100 {
        return bad("Choose 1–100 pages for a map edit.");
    }
    let mut inverse = Vec::new();
    let mut seen = HashSet::new();
    for change in changes {
        editable_body(conn, &change.page_id)?;
        validate_id(&change.block_id, "block")?;
        validate_position(change.position)?;
        validate_json_object(&change.data_json, "map paragraph", 10000)?;
        if !seen.insert(&change.block_id) {
            return bad("A block appears twice in this edit.");
        }
        let existing = repo::block::get(conn, &change.block_id)?;
        if let Some(revision) = change.expected_revision {
            let b = existing.ok_or_else(|| {
                AppError::Validation("This link or tag was already removed.".into())
            })?;
            let has_children: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM block WHERE parent_block_id=?)",
                [&b.id],
                |r| r.get(0),
            )?;
            if b.page_id != change.page_id
                || b.revision != revision
                || b.data_json != change.data_json
                || b.parent_block_id.is_some()
                || b.block_type != "paragraph"
                || has_children
            {
                return bad("This paragraph changed since the map edit. Undo cannot overwrite it.");
            }
            search::index::remove_block_tree(conn, &b.id)?;
            repo::block::delete(conn, &b.id)?;
            inverse.push(BlockChange {
                expected_revision: None,
                ..change.clone()
            });
        } else {
            if existing.is_some() {
                return bad("The paragraph already exists. Refresh the map before retrying.");
            }
            let stamp = now();
            let b = Block {
                id: change.block_id.clone(),
                page_id: change.page_id.clone(),
                parent_block_id: None,
                block_type: "paragraph".into(),
                position: change.position,
                data_json: change.data_json.clone(),
                schema_version: 2,
                revision: 1,
                created_at: stamp.clone(),
                updated_at: stamp,
            };
            repo::block::insert(conn, &b)?;
            let page = live(conn, &b.page_id)?;
            search::index::upsert_block(
                conn,
                &page.workspace_id,
                &b.page_id,
                &b.id,
                "paragraph",
                2,
                &b.data_json,
            )?;
            inverse.push(BlockChange {
                expected_revision: Some(1),
                ..change.clone()
            });
        }
        repo::page::touch_updated(conn, &change.page_id, &now())?;
    }
    Ok(MapEdit::Blocks { changes: inverse })
}
fn apply_cells(
    conn: &Connection,
    property_id: &str,
    changes: &[CellChange],
    dependency: bool,
) -> AppResult<MapEdit> {
    if changes.is_empty() || changes.len() > 100 {
        return bad("Choose 1–100 records for a map edit.");
    }
    let mut seen = HashSet::new();
    let mut inverse = Vec::new();
    for change in changes {
        if !seen.insert(&change.record_id) {
            return bad("A record appears twice in this edit.");
        }
        if cell(conn, &change.record_id, property_id)? != change.expected {
            return bad("This property changed since the map edit. Refresh before retrying; undo cannot overwrite newer values.");
        }
        let row = dbs::set_value_in(
            conn,
            databases::SetValue {
                record_id: change.record_id.clone(),
                property_id: property_id.into(),
                value: change.value.clone(),
            },
        )?;
        if dependency {
            let cycle:bool=conn.query_row("WITH RECURSIVE downstream(id) AS (SELECT to_record_id FROM db_relation WHERE from_record_id=?1 AND property_id=?2 UNION SELECT r.to_record_id FROM db_relation r JOIN downstream d ON r.from_record_id=d.id WHERE r.property_id=?2) SELECT EXISTS(SELECT 1 FROM downstream WHERE id=?1)",params![change.record_id,property_id],|r|r.get(0))?;
            if cycle {
                return bad("That dependency would create a cycle.");
            }
        }
        inverse.push(CellChange {
            record_id: change.record_id.clone(),
            value: change.expected.clone(),
            expected: row.values.get(property_id).cloned().unwrap_or(Value::Null),
        });
    }
    Ok(MapEdit::Cells {
        property_id: property_id.into(),
        changes: inverse,
        dependency,
    })
}
pub fn apply(conn: &mut Connection, input: MapEdit) -> AppResult<MapEdit> {
    let tx = conn.transaction()?;
    let inverse = match input {
        MapEdit::Reference { source, target } => {
            let page = editable_body(&tx, &source)?;
            let target_page = live(&tx, &target)?;
            if source == target {
                return bad("Choose two different pages.");
            }
            let _ = (page, target_page);
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM page_reference WHERE source_page_id=? AND target_page_id=?)",params![source,target],|r|r.get(0))?;
            if exists {
                return bad("This page already references that page.");
            }
            let position = repo::block::next_position(&tx, &source, None)?;
            let change = BlockChange {
                page_id: source,
                block_id: new_id(),
                data_json: json!({"content":[{"type":"pageMention","attrs":{"pageId":target}}]})
                    .to_string(),
                position,
                expected_revision: None,
            };
            apply_blocks(&tx, &[change])?
        }
        MapEdit::Tag { page_ids, tag } => {
            let tag = tag.trim().trim_start_matches('#').to_lowercase();
            if tag.is_empty()
                || tag.chars().count() > 80
                || !tag.chars().next().is_some_and(char::is_alphabetic)
                || !tag
                    .chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
            {
                return bad("Use a tag starting with a letter, followed by letters, numbers, underscores, dashes or slashes.");
            }
            if page_ids.is_empty() || page_ids.len() > 100 {
                return bad("Choose 1–100 pages for a tag.");
            }
            let mut changes = Vec::new();
            let mut seen = HashSet::new();
            for id in page_ids {
                if !seen.insert(id.clone()) {
                    continue;
                }
                editable_body(&tx, &id)?;
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM block_tag WHERE page_id=? AND tag=?)",
                    params![id, tag],
                    |r| r.get(0),
                )?;
                if exists {
                    continue;
                }
                let position = repo::block::next_position(&tx, &id, None)?;
                changes.push(BlockChange {
                    page_id: id,
                    block_id: new_id(),
                    data_json: json!({"content":[{"type":"text","text":format!("#{tag}")}]})
                        .to_string(),
                    position,
                    expected_revision: None,
                });
            }
            if changes.is_empty() {
                return bad("All selected pages already have this tag.");
            }
            apply_blocks(&tx, &changes)?
        }
        MapEdit::Move { source, target } => {
            let page = live(&tx, &source)?;
            validate_parent(&tx, &page, target.as_deref())?;
            let position = repo::page::next_position(&tx, &page.workspace_id, target.as_deref())?;
            repo::page::set_parent_position(&tx, &source, target.as_deref(), position, &now())?;
            MapEdit::RestoreParent {
                source,
                parent: page.parent_page_id,
                position: page.position,
                expected_parent: target,
                expected_position: position,
            }
        }
        MapEdit::RestoreParent {
            source,
            parent,
            position,
            expected_parent,
            expected_position,
        } => {
            let page = live(&tx, &source)?;
            validate_position(position)?;
            validate_parent(&tx, &page, parent.as_deref())?;
            if page.parent_page_id != expected_parent || page.position != expected_position {
                return bad("This page changed since the move. Undo cannot overwrite it.");
            }
            repo::page::set_parent_position(&tx, &source, parent.as_deref(), position, &now())?;
            MapEdit::RestoreParent {
                source,
                parent: page.parent_page_id,
                position: page.position,
                expected_parent: parent,
                expected_position: position,
            }
        }
        MapEdit::SetProperty {
            page_ids,
            property_id,
            value,
        } => {
            if page_ids.is_empty() || page_ids.len() > 100 {
                return bad("Choose 1–100 records for a property change.");
            }
            let mut changes = Vec::new();
            for page_id in page_ids {
                let id = record_id(&tx, &page_id)?;
                changes.push(CellChange {
                    expected: cell(&tx, &id, &property_id)?,
                    record_id: id,
                    value: value.clone(),
                });
            }
            apply_cells(&tx, &property_id, &changes, false)?
        }
        MapEdit::Relation {
            source,
            target,
            property_id,
            dependency,
        } => {
            let from = record_id(&tx, &source)?;
            let to = record_id(&tx, &target)?;
            let kind: String = tx.query_row(
                "SELECT type FROM db_property WHERE id=?",
                [&property_id],
                |r| r.get(0),
            )?;
            if kind != "relation" {
                return bad("Choose a relation property.");
            }
            if dependency {
                let cycle:bool=tx.query_row("WITH RECURSIVE downstream(id) AS (SELECT ?1 UNION SELECT r.to_record_id FROM db_relation r JOIN downstream d ON r.from_record_id=d.id WHERE r.property_id=?2) SELECT EXISTS(SELECT 1 FROM downstream WHERE id=?3)",params![to,property_id,from],|r|r.get(0))?;
                if cycle {
                    return bad("That dependency would create a cycle.");
                }
            }
            let old = cell(&tx, &from, &property_id)?;
            let mut links = old.as_array().cloned().unwrap_or_default();
            if links.contains(&Value::String(to.clone())) {
                return bad("These records are already related through that property.");
            }
            links.push(Value::String(to));
            apply_cells(
                &tx,
                &property_id,
                &[CellChange {
                    record_id: from,
                    expected: old,
                    value: Value::Array(links),
                }],
                dependency,
            )?
        }
        MapEdit::Blocks { changes } => apply_blocks(&tx, &changes)?,
        MapEdit::Cells {
            property_id,
            changes,
            dependency,
        } => apply_cells(&tx, &property_id, &changes, dependency)?,
    };
    tx.commit()?;
    Ok(inverse)
}

//! Canvases: freeform 2D boards of cards, notes and images joined by arrows.
//!
//! A canvas is either a database *view* (cards are its records) or a workspace *board* (cards are
//! any pages). Positions live here, not on records or pages, because the same one can sit anywhere
//! on each canvas. Edits arrive as small batches of operations applied in one transaction.

use super::service::load_view_by_id;
use crate::domain::{new_id, now, validate_id, validate_name};
use crate::errors::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MAX_ITEMS: i64 = 1_000;
pub const MAX_EDGES: i64 = 3_000;
const MAX_TEXT: usize = 5_000;
const MAX_COORD: f64 = 1_000_000.0;
const MIN_SIZE: f64 = 40.0;
const MAX_SIZE: f64 = 4_000.0;

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasItem {
    pub id: String,
    /// `record` (views only), `page` (boards only), `note` or `image`.
    pub kind: String,
    #[serde(default)]
    pub record_id: Option<String>,
    #[serde(default)]
    pub page_id: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub attachment_hash: Option<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub z: i64,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEdge {
    pub id: String,
    pub from_item: String,
    pub to_item: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CanvasData {
    pub items: Vec<CanvasItem>,
    pub edges: Vec<CanvasEdge>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum CanvasOp {
    UpsertItem { item: CanvasItem },
    DeleteItem { id: String },
    UpsertEdge { edge: CanvasEdge },
    DeleteEdge { id: String },
}

fn finite_in(v: f64, lo: f64, hi: f64, what: &str) -> AppResult<f64> {
    if !v.is_finite() || v < lo || v > hi {
        return bad(format!("{what} is out of range"));
    }
    Ok(v)
}

fn check_item(i: &CanvasItem, scope: Scope) -> AppResult<()> {
    validate_id(&i.id, "canvas item")?;
    finite_in(i.x, -MAX_COORD, MAX_COORD, "x")?;
    finite_in(i.y, -MAX_COORD, MAX_COORD, "y")?;
    finite_in(i.w, MIN_SIZE, MAX_SIZE, "width")?;
    finite_in(i.h, MIN_SIZE, MAX_SIZE, "height")?;
    if i.text.chars().count() > MAX_TEXT {
        return bad("a note can hold at most 5,000 characters");
    }
    if i.color.as_deref().is_some_and(|c| c.len() > 32) {
        return bad("invalid color");
    }
    match (i.kind.as_str(), scope) {
        ("record", Scope::View(_)) => match i.record_id.as_deref() {
            Some(r) => validate_id(r, "record"),
            None => bad("a record card needs a record"),
        },
        ("page", Scope::Board(_)) => match i.page_id.as_deref() {
            Some(p) => validate_id(p, "page"),
            None => bad("a page card needs a page"),
        },
        ("note", _) => Ok(()),
        ("image", _) => {
            let ok = i.attachment_hash.as_deref().is_some_and(|h| {
                !h.is_empty() && h.len() <= 128 && h.bytes().all(|b| b.is_ascii_alphanumeric())
            });
            if ok {
                Ok(())
            } else {
                bad("an image needs an attachment")
            }
        }
        _ => bad("unknown canvas item kind"),
    }
}

/// Which canvas an operation targets: a database view or a workspace board.
#[derive(Clone, Copy)]
pub enum Scope<'a> {
    View(&'a str),
    Board(&'a str),
}

struct Names {
    items: &'static str,
    edges: &'static str,
    owner: &'static str,
    card: &'static str,
}

impl<'a> Scope<'a> {
    fn owner(self) -> &'a str {
        match self {
            Scope::View(id) | Scope::Board(id) => id,
        }
    }
    fn names(self) -> Names {
        match self {
            Scope::View(_) => Names {
                items: "db_canvas_item",
                edges: "db_canvas_edge",
                owner: "view_id",
                card: "record_id",
            },
            Scope::Board(_) => Names {
                items: "canvas_board_item",
                edges: "canvas_board_edge",
                owner: "board_id",
                card: "page_id",
            },
        }
    }
}

fn canvas_view(conn: &Connection, view_id: &str) -> AppResult<super::DbView> {
    validate_id(view_id, "view")?;
    let view = load_view_by_id(conn, view_id)?;
    if view.view_type != "canvas" {
        return bad("that view is not a canvas");
    }
    Ok(view)
}

fn check_board(conn: &Connection, board_id: &str) -> AppResult<()> {
    validate_id(board_id, "board")?;
    let here: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM canvas_board WHERE id = ?1)",
        [board_id],
        |r| r.get(0),
    )?;
    if here {
        Ok(())
    } else {
        Err(AppError::NotFound("canvas".into()))
    }
}

/// Loads a database view's canvas.
pub fn load(conn: &Connection, view_id: &str) -> AppResult<CanvasData> {
    canvas_view(conn, view_id)?;
    load_scope(conn, Scope::View(view_id))
}

/// Loads a workspace board.
pub fn load_board(conn: &Connection, board_id: &str) -> AppResult<CanvasData> {
    check_board(conn, board_id)?;
    load_scope(conn, Scope::Board(board_id))
}

fn load_scope(conn: &Connection, scope: Scope) -> AppResult<CanvasData> {
    let n = scope.names();
    let owner = scope.owner();
    // Items whose record or page is in the trash stay stored but are not shown.
    let sql = match scope {
        Scope::View(_) => format!(
            "SELECT i.id, i.kind, i.record_id, NULL, i.text, i.attachment_hash, i.x, i.y, i.w, i.h, i.z, i.color
             FROM {items} i
             LEFT JOIN db_record r ON r.id = i.record_id
             LEFT JOIN page p ON p.id = r.page_id
             WHERE i.{o} = ?1 AND (i.record_id IS NULL OR p.deleted_at IS NULL)
             ORDER BY i.z, i.rowid",
            items = n.items,
            o = n.owner
        ),
        Scope::Board(_) => format!(
            "SELECT i.id, i.kind, NULL, i.page_id, i.text, i.attachment_hash, i.x, i.y, i.w, i.h, i.z, i.color
             FROM {items} i
             LEFT JOIN page p ON p.id = i.page_id
             WHERE i.{o} = ?1 AND (i.page_id IS NULL OR p.deleted_at IS NULL)
             ORDER BY i.z, i.rowid",
            items = n.items,
            o = n.owner
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map([owner], |r| {
            Ok(CanvasItem {
                id: r.get(0)?,
                kind: r.get(1)?,
                record_id: r.get(2)?,
                page_id: r.get(3)?,
                text: r.get(4)?,
                attachment_hash: r.get(5)?,
                x: r.get(6)?,
                y: r.get(7)?,
                w: r.get(8)?,
                h: r.get(9)?,
                z: r.get(10)?,
                color: r.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT id, from_item, to_item, label FROM {} WHERE {} = ?1 ORDER BY rowid",
        n.edges, n.owner
    ))?;
    let edges = stmt
        .query_map([owner], |r| {
            Ok(CanvasEdge {
                id: r.get(0)?,
                from_item: r.get(1)?,
                to_item: r.get(2)?,
                label: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CanvasData { items, edges })
}

/// Applies a batch of edits to a view's canvas atomically. Either every operation lands or none does.
pub fn apply(conn: &mut Connection, view_id: &str, ops: &[CanvasOp]) -> AppResult<()> {
    let tx = conn.transaction()?;
    apply_in(&tx, view_id, ops)?;
    tx.commit()?;
    Ok(())
}

/// [`apply`] inside a transaction the caller owns (an import runs many steps in one).
pub fn apply_in(tx: &Connection, view_id: &str, ops: &[CanvasOp]) -> AppResult<()> {
    canvas_view(tx, view_id)?;
    apply_scope(tx, Scope::View(view_id), ops)
}

/// Applies a batch of edits to a workspace board atomically.
pub fn apply_board(conn: &mut Connection, board_id: &str, ops: &[CanvasOp]) -> AppResult<()> {
    let tx = conn.transaction()?;
    apply_board_in(&tx, board_id, ops)?;
    tx.execute(
        "UPDATE canvas_board SET updated_at = ?2 WHERE id = ?1",
        params![board_id, now()],
    )?;
    tx.commit()?;
    Ok(())
}

/// [`apply_board`] inside a transaction the caller owns.
pub fn apply_board_in(tx: &Connection, board_id: &str, ops: &[CanvasOp]) -> AppResult<()> {
    check_board(tx, board_id)?;
    apply_scope(tx, Scope::Board(board_id), ops)
}

fn apply_scope(tx: &Connection, scope: Scope, ops: &[CanvasOp]) -> AppResult<()> {
    if ops.len() > 2_000 {
        return bad("too many canvas changes at once");
    }
    let n = scope.names();
    let owner = scope.owner();
    let database_id = match scope {
        Scope::View(v) => Some(load_view_by_id(tx, v)?.database_id),
        Scope::Board(_) => None,
    };
    for op in ops {
        match op {
            CanvasOp::UpsertItem { item } => {
                check_item(item, scope)?;
                let card = match scope {
                    Scope::View(_) => item.record_id.as_deref(),
                    Scope::Board(_) => item.page_id.as_deref(),
                };
                if let Some(card) = card {
                    let ok: bool = match &database_id {
                        Some(db) => tx.query_row(
                            "SELECT EXISTS(SELECT 1 FROM db_record WHERE id = ?1 AND database_id = ?2)",
                            params![card, db],
                            |r| r.get(0),
                        )?,
                        None => tx.query_row(
                            "SELECT EXISTS(SELECT 1 FROM page p JOIN canvas_board b ON b.workspace_id = p.workspace_id WHERE p.id = ?1 AND b.id = ?2)",
                            params![card, owner],
                            |r| r.get(0),
                        )?,
                    };
                    if !ok {
                        return bad(match scope {
                            Scope::View(_) => "that record is not in this database",
                            Scope::Board(_) => "that page is not in this workspace",
                        });
                    }
                }
                let changed = tx.execute(
                    &format!(
                        "INSERT INTO {items} (id, {o}, kind, {card}, text, attachment_hash, x, y, w, h, z, color)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                         ON CONFLICT(id) DO UPDATE SET text = excluded.text, attachment_hash = excluded.attachment_hash,
                             x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, z = excluded.z, color = excluded.color
                         WHERE {items}.{o} = excluded.{o} AND {items}.kind = excluded.kind",
                        items = n.items,
                        o = n.owner,
                        card = n.card
                    ),
                    params![item.id, owner, item.kind, card, item.text, item.attachment_hash, item.x, item.y, item.w, item.h, item.z, item.color],
                )?;
                if changed == 0 {
                    return bad("that canvas item belongs to another canvas");
                }
            }
            CanvasOp::DeleteItem { id } => {
                validate_id(id, "canvas item")?;
                tx.execute(
                    &format!("DELETE FROM {} WHERE id = ?1 AND {} = ?2", n.items, n.owner),
                    params![id, owner],
                )?;
            }
            CanvasOp::UpsertEdge { edge } => {
                validate_id(&edge.id, "canvas edge")?;
                if edge.label.chars().count() > 200 {
                    return bad("an arrow label can hold at most 200 characters");
                }
                if edge.from_item == edge.to_item {
                    return bad("an arrow needs two different items");
                }
                for end in [&edge.from_item, &edge.to_item] {
                    validate_id(end, "canvas item")?;
                    let here: bool = tx.query_row(
                        &format!(
                            "SELECT EXISTS(SELECT 1 FROM {} WHERE id = ?1 AND {} = ?2)",
                            n.items, n.owner
                        ),
                        params![end, owner],
                        |r| r.get(0),
                    )?;
                    if !here {
                        return bad("an arrow must connect items on this canvas");
                    }
                }
                let changed = tx.execute(
                    &format!(
                        "INSERT INTO {edges} (id, {o}, from_item, to_item, label) VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT(id) DO UPDATE SET label = excluded.label, from_item = excluded.from_item, to_item = excluded.to_item
                         WHERE {edges}.{o} = excluded.{o}",
                        edges = n.edges,
                        o = n.owner
                    ),
                    params![edge.id, owner, edge.from_item, edge.to_item, edge.label],
                )?;
                if changed == 0 {
                    return bad("that arrow belongs to another canvas");
                }
            }
            CanvasOp::DeleteEdge { id } => {
                validate_id(id, "canvas edge")?;
                tx.execute(
                    &format!("DELETE FROM {} WHERE id = ?1 AND {} = ?2", n.edges, n.owner),
                    params![id, owner],
                )?;
            }
        }
    }
    let items: i64 = tx.query_row(
        &format!("SELECT COUNT(*) FROM {} WHERE {} = ?1", n.items, n.owner),
        [owner],
        |r| r.get(0),
    )?;
    let edges: i64 = tx.query_row(
        &format!("SELECT COUNT(*) FROM {} WHERE {} = ?1", n.edges, n.owner),
        [owner],
        |r| r.get(0),
    )?;
    if items > MAX_ITEMS {
        return bad(format!("a canvas can hold at most {MAX_ITEMS} items"));
    }
    if edges > MAX_EDGES {
        return bad(format!("a canvas can hold at most {MAX_EDGES} arrows"));
    }
    Ok(())
}

// ---- boards ----

pub const MAX_BOARDS: i64 = 200;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBoard {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

fn board_row(r: &rusqlite::Row) -> rusqlite::Result<CanvasBoard> {
    Ok(CanvasBoard {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        name: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
    })
}

pub fn list_boards(conn: &Connection, workspace_id: &str) -> AppResult<Vec<CanvasBoard>> {
    validate_id(workspace_id, "workspace")?;
    let mut stmt = conn.prepare("SELECT id, workspace_id, name, created_at, updated_at FROM canvas_board WHERE workspace_id = ?1 ORDER BY created_at, rowid")?;
    let rows = stmt
        .query_map([workspace_id], board_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn board(conn: &Connection, id: &str) -> AppResult<CanvasBoard> {
    validate_id(id, "board")?;
    conn.query_row(
        "SELECT id, workspace_id, name, created_at, updated_at FROM canvas_board WHERE id = ?1",
        [id],
        board_row,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("canvas".into()),
        e => e.into(),
    })
}

pub fn create_board(conn: &Connection, workspace_id: &str, name: &str) -> AppResult<CanvasBoard> {
    validate_id(workspace_id, "workspace")?;
    let name = name.trim();
    let name = if name.is_empty() {
        "Untitled canvas"
    } else {
        name
    };
    validate_name(name)?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM canvas_board WHERE workspace_id = ?1",
        [workspace_id],
        |r| r.get(0),
    )?;
    if count >= MAX_BOARDS {
        return bad(format!(
            "a workspace can hold at most {MAX_BOARDS} canvases"
        ));
    }
    let id = new_id();
    let at = now();
    conn.execute(
        "INSERT INTO canvas_board (id, workspace_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, workspace_id, name, at],
    )?;
    board(conn, &id)
}

pub fn rename_board(conn: &Connection, id: &str, name: &str) -> AppResult<CanvasBoard> {
    validate_name(name)?;
    board(conn, id)?;
    conn.execute(
        "UPDATE canvas_board SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name.trim(), now()],
    )?;
    board(conn, id)
}

pub fn delete_board(conn: &Connection, id: &str) -> AppResult<()> {
    board(conn, id)?;
    conn.execute("DELETE FROM canvas_board WHERE id = ?1", [id])?;
    Ok(())
}

/// Copies a board, its cards and arrows, under a new name.
pub fn duplicate_board(conn: &Connection, id: &str) -> AppResult<CanvasBoard> {
    let src = board(conn, id)?;
    let copy = create_board(conn, &src.workspace_id, &format!("{} copy", src.name))?;
    copy_scope(conn, Scope::Board(id), Scope::Board(&copy.id))?;
    Ok(copy)
}

// ---- archives and copies ----

/// A canvas as exported in an archive: items and arrows under the ids they had.
pub fn export_json(conn: &Connection, view_id: &str) -> AppResult<serde_json::Value> {
    serde_json::to_value(load(conn, view_id)?).map_err(|e| AppError::Internal(e.to_string()))
}

/// A board as exported in an archive.
pub fn export_board_json(conn: &Connection, board_id: &str) -> AppResult<serde_json::Value> {
    let b = board(conn, board_id)?;
    let data = load_scope(conn, Scope::Board(board_id))?;
    Ok(serde_json::json!({ "name": b.name, "canvas": data }))
}

/// Operations that rebuild an exported canvas under new ids. `card_id` maps an exported record id
/// (views) or page id (boards) to its imported one; cards whose target did not come across are dropped.
pub fn import_ops(
    data: &serde_json::Value,
    card_id: &dyn Fn(&str) -> Option<String>,
) -> Vec<CanvasOp> {
    let Ok(data) = serde_json::from_value::<CanvasData>(data.clone()) else {
        return Vec::new();
    };
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut ops = Vec::new();
    for mut item in data.items {
        match item.kind.as_str() {
            "record" => {
                let Some(rid) = item.record_id.as_deref().and_then(card_id) else {
                    continue;
                };
                item.record_id = Some(rid);
            }
            "page" => {
                let Some(pid) = item.page_id.as_deref().and_then(card_id) else {
                    continue;
                };
                item.page_id = Some(pid);
            }
            _ => {}
        }
        let fresh = new_id();
        ids.insert(std::mem::replace(&mut item.id, fresh), item.id.clone());
        ops.push(CanvasOp::UpsertItem { item });
    }
    for e in data.edges {
        if let (Some(a), Some(b)) = (ids.get(&e.from_item), ids.get(&e.to_item)) {
            ops.push(CanvasOp::UpsertEdge {
                edge: CanvasEdge {
                    id: new_id(),
                    from_item: a.clone(),
                    to_item: b.clone(),
                    label: e.label,
                },
            });
        }
    }
    ops
}

/// Copies a canvas view's items and arrows onto another view (duplicating a view).
pub fn copy_view(conn: &Connection, from: &str, to: &str) -> AppResult<()> {
    copy_scope(conn, Scope::View(from), Scope::View(to))
}

fn copy_scope(conn: &Connection, from: Scope, to: Scope) -> AppResult<()> {
    let (f, t) = (from.names(), to.names());
    let mut map: HashMap<String, String> = HashMap::new();
    let mut stmt = conn.prepare(&format!(
        "SELECT id FROM {} WHERE {} = ?1",
        f.items, f.owner
    ))?;
    let ids = stmt
        .query_map([from.owner()], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for old in ids {
        let fresh = new_id();
        conn.execute(
            &format!(
                "INSERT INTO {ti} (id, {to_o}, kind, {card}, text, attachment_hash, x, y, w, h, z, color)
                 SELECT ?1, ?2, kind, {card}, text, attachment_hash, x, y, w, h, z, color
                 FROM {fi} WHERE id = ?3",
                ti = t.items,
                to_o = t.owner,
                card = t.card,
                fi = f.items
            ),
            params![fresh, to.owner(), old],
        )?;
        map.insert(old, fresh);
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT from_item, to_item, label FROM {} WHERE {} = ?1",
        f.edges, f.owner
    ))?;
    let edges = stmt
        .query_map([from.owner()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (a, b, label) in edges {
        if let (Some(a), Some(b)) = (map.get(&a), map.get(&b)) {
            conn.execute(
                &format!("INSERT INTO {} (id, {}, from_item, to_item, label) VALUES (?1, ?2, ?3, ?4, ?5)", t.edges, t.owner),
                params![new_id(), to.owner(), a, b, label],
            )?;
        }
    }
    Ok(())
}

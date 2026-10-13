//! Record templates: a reusable starting point for new records in one database.
//!
//! A template holds a default title, property values and body blocks, usually captured from a
//! record you set up by hand. Creating a record from a template copies those (new block ids,
//! so every record is independent), then applies whatever the caller passes on top.

use super::service::{load_database, load_properties, load_rows};
use super::*;
use crate::domain::{new_id, now, validate_id, validate_title, BlockBatch, BlockUpsert};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BodyBlock {
    id: String,
    parent_block_id: Option<String>,
    #[serde(rename = "type")]
    block_type: String,
    position: f64,
    data_json: String,
    schema_version: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordTemplate {
    pub id: String,
    pub database_id: String,
    pub name: String,
    pub title: String,
    pub values: Map<String, Value>,
    pub block_count: usize,
    pub is_default: bool,
}

pub(crate) struct Stored {
    pub info: RecordTemplate,
    body: Vec<BodyBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordTemplateCreate {
    pub database_id: String,
    pub name: String,
    /// Capture the title, values and body of this record.
    #[serde(default)]
    pub from_record_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordTemplateUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub is_default: Option<bool>,
}

fn name_of(n: &str) -> AppResult<String> {
    let n = n.trim();
    if n.is_empty() || n.chars().count() > 60 {
        return bad("template names must be 1-60 characters");
    }
    Ok(n.to_string())
}

fn stored_row(
    r: &rusqlite::Row,
) -> rusqlite::Result<(String, String, String, String, String, String, bool)> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get::<_, i64>(6)? != 0,
    ))
}

const COLS: &str = "id, database_id, name, title, values_json, body_json, is_default";

fn build(row: (String, String, String, String, String, String, bool)) -> Stored {
    let (id, database_id, name, title, values_json, body_json, is_default) = row;
    let body: Vec<BodyBlock> = serde_json::from_str(&body_json).unwrap_or_default();
    Stored {
        info: RecordTemplate {
            id,
            database_id,
            name,
            title,
            values: serde_json::from_str(&values_json).unwrap_or_default(),
            block_count: body.len(),
            is_default,
        },
        body,
    }
}

pub fn list(conn: &Connection, database_id: &str) -> AppResult<Vec<RecordTemplate>> {
    validate_id(database_id, "database")?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM db_record_template WHERE database_id = ?1 ORDER BY position, created_at, id"
    ))?;
    let rows = stmt.query_map([database_id], stored_row)?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|r| build(r).info)
        .collect())
}

pub(crate) fn load(conn: &Connection, id: &str, database_id: &str) -> AppResult<Stored> {
    validate_id(id, "template")?;
    let row = conn
        .query_row(
            &format!("SELECT {COLS} FROM db_record_template WHERE id = ?1"),
            [id],
            stored_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("template".into()))?;
    let t = build(row);
    if t.info.database_id != database_id {
        return bad("that template belongs to another database");
    }
    Ok(t)
}

pub fn create(conn: &mut Connection, input: RecordTemplateCreate) -> AppResult<RecordTemplate> {
    validate_id(&input.database_id, "database")?;
    let name = name_of(&input.name)?;
    let tx = conn.transaction()?;
    let db = load_database(&tx, &input.database_id)?;
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM db_record_template WHERE database_id = ?1",
        [&db.id],
        |r| r.get(0),
    )?;
    if count as usize >= MAX_RECORD_TEMPLATES {
        return bad(format!(
            "a database can have at most {MAX_RECORD_TEMPLATES} templates"
        ));
    }
    let mut title = String::new();
    let mut values = Map::new();
    let mut body: Vec<BodyBlock> = Vec::new();
    if let Some(rid) = &input.from_record_id {
        validate_id(rid, "record")?;
        let row = load_rows(&tx, std::slice::from_ref(rid))?
            .into_iter()
            .next()
            .ok_or_else(|| AppError::NotFound("record".into()))?;
        if row.database_id != db.id {
            return bad("that record belongs to another database");
        }
        let props = load_properties(&tx, &db.id)?;
        title = row.title.clone();
        for (pid, v) in &row.values {
            if props
                .iter()
                .any(|p| &p.id == pid && super::forms::fillable(p))
            {
                values.insert(pid.clone(), v.clone());
            }
        }
        body = repo::block::list(&tx, &row.page_id)?
            .into_iter()
            .map(|b| BodyBlock {
                id: b.id,
                parent_block_id: b.parent_block_id,
                block_type: b.block_type,
                position: b.position,
                data_json: b.data_json,
                schema_version: b.schema_version,
            })
            .collect();
    }
    let position: f64 = tx.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM db_record_template WHERE database_id = ?1",
        [&db.id],
        |r| r.get(0),
    )?;
    let id = new_id();
    let stamp = now();
    tx.execute(
        "INSERT INTO db_record_template (id, database_id, name, title, values_json, body_json, is_default, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            id,
            db.id,
            name,
            title,
            Value::Object(values).to_string(),
            serde_json::to_string(&body).map_err(|e| AppError::Internal(e.to_string()))?,
            (count == 0) as i64,
            position,
            stamp
        ],
    )?;
    let out = load(&tx, &id, &db.id)?.info;
    tx.commit()?;
    Ok(out)
}

pub fn update(conn: &mut Connection, input: RecordTemplateUpdate) -> AppResult<RecordTemplate> {
    validate_id(&input.id, "template")?;
    let tx = conn.transaction()?;
    let database_id: String = tx
        .query_row(
            "SELECT database_id FROM db_record_template WHERE id = ?1",
            [&input.id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("template".into()))?;
    let stamp = now();
    if let Some(n) = &input.name {
        tx.execute(
            "UPDATE db_record_template SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![input.id, name_of(n)?, stamp],
        )?;
    }
    if let Some(t) = &input.title {
        validate_title(t)?;
        tx.execute(
            "UPDATE db_record_template SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![input.id, t, stamp],
        )?;
    }
    match input.is_default {
        Some(true) => {
            tx.execute(
                "UPDATE db_record_template SET is_default = (id = ?1) WHERE database_id = ?2",
                params![input.id, database_id],
            )?;
        }
        Some(false) => {
            tx.execute(
                "UPDATE db_record_template SET is_default = 0 WHERE id = ?1",
                [&input.id],
            )?;
        }
        None => {}
    }
    let out = load(&tx, &input.id, &database_id)?.info;
    tx.commit()?;
    Ok(out)
}

pub fn delete(conn: &mut Connection, id: &str) -> AppResult<()> {
    validate_id(id, "template")?;
    let n = conn.execute("DELETE FROM db_record_template WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(AppError::NotFound("template".into()));
    }
    Ok(())
}

/// Copies a template's body onto a new record page, with fresh block ids.
pub(super) fn apply_body(tx: &Connection, page_id: &str, t: &Stored) -> AppResult<()> {
    if t.body.is_empty() {
        return Ok(());
    }
    let ids: HashMap<&str, String> = t.body.iter().map(|b| (b.id.as_str(), new_id())).collect();
    let upserts = t
        .body
        .iter()
        .map(|b| BlockUpsert {
            id: ids[b.id.as_str()].clone(),
            parent_block_id: b
                .parent_block_id
                .as_deref()
                .and_then(|p| ids.get(p).cloned()),
            block_type: b.block_type.clone(),
            position: b.position,
            data_json: b.data_json.clone(),
            schema_version: b.schema_version,
        })
        .collect();
    crate::services::block::apply_batch_in(
        tx,
        &BlockBatch {
            page_id: page_id.to_string(),
            upserts,
            delete_ids: vec![],
        },
    )?;
    Ok(())
}

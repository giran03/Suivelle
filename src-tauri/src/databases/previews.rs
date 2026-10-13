//! Gallery previews: a record's first image, else the start of its text.

use super::RecordPreview;
use crate::domain::validate_id;
use crate::errors::{AppError, AppResult};
use crate::search::text::plain_text;
use rusqlite::{params, Connection};
use serde_json::Value;

const MAX_IDS: usize = 100;
const EXCERPT_CHARS: usize = 160;

pub fn previews(conn: &Connection, record_ids: &[String]) -> AppResult<Vec<RecordPreview>> {
    if record_ids.len() > MAX_IDS {
        return Err(AppError::Validation(format!(
            "previews can be loaded for at most {MAX_IDS} records at a time"
        )));
    }
    let mut out = Vec::new();
    for id in record_ids {
        validate_id(id, "record")?;
        let mut stmt = conn.prepare(
            "SELECT b.type, b.schema_version, b.data_json FROM db_record r JOIN block b ON b.page_id = r.page_id
             WHERE r.id = ?1 ORDER BY b.parent_block_id IS NOT NULL, b.position, b.id",
        )?;
        let blocks: Vec<(String, i64, String)> = stmt
            .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        let mut preview = RecordPreview {
            record_id: id.clone(),
            image_hash: None,
            image_name: None,
            text: None,
        };
        for (kind, _, data) in &blocks {
            if kind == "image" {
                if let Ok(v) = serde_json::from_str::<Value>(data) {
                    if let Some(hash) = v.pointer("/attachment/hash").and_then(Value::as_str) {
                        preview.image_hash = Some(hash.to_string());
                        preview.image_name = v
                            .pointer("/attachment/name")
                            .and_then(Value::as_str)
                            .map(String::from);
                        break;
                    }
                }
            }
        }
        if preview.image_hash.is_none() {
            let text = blocks
                .iter()
                .filter(|(k, ..)| {
                    !matches!(k.as_str(), "image" | "audio" | "video" | "pdf" | "file")
                })
                .map(|(k, v, d)| plain_text(k, *v, d))
                .find(|t| !t.is_empty());
            preview.text = text.map(|t| {
                let cut: String = t.chars().take(EXCERPT_CHARS).collect();
                if t.chars().count() > EXCERPT_CHARS {
                    format!("{}…", cut.trim_end())
                } else {
                    cut
                }
            });
        }
        out.push(preview);
    }
    Ok(out)
}

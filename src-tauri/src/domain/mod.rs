use crate::errors::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
pub mod embed;

pub const MAX_TITLE_LEN: usize = 500;
pub const MAX_NAME_LEN: usize = 200;
pub const MAX_BLOCK_DATA_BYTES: usize = 1_000_000;
/// v1: plain `{text}` blocks (Phase 0). v2: rich-text `{content}` and typed block data (Phase 2).
pub const BLOCK_SCHEMA_VERSION: i64 = 2;
pub const MAX_BATCH_OPS: usize = 5000;

/// Block types implemented so far (the plan's full list arrives with Phase 2).
pub const BLOCK_TYPES: &[&str] = &[
    "paragraph",
    "heading_1",
    "heading_2",
    "heading_3",
    "bullet_list",
    "numbered_list",
    "todo",
    "tabs",
    "tab_panel",
    "toggle",
    "quote",
    "callout",
    "divider",
    "code",
    "equation",
    "simple_table",
    "image",
    "audio",
    "video",
    "file",
    "pdf",
    "embed",
    "columns",
    "column",
    "database_view",
    "table_of_contents",
    "synced_block",
];

pub fn new_id() -> String {
    Uuid::now_v7().to_string()
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub settings_json: String,
    pub schema_version: i64,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub workspace_id: String,
    pub parent_page_id: Option<String>,
    pub title: String,
    pub icon: Option<String>,
    pub cover: Option<String>,
    pub position: f64,
    pub favorite: bool,
    pub archived: bool,
    pub deleted_at: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Live (non-trashed) direct children; lets the sidebar show a chevron without loading them.
    pub child_count: i64,
    /// "page", "database" (a page whose body is a table) or "record" (a row of a database).
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    pub page_id: String,
    pub parent_block_id: Option<String>,
    #[serde(rename = "type")]
    pub block_type: String,
    pub position: f64,
    pub data_json: String,
    pub schema_version: i64,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub workspace_id: String,
    pub hash: String,
    pub original_name: String,
    pub mime_type: String,
    pub size: i64,
    pub created_at: String,
}

/// One block to insert or overwrite; the id is chosen by the editor.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockUpsert {
    pub id: String,
    pub parent_block_id: Option<String>,
    #[serde(rename = "type")]
    pub block_type: String,
    pub position: f64,
    pub data_json: String,
    pub schema_version: i64,
}

/// Everything the editor changed since the last save, applied in one transaction.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockBatch {
    pub page_id: String,
    pub upserts: Vec<BlockUpsert>,
    pub delete_ids: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCreate {
    pub name: String,
    pub icon: Option<String>,
    pub settings_json: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUpdate {
    pub id: String,
    pub name: Option<String>,
    pub icon: Option<String>,
    #[serde(default)]
    pub clear_icon: bool,
    pub settings_json: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStats {
    pub pages: i64,
    pub records: i64,
    pub databases: i64,
    pub dashboards: i64,
    pub trashed: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMove {
    pub id: String,
    /// New parent; `None` moves the page to the top level.
    pub parent_page_id: Option<String>,
    /// Insert before this sibling; appended at the end when absent.
    pub before_page_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUpdateSettings {
    pub id: String,
    pub settings_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageCreate {
    pub workspace_id: String,
    pub parent_page_id: Option<String>,
    pub title: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageUpdate {
    pub id: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub cover: Option<String>,
    pub position: Option<f64>,
    pub favorite: Option<bool>,
    pub archived: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockCreate {
    pub page_id: String,
    pub parent_block_id: Option<String>,
    #[serde(rename = "type")]
    pub block_type: String,
    pub data_json: Option<String>,
    /// Insert after this sibling; appended at the end when absent.
    pub after_block_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockUpdate {
    pub id: String,
    #[serde(rename = "type")]
    pub block_type: Option<String>,
    pub data_json: Option<String>,
    pub position: Option<f64>,
}

// ---- validation ----

pub fn validate_id(id: &str, what: &str) -> AppResult<()> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| AppError::Validation(format!("invalid {what} id")))
}

pub fn validate_title(title: &str) -> AppResult<()> {
    if title.chars().count() > MAX_TITLE_LEN {
        return Err(AppError::Validation(format!(
            "title exceeds {MAX_TITLE_LEN} characters"
        )));
    }
    Ok(())
}

pub fn validate_name(name: &str) -> AppResult<()> {
    let n = name.trim().chars().count();
    if n == 0 || n > MAX_NAME_LEN {
        return Err(AppError::Validation(format!(
            "name must be 1-{MAX_NAME_LEN} characters"
        )));
    }
    Ok(())
}

pub mod image;

pub fn validate_json_object(json: &str, what: &str, max_bytes: usize) -> AppResult<()> {
    if json.len() > max_bytes {
        return Err(AppError::Validation(format!("{what} is too large")));
    }
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(value @ serde_json::Value::Object(_)) => {
            if what == "block data" {
                image::validate(&value)?;
            }
            Ok(())
        }
        _ => Err(AppError::Validation(format!(
            "{what} must be a JSON object"
        ))),
    }
}

pub fn validate_block_type(t: &str) -> AppResult<()> {
    if BLOCK_TYPES.contains(&t) {
        Ok(())
    } else {
        Err(AppError::Validation(format!("unknown block type '{t}'")))
    }
}

pub fn validate_position(p: f64) -> AppResult<()> {
    if p.is_finite() {
        Ok(())
    } else {
        Err(AppError::Validation(
            "position must be a finite number".into(),
        ))
    }
}

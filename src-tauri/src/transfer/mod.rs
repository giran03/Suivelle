//! Import and export: Markdown, HTML, CSV and the portable workspace archive.

pub mod archive;
pub mod blocks;
pub mod csvio;
pub mod export;
pub mod html;
pub mod import;
pub mod markdown;
pub mod notion;
pub mod pdf;
pub mod unzip;

#[cfg(test)]
mod tests;

use crate::domain::{new_id, now, Page};
use crate::errors::AppResult;
use crate::repositories as repo;
use crate::search;
use rusqlite::Connection;

/// Creates a page inside a transaction (for importers, which build many at once).
#[allow(clippy::too_many_arguments)]
pub(crate) fn insert_page(
    tx: &Connection,
    id: Option<String>,
    workspace_id: &str,
    parent: Option<&str>,
    title: &str,
    icon: Option<&str>,
    kind: &str,
    favorite: bool,
) -> AppResult<Page> {
    let stamp = now();
    let page = Page {
        id: id.unwrap_or_else(new_id),
        workspace_id: workspace_id.into(),
        parent_page_id: parent.map(String::from),
        title: title.chars().take(crate::domain::MAX_TITLE_LEN).collect(),
        icon: icon.map(String::from),
        cover: None,
        position: repo::page::next_position(tx, workspace_id, parent)?,
        favorite,
        archived: false,
        deleted_at: None,
        revision: 1,
        created_at: stamp.clone(),
        updated_at: stamp,
        child_count: 0,
        kind: kind.into(),
    };
    repo::page::insert(tx, &page)?;
    search::index::upsert_page(tx, &page)?;
    Ok(page)
}

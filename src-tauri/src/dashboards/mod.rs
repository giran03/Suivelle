//! Dashboards: a page (kind "dashboard") that is a grid of widgets.
//!
//! The layout is one JSON document, validated on every save. Widgets never copy data: a chart
//! asks the database engine, a linked view shows a saved view of any database, and the shared
//! filters narrow every widget whose database has a property of the same name.

#[cfg(test)]
mod tests;

use crate::databases::{ChartSpec, FilterNode, CHART_TYPES};
use crate::domain::{new_id, now, validate_id, validate_title, Page};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use crate::search;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub const GRID_COLUMNS: i64 = 12;
pub const MAX_WIDGETS: usize = 40;
pub const MAX_FILTERS: usize = 8;
pub const MAX_ROWS: i64 = 400;
const WIDGET_KINDS: &[&str] = &["text", "chart", "linked_view"];
const FILTER_KINDS: &[&str] = &["option", "text", "checkbox", "date_days"];

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Widget {
    pub id: String,
    /// "text", "chart" (including a KPI) or "linked_view".
    #[serde(rename = "type")]
    pub kind: String,
    /// Position and size in grid cells: twelve columns, rows of fixed height.
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub database_id: Option<String>,
    #[serde(default)]
    pub view_id: Option<String>,
    #[serde(default)]
    pub chart: Option<ChartSpec>,
    /// A filter this widget always applies (before the dashboard's shared filters).
    #[serde(default)]
    pub filter: Option<FilterNode>,
}

/// A filter shared by the whole dashboard, matched to each database by property name.
/// `option` compares option names, `text` is "contains", `checkbox` is checked or not and
/// `date_days` is "within the last N days" (negative N looks ahead).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFilter {
    pub id: String,
    pub property_name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    #[serde(default)]
    pub widgets: Vec<Widget>,
    #[serde(default)]
    pub filters: Vec<SharedFilter>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardDetail {
    pub page: Page,
    pub layout: Layout,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardCreate {
    pub workspace_id: String,
    pub parent_page_id: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSave {
    pub page_id: String,
    pub layout: Layout,
}

fn short_id(id: &str, what: &str) -> AppResult<()> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return bad(format!("invalid {what} id"));
    }
    Ok(())
}

fn trimmed(v: Option<String>, max: usize, what: &str) -> AppResult<Option<String>> {
    let Some(v) = v else {
        return Ok(None);
    };
    if v.chars().count() > max {
        return bad(format!("{what} can be at most {max} characters"));
    }
    Ok((!v.trim().is_empty()).then_some(v))
}

/// Checks a layout and returns it in canonical form.
pub fn normalize(layout: Layout) -> AppResult<Layout> {
    if layout.widgets.len() > MAX_WIDGETS {
        return bad(format!(
            "a dashboard can have at most {MAX_WIDGETS} widgets"
        ));
    }
    if layout.filters.len() > MAX_FILTERS {
        return bad(format!(
            "a dashboard can have at most {MAX_FILTERS} filters"
        ));
    }
    let mut seen = HashSet::new();
    let mut widgets = Vec::new();
    for w in layout.widgets {
        short_id(&w.id, "widget")?;
        if !seen.insert(w.id.clone()) {
            return bad("two widgets have the same id");
        }
        if !WIDGET_KINDS.contains(&w.kind.as_str()) {
            return bad(format!("unknown widget type '{}'", w.kind));
        }
        if !(2..=GRID_COLUMNS).contains(&w.w)
            || !(1..=40).contains(&w.h)
            || w.x < 0
            || w.x + w.w > GRID_COLUMNS
            || !(0..=MAX_ROWS).contains(&w.y)
        {
            return bad("a widget does not fit on the dashboard grid");
        }
        if let Some(d) = &w.database_id {
            validate_id(d, "database")?;
        }
        if let Some(v) = &w.view_id {
            validate_id(v, "view")?;
        }
        match w.kind.as_str() {
            "chart" => {
                if w.database_id.is_none() {
                    return bad("a chart widget needs a database");
                }
                if let Some(c) = &w.chart {
                    if !c.chart_type.is_empty() && !CHART_TYPES.contains(&c.chart_type.as_str()) {
                        return bad("unknown chart type");
                    }
                }
            }
            "linked_view" if w.database_id.is_none() || w.view_id.is_none() => {
                return bad("a linked view needs a database and a view");
            }
            _ => {}
        }
        widgets.push(Widget {
            title: trimmed(w.title, 80, "a widget title")?,
            text: trimmed(w.text, 5_000, "text")?,
            // Only what the widget type uses is kept.
            database_id: (w.kind != "text").then_some(w.database_id).flatten(),
            view_id: (w.kind == "linked_view").then_some(w.view_id).flatten(),
            chart: (w.kind == "chart").then_some(w.chart).flatten(),
            filter: (w.kind == "chart").then_some(w.filter).flatten(),
            ..w
        });
    }
    let mut filter_ids = HashSet::new();
    let mut filters = Vec::new();
    for f in layout.filters {
        short_id(&f.id, "filter")?;
        if !filter_ids.insert(f.id.clone()) || !FILTER_KINDS.contains(&f.kind.as_str()) {
            return bad("invalid dashboard filter");
        }
        let name = f.property_name.trim().to_string();
        if name.is_empty() || name.chars().count() > 60 {
            return bad("filter property names must be 1-60 characters");
        }
        let ok = match f.kind.as_str() {
            "option" | "text" => f.value.as_str().is_some_and(|s| s.chars().count() <= 200),
            "checkbox" => f.value.is_boolean(),
            _ => f.value.as_i64().is_some_and(|n| n.abs() <= 36_500),
        };
        if !ok {
            return bad("a dashboard filter has an invalid value");
        }
        filters.push(SharedFilter {
            property_name: name,
            ..f
        });
    }
    Ok(Layout { widgets, filters })
}

fn parse(json: &str) -> Layout {
    serde_json::from_str(json).unwrap_or_default()
}

fn load_dashboard_page(conn: &Connection, page_id: &str) -> AppResult<Page> {
    validate_id(page_id, "page")?;
    repo::page::get(conn, page_id)?
        .filter(|p| p.deleted_at.is_none() && p.kind == "dashboard")
        .ok_or_else(|| AppError::NotFound("dashboard".into()))
}

pub fn get(conn: &Connection, page_id: &str) -> AppResult<DashboardDetail> {
    let page = load_dashboard_page(conn, page_id)?;
    let json: Option<String> = conn
        .query_row(
            "SELECT layout_json FROM dashboard WHERE page_id = ?1",
            [page_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(DashboardDetail {
        page,
        layout: json.as_deref().map(parse).unwrap_or_default(),
    })
}

pub fn create(conn: &mut Connection, input: DashboardCreate) -> AppResult<DashboardDetail> {
    validate_id(&input.workspace_id, "workspace")?;
    if let Some(p) = &input.parent_page_id {
        validate_id(p, "parent page")?;
    }
    let title = input.title.unwrap_or_default();
    validate_title(&title)?;
    let title = if title.trim().is_empty() {
        "Untitled dashboard".to_string()
    } else {
        title
    };
    let tx = conn.transaction()?;
    if repo::workspace::get(&tx, &input.workspace_id)?.is_none() {
        return Err(AppError::NotFound("workspace".into()));
    }
    if let Some(pid) = &input.parent_page_id {
        match repo::page::get(&tx, pid)? {
            Some(p)
                if p.workspace_id == input.workspace_id
                    && p.deleted_at.is_none()
                    && p.kind == "page" => {}
            _ => return Err(AppError::NotFound("parent page".into())),
        }
    }
    let stamp = now();
    let page = Page {
        id: new_id(),
        workspace_id: input.workspace_id.clone(),
        parent_page_id: input.parent_page_id.clone(),
        title,
        icon: None,
        cover: None,
        position: repo::page::next_position(
            &tx,
            &input.workspace_id,
            input.parent_page_id.as_deref(),
        )?,
        favorite: false,
        archived: false,
        deleted_at: None,
        revision: 1,
        created_at: stamp.clone(),
        updated_at: stamp.clone(),
        child_count: 0,
        kind: "dashboard".into(),
    };
    repo::page::insert(&tx, &page)?;
    search::index::upsert_page(&tx, &page)?;
    tx.execute(
        "INSERT INTO dashboard (page_id, workspace_id, layout_json, created_at, updated_at) VALUES (?1, ?2, '{}', ?3, ?3)",
        params![page.id, page.workspace_id, stamp],
    )?;
    let out = get(&tx, &page.id)?;
    tx.commit()?;
    Ok(out)
}

/// Replaces the layout. The whole document is validated, so a bad save changes nothing.
pub fn save(conn: &mut Connection, input: DashboardSave) -> AppResult<Layout> {
    let layout = normalize(input.layout)?;
    let tx = conn.transaction()?;
    let page = load_dashboard_page(&tx, &input.page_id)?;
    let json = serde_json::to_string(&layout).map_err(|e| AppError::Internal(e.to_string()))?;
    tx.execute(
        "INSERT INTO dashboard (page_id, workspace_id, layout_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(page_id) DO UPDATE SET layout_json = excluded.layout_json, revision = revision + 1, updated_at = excluded.updated_at",
        params![page.id, page.workspace_id, json, now()],
    )?;
    tx.commit()?;
    Ok(layout)
}

//! Databases: typed properties, records (pages), per-record values and a saved table view.
//!
//! The frontend never sends SQL or filter text. It sends a structured view configuration; this
//! module validates it and compiles it to parameterized SQL (`query`).

pub mod calc;
pub mod charts;
pub mod forms;
pub mod formula;
pub mod previews;
pub mod query;
pub mod record_templates;
pub mod relations;
pub mod service;
pub mod templates;
pub mod values;

#[cfg(test)]
mod tests;

use crate::domain::Page;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const PROPERTY_TYPES: &[&str] = &[
    "title",
    "text",
    "number",
    "select",
    "multi_select",
    "status",
    "date",
    "checkbox",
    "url",
    "email",
    "phone",
    "created_time",
    "updated_time",
    "unique_id",
    "relation",
    "rollup",
    "formula",
    "button",
];

pub const MAX_FORMULA_LEN: usize = 2_000;

pub const MAX_RELATION_LINKS: usize = 200;
pub const ROLLUP_FUNCTIONS: &[&str] = &[
    "count",
    "count_unique",
    "sum",
    "average",
    "min",
    "max",
    "earliest",
    "latest",
    "percent_checked",
    "percent_done",
];

pub const VIEW_TYPES: &[&str] = &[
    "table", "board", "list", "gallery", "calendar", "timeline", "chart", "form", "feed",
];
pub const CHART_TYPES: &[&str] = &["bar", "line", "area", "pie", "donut", "kpi"];
pub const AGGREGATIONS: &[&str] = &["count", "sum", "average", "min", "max"];
pub const MAX_CHART_ROWS: usize = 2_000;
pub const MAX_FORM_TEXT: usize = 2_000;
pub const MAX_RECORD_TEMPLATES: usize = 30;
pub const MAX_VIEWS: usize = 20;
pub const MAX_PROPERTIES: usize = 50;
pub const MAX_OPTIONS: usize = 50;
pub const MAX_SORTS: usize = 5;
pub const MAX_FILTER_NODES: usize = 100;
pub const MAX_FILTER_DEPTH: usize = 4;
pub const DEFAULT_PAGE_SIZE: i64 = 100;
pub const MAX_PAGE_SIZE: i64 = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Database {
    pub id: String,
    pub page_id: String,
    pub workspace_id: String,
    pub next_unique_id: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Property {
    pub id: String,
    pub database_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub property_type: String,
    pub config: Value,
    pub position: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewColumn {
    pub property_id: String,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSort {
    pub property_id: String,
    /// "asc" or "desc".
    pub direction: String,
}

/// A filter is a tree: groups combine children with AND/OR, leaves compare one property.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterNode {
    Group {
        op: String,
        children: Vec<FilterNode>,
    },
    Leaf {
        #[serde(rename = "propertyId")]
        property_id: String,
        operator: String,
        #[serde(default)]
        value: Value,
    },
}

/// Groups records by one property. Date properties are bucketed (day, week, month or year).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSpec {
    pub property_id: String,
    #[serde(default)]
    pub bucket: Option<String>,
}

/// One saved view. The fields a view type does not use are simply left at their defaults:
/// `columns` double as "properties shown on cards and rows" for board, list and gallery.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewConfig {
    #[serde(default)]
    pub columns: Vec<ViewColumn>,
    #[serde(default)]
    pub sorts: Vec<ViewSort>,
    #[serde(default)]
    pub filter: Option<FilterNode>,
    #[serde(default)]
    pub group: Option<GroupSpec>,
    #[serde(default)]
    pub subgroup: Option<GroupSpec>,
    #[serde(default)]
    pub hide_empty_groups: bool,
    /// Calendar and timeline: which date property places a record.
    #[serde(default)]
    pub date_property_id: Option<String>,
    /// Gallery: "small", "medium" or "large".
    #[serde(default)]
    pub card_size: Option<String>,
    /// Timeline: "week", "month" or "quarter".
    #[serde(default)]
    pub zoom: Option<String>,
    /// Chart views: what to draw.
    #[serde(default)]
    pub chart: Option<ChartSpec>,
    /// Form views: which fields to ask for.
    #[serde(default)]
    pub form: Option<FormSpec>,
    /// Feed views: order by "created" or "updated" (newest first).
    #[serde(default)]
    pub feed_order: Option<String>,
}

/// What a chart draws. The database engine aggregates; nothing is copied.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChartSpec {
    /// "bar", "line", "area", "pie", "donut" or "kpi".
    #[serde(default)]
    pub chart_type: String,
    /// The category (or time) axis. A select, status, checkbox or date property.
    #[serde(default)]
    pub x_property_id: Option<String>,
    /// Date axis only: "day", "week", "month" or "year".
    #[serde(default)]
    pub bucket: Option<String>,
    /// The value being summed, averaged and so on: a number property.
    #[serde(default)]
    pub y_property_id: Option<String>,
    /// "count", "sum", "average", "min" or "max".
    #[serde(default)]
    pub aggregation: String,
    /// Splits each category into series. A select, status or checkbox property.
    #[serde(default)]
    pub group_property_id: Option<String>,
    /// "x" (axis order), "value_desc" or "value_asc".
    #[serde(default)]
    pub sort: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    pub property_id: String,
    /// Shown instead of the property's name.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub help: Option<String>,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FormSpec {
    #[serde(default)]
    pub fields: Vec<FormField>,
    #[serde(default)]
    pub intro: Option<String>,
    #[serde(default)]
    pub submit_label: Option<String>,
    #[serde(default)]
    pub success_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbView {
    pub id: String,
    pub database_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub view_type: String,
    pub config: ViewConfig,
}

/// Records per group. Subgroups are present only when the view has a subgroup.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupCount {
    pub key: String,
    pub count: i64,
    pub subgroups: Vec<GroupCount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDetail {
    pub database: Database,
    pub page: Page,
    pub properties: Vec<Property>,
    pub views: Vec<DbView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRow {
    pub id: String,
    pub page_id: String,
    pub database_id: String,
    pub title: String,
    pub unique_id: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Stored values by property id; empty cells are absent.
    pub values: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPage {
    pub rows: Vec<RecordRow>,
    /// Records matching the filter (not just this page). Absent when the caller asked to skip
    /// counting, which halves the cost of fetching later pages of a large table.
    pub total: Option<i64>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordDetail {
    pub record: RecordRow,
    pub database: DatabaseDetail,
}

// ---- inputs ----

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCreate {
    pub workspace_id: String,
    pub parent_page_id: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyCreate {
    pub database_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub property_type: String,
    #[serde(default)]
    pub config: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyUpdate {
    pub id: String,
    pub name: Option<String>,
    pub config: Option<Value>,
    pub position: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordCreate {
    pub database_id: String,
    pub title: Option<String>,
    #[serde(default)]
    pub values: Map<String, Value>,
    /// Start from a record template: its values and body, with `title` and `values` on top.
    #[serde(default)]
    pub template_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetValue {
    pub record_id: String,
    pub property_id: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewUpdate {
    pub view_id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub config: ViewConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewCreate {
    pub database_id: String,
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub view_type: String,
    #[serde(default)]
    pub config: Option<ViewConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupCountsQuery {
    pub database_id: String,
    pub view_id: Option<String>,
    #[serde(default)]
    pub extra_filter: Option<FilterNode>,
}

/// A chart to compute. With `view_id` the view's filter applies; `chart` overrides what the view
/// draws (a dashboard widget has no view of its own).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartQuery {
    pub database_id: String,
    #[serde(default)]
    pub view_id: Option<String>,
    #[serde(default)]
    pub chart: Option<ChartSpec>,
    #[serde(default)]
    pub filter: Option<FilterNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartPoint {
    /// The category key (a date bucket, option id, "true"/"false"); absent for no value.
    pub x: Option<String>,
    /// The series key.
    pub group: Option<String>,
    pub value: Option<f64>,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartData {
    pub points: Vec<ChartPoint>,
    /// More categories exist than were returned.
    pub truncated: bool,
    /// Records the chart was drawn from.
    pub records: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormSubmit {
    pub view_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub values: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaPreviewInput {
    pub database_id: String,
    /// The property being edited, if any; it is left out of what the formula can refer to.
    #[serde(default)]
    pub property_id: Option<String>,
    pub expression: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaSample {
    pub title: String,
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaPreview {
    pub result_type: Option<String>,
    pub error: Option<formula::FormulaError>,
    pub samples: Vec<FormulaSample>,
    pub properties: Vec<String>,
}

/// A database as offered when choosing what a relation points to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRef {
    pub id: String,
    pub page_id: String,
    pub title: String,
}

/// A record offered by the relation picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRef {
    pub id: String,
    pub page_id: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordLookup {
    pub database_id: String,
    #[serde(default)]
    pub query: String,
    pub limit: Option<i64>,
}

/// Records whose date property overlaps `from..=to` (days, YYYY-MM-DD). With neither bound the
/// query returns the records that have no date.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRange {
    pub property_id: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

/// What a gallery card shows for a record: its first image, else the start of its text.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPreview {
    pub record_id: String,
    pub image_hash: Option<String>,
    pub image_name: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordQuery {
    pub database_id: String,
    /// Which saved view to apply; the first view when absent.
    #[serde(default)]
    pub view_id: Option<String>,
    /// Restrict to one group (and one subgroup) of the view's grouping.
    #[serde(default)]
    pub group_key: Option<String>,
    #[serde(default)]
    pub subgroup_key: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
    #[serde(default)]
    pub skip_total: bool,
    /// Narrows the view further (dashboard filters). Combined with the view's own filter by AND.
    #[serde(default)]
    pub extra_filter: Option<FilterNode>,
    /// Restrict to records dated within a window (calendar and timeline). The total is not counted.
    #[serde(default)]
    pub range: Option<RecordRange>,
}

//! Pivot tables: a view type that cross-tabulates the filtered records, rows by columns, with
//! totals. It reuses the chart query (x = row, series = column); nothing is stored beside the
//! view's `PivotSpec`.

use super::charts::chart_calc;
use super::query;
use super::service::{load_database, load_properties, load_view_by_id};
use super::*;
use crate::errors::{AppError, AppResult};
use rusqlite::{params_from_iter, Connection};

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

fn yes() -> bool {
    true
}

/// What a pivot view shows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PivotSpec {
    /// One row per value of this property (select, status, checkbox or date).
    #[serde(default)]
    pub row_property_id: Option<String>,
    /// One column per value of this property; absent: a single column.
    #[serde(default)]
    pub column_property_id: Option<String>,
    /// The number being calculated; absent when counting records.
    #[serde(default)]
    pub value_property_id: Option<String>,
    /// "count", "sum", "average", "min" or "max".
    #[serde(default)]
    pub aggregation: String,
    /// Date rows only: "day", "week", "month" or "year".
    #[serde(default)]
    pub row_bucket: Option<String>,
    #[serde(default)]
    pub column_bucket: Option<String>,
    #[serde(default = "yes")]
    pub show_totals: bool,
}

impl Default for PivotSpec {
    fn default() -> Self {
        Self {
            row_property_id: None,
            column_property_id: None,
            value_property_id: None,
            aggregation: "count".into(),
            row_bucket: None,
            column_bucket: None,
            show_totals: true,
        }
    }
}

/// A pivot to compute. With `view_id` the view's filter applies; `pivot` overrides its spec.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotQuery {
    pub database_id: String,
    #[serde(default)]
    pub view_id: Option<String>,
    #[serde(default)]
    pub pivot: Option<PivotSpec>,
    #[serde(default)]
    pub filter: Option<FilterNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotData {
    /// One per row and column that has records: `x` is the row key, `group` the column key.
    pub cells: Vec<ChartPoint>,
    /// Per row, over all columns (`x` is the row key).
    pub row_totals: Vec<ChartPoint>,
    /// Per column, over all rows (`x` is the column key).
    pub column_totals: Vec<ChartPoint>,
    /// Over every record.
    pub grand: ChartPoint,
    /// More rows or columns exist than were returned.
    pub truncated: bool,
    pub records: i64,
}

/// A pivot for a database that has none yet: records per status (or select), split by another.
pub fn default_spec(props: &[Property]) -> PivotSpec {
    let pick = |skip: Option<&str>| {
        ["status", "select", "checkbox", "date"]
            .iter()
            .find_map(|t| {
                props
                    .iter()
                    .find(|p| p.property_type == *t && Some(p.id.as_str()) != skip)
            })
    };
    let row = pick(None);
    let col = pick(row.map(|p| p.id.as_str()));
    let bucket = |p: Option<&Property>| {
        p.filter(|p| query::is_date_like(&p.property_type))
            .map(|_| "month".to_string())
    };
    PivotSpec {
        row_property_id: row.map(|p| p.id.clone()),
        column_property_id: col.map(|p| p.id.clone()),
        row_bucket: bucket(row),
        column_bucket: bucket(col),
        ..Default::default()
    }
}

/// Validates a pivot against the database's properties. References to properties that no longer
/// exist are cleared, so a pivot keeps working when a property is deleted.
pub fn normalize(spec: PivotSpec, props: &[Property]) -> AppResult<PivotSpec> {
    let aggregation = if spec.aggregation.is_empty() {
        "count".to_string()
    } else {
        spec.aggregation
    };
    if !AGGREGATIONS.contains(&aggregation.as_str()) {
        return bad(format!("unknown aggregation '{aggregation}'"));
    }
    let find = |id: &Option<String>| id.as_deref().and_then(|i| props.iter().find(|p| p.id == i));
    let axis = |id: &Option<String>, bucket: &Option<String>, what: &str| {
        let Some(p) = find(id) else {
            return Ok((None, None));
        };
        if !query::can_group(&p.property_type) {
            return bad(format!(
                "a pivot {what} cannot be a {} property",
                p.property_type
            ));
        }
        let bucket = if query::is_date_like(&p.property_type) {
            match bucket.as_deref() {
                None => Some("month".to_string()),
                Some(v @ ("day" | "week" | "month" | "year")) => Some(v.to_string()),
                Some(_) => return bad("a date axis must be day, week, month or year"),
            }
        } else {
            None
        };
        Ok((Some(p.id.clone()), bucket))
    };
    let (row, row_bucket) = axis(&spec.row_property_id, &spec.row_bucket, "row")?;
    let (col, column_bucket) = axis(&spec.column_property_id, &spec.column_bucket, "column")?;
    let col = col.filter(|c| Some(c) != row.as_ref());
    let column_bucket = if col.is_some() { column_bucket } else { None };
    let value = if aggregation == "count" {
        None
    } else {
        find(&spec.value_property_id).map(|p| p.id.clone())
    };
    if let Some(p) = find(&value) {
        if !query::is_numeric(p) {
            return bad("only number properties can be summed or averaged");
        }
    }
    Ok(PivotSpec {
        row_property_id: row,
        column_property_id: col,
        value_property_id: value,
        aggregation,
        row_bucket,
        column_bucket,
        show_totals: spec.show_totals,
    })
}

fn chart_of(
    spec: &PivotSpec,
    x: &Option<String>,
    bucket: &Option<String>,
    group: &Option<String>,
    kpi: bool,
) -> ChartSpec {
    ChartSpec {
        chart_type: if kpi { "kpi" } else { "bar" }.into(),
        x_property_id: x.clone(),
        bucket: bucket.clone(),
        y_property_id: spec.value_property_id.clone(),
        aggregation: spec.aggregation.clone(),
        group_property_id: group.clone(),
        sort: "x".into(),
    }
}

fn run(
    conn: &Connection,
    db_id: &str,
    props: &[Property],
    cfg: &ViewConfig,
    chart: &ChartSpec,
    group_bucket: Option<String>,
) -> AppResult<Vec<ChartPoint>> {
    let (sql, params) = query::build_chart_grouped(
        db_id,
        props,
        cfg,
        chart,
        group_bucket,
        chrono::Local::now().date_naive(),
    )?;
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |r| {
            Ok(ChartPoint {
                x: r.get(0)?,
                group: r.get(1)?,
                value: r.get(2)?,
                count: r.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Computes a pivot: the cell matrix, both sets of totals and the grand total.
pub fn data(conn: &Connection, input: &PivotQuery) -> AppResult<PivotData> {
    crate::domain::validate_id(&input.database_id, "database")?;
    let db = load_database(conn, &input.database_id)?;
    let props = load_properties(conn, &db.id)?;
    let mut cfg = ViewConfig::default();
    let mut spec = input.pivot.clone();
    if let Some(vid) = &input.view_id {
        crate::domain::validate_id(vid, "view")?;
        let view = load_view_by_id(conn, vid)?;
        if view.database_id != db.id {
            return bad("that view belongs to another database");
        }
        if spec.is_none() {
            spec = view.config.pivot.clone();
        }
        cfg = view.config;
    }
    cfg.filter = super::service::and_filters(cfg.filter.take(), input.filter.clone());
    cfg.sorts.clear();
    let spec = normalize(spec.unwrap_or_else(|| default_spec(&props)), &props)?;
    if spec.row_property_id.is_none() {
        return bad("choose what the rows are");
    }
    if spec.aggregation != "count" && spec.value_property_id.is_none() {
        return bad("choose a number property to calculate");
    }
    let (r, rb, c, cb) = (
        &spec.row_property_id,
        &spec.row_bucket,
        &spec.column_property_id,
        &spec.column_bucket,
    );
    // Calculated properties used by the filter or the value must be up to date first.
    let probe = chart_of(&spec, r, rb, c, false);
    super::calc::prepare(conn, &db.id, &chart_calc(&props, &cfg, &probe))?;

    let mut cells = run(conn, &db.id, &props, &cfg, &probe, cb.clone())?;
    let mut row_totals = run(
        conn,
        &db.id,
        &props,
        &cfg,
        &chart_of(&spec, r, rb, &None, false),
        None,
    )?;
    let mut column_totals = if c.is_some() {
        run(
            conn,
            &db.id,
            &props,
            &cfg,
            &chart_of(&spec, c, cb, &None, false),
            None,
        )?
    } else {
        Vec::new()
    };
    let grand = run(
        conn,
        &db.id,
        &props,
        &cfg,
        &chart_of(&spec, &None, &None, &None, true),
        None,
    )?
    .into_iter()
    .next()
    .unwrap_or(ChartPoint {
        x: None,
        group: None,
        value: None,
        count: 0,
    });
    let truncated = cells.len() > MAX_CHART_ROWS
        || row_totals.len() > MAX_CHART_ROWS
        || column_totals.len() > MAX_CHART_ROWS;
    cells.truncate(MAX_CHART_ROWS);
    row_totals.truncate(MAX_CHART_ROWS);
    column_totals.truncate(MAX_CHART_ROWS);
    Ok(PivotData {
        records: grand.count,
        cells,
        row_totals,
        column_totals,
        grand,
        truncated,
    })
}

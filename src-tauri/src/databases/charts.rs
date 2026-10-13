//! Charts: a view type whose records are aggregated by the database engine on every draw.
//! Nothing is stored beside the view's `ChartSpec`; a chart is always as current as the data.

use super::query;
use super::service::{load_database, load_properties, load_view_by_id};
use super::*;
use crate::errors::{AppError, AppResult};
use rusqlite::{params_from_iter, Connection};

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

/// Date properties are drawn per bucket; everything else chooses its own keys.
fn x_ok(p: &Property) -> bool {
    query::can_group(&p.property_type)
}

fn series_ok(p: &Property) -> bool {
    matches!(p.property_type.as_str(), "select" | "status" | "checkbox")
}

/// The default chart for a database: records per status (or select, or date, or checkbox).
pub fn default_spec(props: &[Property]) -> ChartSpec {
    let x = props
        .iter()
        .find(|p| p.property_type == "status")
        .or_else(|| props.iter().find(|p| p.property_type == "select"))
        .or_else(|| props.iter().find(|p| p.property_type == "date"))
        .or_else(|| props.iter().find(|p| p.property_type == "checkbox"))
        .or_else(|| props.iter().find(|p| p.property_type == "created_time"));
    ChartSpec {
        chart_type: "bar".into(),
        x_property_id: x.map(|p| p.id.clone()),
        bucket: None,
        y_property_id: None,
        aggregation: "count".into(),
        group_property_id: None,
        sort: "x".into(),
    }
}

/// Validates a chart against the database's properties. References to properties that no longer
/// exist are cleared, so a chart keeps working when a property is deleted.
pub fn normalize(spec: ChartSpec, props: &[Property]) -> AppResult<ChartSpec> {
    let chart_type = if spec.chart_type.is_empty() {
        "bar".to_string()
    } else {
        spec.chart_type
    };
    if !CHART_TYPES.contains(&chart_type.as_str()) {
        return bad(format!("unknown chart type '{chart_type}'"));
    }
    let aggregation = if spec.aggregation.is_empty() {
        "count".to_string()
    } else {
        spec.aggregation
    };
    if !AGGREGATIONS.contains(&aggregation.as_str()) {
        return bad(format!("unknown aggregation '{aggregation}'"));
    }
    let sort = if spec.sort.is_empty() {
        "x".to_string()
    } else {
        spec.sort
    };
    if !matches!(sort.as_str(), "x" | "value_desc" | "value_asc") {
        return bad("chart sort must be x, value_desc or value_asc");
    }
    let find = |id: &Option<String>| id.as_deref().and_then(|i| props.iter().find(|p| p.id == i));
    let kpi = chart_type == "kpi";

    let x = if kpi { None } else { find(&spec.x_property_id) };
    if let Some(p) = x {
        if !x_ok(p) {
            return bad(format!(
                "a chart cannot be drawn across a {} property",
                p.property_type
            ));
        }
    }
    let bucket = match x {
        Some(p) if query::is_date_like(&p.property_type) => match spec.bucket.as_deref() {
            None => Some("month".to_string()),
            Some(v @ ("day" | "week" | "month" | "year")) => Some(v.to_string()),
            Some(_) => return bad("date axis must be day, week, month or year"),
        },
        _ => None,
    };
    let series = if kpi || matches!(chart_type.as_str(), "pie" | "donut") {
        None
    } else {
        find(&spec.group_property_id)
    };
    if let Some(p) = series {
        if !series_ok(p) {
            return bad("series can be split by a select, status or checkbox property");
        }
    }
    let series = series.filter(|p| Some(&p.id) != x.map(|x| &x.id));
    let y = if aggregation == "count" {
        None
    } else {
        find(&spec.y_property_id)
    };
    if let Some(p) = y {
        if !query::is_numeric(p) {
            return bad("only number properties can be summed or averaged");
        }
    }
    Ok(ChartSpec {
        chart_type,
        x_property_id: x.map(|p| p.id.clone()),
        bucket,
        y_property_id: y.map(|p| p.id.clone()),
        aggregation,
        group_property_id: series.map(|p| p.id.clone()),
        sort,
    })
}

/// Computes a chart. The filter of the view (if any), then the caller's extra filter, narrow it.
pub fn data(conn: &Connection, input: &ChartQuery) -> AppResult<ChartData> {
    crate::domain::validate_id(&input.database_id, "database")?;
    let db = load_database(conn, &input.database_id)?;
    let props = load_properties(conn, &db.id)?;
    let mut cfg = ViewConfig::default();
    let mut spec = input.chart.clone();
    if let Some(vid) = &input.view_id {
        crate::domain::validate_id(vid, "view")?;
        let view = load_view_by_id(conn, vid)?;
        if view.database_id != db.id {
            return bad("that view belongs to another database");
        }
        if spec.is_none() {
            spec = view.config.chart.clone();
        }
        cfg = view.config;
    }
    cfg.filter = super::service::and_filters(cfg.filter.take(), input.filter.clone());
    let spec = normalize(spec.unwrap_or_else(|| default_spec(&props)), &props)?;
    if spec.chart_type != "kpi" && spec.x_property_id.is_none() {
        return bad("choose what to chart across");
    }
    cfg.sorts.clear();
    super::calc::prepare(conn, &db.id, &chart_calc(&props, &cfg, &spec))?;
    let (sql, params) = query::build_chart(
        &db.id,
        &props,
        &cfg,
        &spec,
        chrono::Local::now().date_naive(),
    )?;
    let mut stmt = conn.prepare(&sql)?;
    let mut points: Vec<ChartPoint> = stmt
        .query_map(params_from_iter(params.iter()), |r| {
            Ok(ChartPoint {
                x: r.get(0)?,
                group: r.get(1)?,
                value: r.get(2)?,
                count: r.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let truncated = points.len() > MAX_CHART_ROWS;
    points.truncate(MAX_CHART_ROWS);
    let records = points.iter().map(|p| p.count).sum();
    Ok(ChartData {
        points,
        truncated,
        records,
    })
}

/// The calculated properties the chart's filter or value depend on.
fn chart_calc<'a>(props: &'a [Property], cfg: &ViewConfig, spec: &ChartSpec) -> Vec<&'a Property> {
    let mut used = super::calc::used_by(props, cfg);
    if let Some(id) = &spec.y_property_id {
        if let Some(p) = props
            .iter()
            .find(|p| &p.id == id && super::calc::is_calculated(&p.property_type))
        {
            if !used.iter().any(|u| u.id == p.id) {
                used.push(p);
            }
        }
    }
    used
}

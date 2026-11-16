//! Totals row: per-column summaries over the whole filtered set, computed by the database engine
//! so they stay correct however many pages of records the grid has loaded.

use super::query;
use super::service::{and_filters, load_database, load_properties, pick_view};
use super::*;
use crate::errors::AppResult;
use rusqlite::{params_from_iter, types::Value as Sql, Connection};
use std::collections::HashMap;

fn json_of(v: Sql) -> Value {
    match v {
        Sql::Integer(n) => Value::from(n),
        Sql::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        Sql::Text(s) => Value::String(s),
        _ => Value::Null,
    }
}

/// The view's visible columns that have a summary chosen, as (property id, summary).
fn specs_of(cfg: &ViewConfig) -> Vec<(String, String)> {
    cfg.columns
        .iter()
        .filter(|c| !c.hidden)
        .filter_map(|c| Some((c.property_id.clone(), c.aggregate.clone()?)))
        .collect()
}

fn value(spec: &(String, String), v: Value) -> AggregateValue {
    AggregateValue {
        property_id: spec.0.clone(),
        aggregate: spec.1.clone(),
        value: v,
    }
}

/// The calculated properties (formulas, rollups) the filter or a summary depends on.
fn calc_needed<'a>(
    props: &'a [Property],
    cfg: &ViewConfig,
    specs: &[(String, String)],
) -> Vec<&'a Property> {
    let mut used = super::calc::used_by(props, cfg);
    for (pid, _) in specs {
        if let Some(p) = props
            .iter()
            .find(|p| &p.id == pid && super::calc::is_calculated(&p.property_type))
        {
            if !used.iter().any(|u| u.id == p.id) {
                used.push(p);
            }
        }
    }
    used
}

type Row = (Option<String>, i64, Vec<AggregateValue>);

pub fn compute(conn: &Connection, input: &AggregatesQuery) -> AppResult<Aggregates> {
    crate::domain::validate_id(&input.database_id, "database")?;
    let db = load_database(conn, &input.database_id)?;
    let props = load_properties(conn, &db.id)?;
    let mut view = pick_view(conn, &db.id, input.view_id.as_deref())?;
    view.config.filter = and_filters(view.config.filter.take(), input.extra_filter.clone());
    let cfg = view.config;
    let specs = specs_of(&cfg);
    let today = chrono::Local::now().date_naive();
    super::calc::prepare(conn, &db.id, &calc_needed(&props, &cfg, &specs))?;

    let run = |by_group: bool| -> AppResult<Vec<Row>> {
        let (sql, params, kept) =
            query::build_aggregates(&db.id, &props, &cfg, &specs, by_group, today)?;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(params.iter()), |r| {
                let key: Option<String> = r.get(0)?;
                let count: i64 = r.get(1)?;
                let mut vals = Vec::with_capacity(kept.len());
                for (n, &i) in kept.iter().enumerate() {
                    vals.push(value(&specs[i], json_of(r.get::<_, Sql>(2 + n)?)));
                }
                Ok((key, count, vals))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    };

    let (count, mut values) = run(false)?
        .into_iter()
        .next()
        .map(|(_, c, v)| (c, v))
        .unwrap_or_default();
    for spec in specs.iter().filter(|s| s.1 == "median") {
        let Some(prop) = props.iter().find(|p| p.id == spec.0) else {
            continue;
        };
        if !query::aggregate_ok(prop, "median") {
            continue;
        }
        let (sql, params) = query::build_median(&db.id, &props, &cfg, &spec.0, today)?;
        let m: Sql = conn.query_row(&sql, params_from_iter(params.iter()), |r| r.get(0))?;
        values.push(value(spec, json_of(m)));
    }
    // Keep the view's column order.
    let order: HashMap<&str, usize> = specs
        .iter()
        .enumerate()
        .map(|(i, s)| (s.0.as_str(), i))
        .collect();
    values.sort_by_key(|v| order.get(v.property_id.as_str()).copied().unwrap_or(usize::MAX));

    let mut groups = Vec::new();
    if input.by_group && cfg.group.is_some() {
        for (key, count, values) in run(true)? {
            groups.push(GroupAggregates {
                key: key.unwrap_or_else(|| query::EMPTY_GROUP.to_string()),
                count,
                values,
            });
        }
    }
    Ok(Aggregates {
        count,
        values,
        groups,
    })
}

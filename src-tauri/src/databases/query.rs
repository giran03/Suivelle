//! Compiles a view's filter tree and sorts into parameterized SQL.
//!
//! Only property ids, operators and values from a validated `ViewConfig` ever reach SQL, and
//! every value is bound as a parameter. Column expressions are chosen from the property's type.

use super::values::is_text_like;
use super::{
    FilterNode, GroupSpec, Property, ViewConfig, MAX_FILTER_DEPTH, MAX_FILTER_NODES, MAX_SORTS,
};
use crate::errors::{AppError, AppResult};
use chrono::{Duration, NaiveDate};
use rusqlite::types::Value as Sql;
use serde_json::Value;
use std::collections::HashMap;

pub struct Built {
    /// How many leading entries of `params` the WHERE clause uses (the COUNT query binds only those).
    pub where_params: usize,
    pub where_sql: String,
    pub order_sql: String,
    /// Materialized sort keys avoid repeating correlated cell lookups for null ordering and CASE.
    pub sort_columns: Vec<String>,
    pub params: Vec<Sql>,
}

struct Ctx<'a> {
    props: HashMap<&'a str, &'a Property>,
    params: Vec<Sql>,
    nodes: usize,
    today: NaiveDate,
}

impl Ctx<'_> {
    fn push(&mut self, v: Sql) -> usize {
        self.params.push(v);
        self.params.len()
    }
}

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

#[derive(PartialEq)]
enum Class {
    Text,
    Number,
    Option,
    Multi,
    Date,
    Checkbox,
    Relation,
}

fn class_of(p: &Property) -> Class {
    match p.property_type.as_str() {
        "rollup" => match p.config.get("function").and_then(Value::as_str) {
            Some("earliest" | "latest") => Class::Date,
            _ => Class::Number,
        },
        "formula" => match p.config.get("resultType").and_then(Value::as_str) {
            Some("number") => Class::Number,
            Some("bool") => Class::Checkbox,
            Some("date") => Class::Date,
            _ => Class::Text,
        },
        t => class(t),
    }
}

fn class(t: &str) -> Class {
    match t {
        t if is_text_like(t) => Class::Text,
        "number" | "unique_id" => Class::Number,
        "select" | "status" => Class::Option,
        "multi_select" => Class::Multi,
        "date" | "created_time" | "updated_time" => Class::Date,
        "relation" => Class::Relation,
        _ => Class::Checkbox,
    }
}

/// The stored JSON for a custom property of the current record.
fn raw(ctx: &mut Ctx, prop: &Property) -> String {
    let n = ctx.push(Sql::Text(prop.id.clone()));
    format!("(SELECT value_json FROM db_value INDEXED BY idx_db_value_cover WHERE record_id = r.id AND property_id = ?{n})")
}

/// A SQL scalar for comparing/sorting the property (NULL when empty).
fn scalar(ctx: &mut Ctx, prop: &Property) -> String {
    match prop.property_type.as_str() {
        "title" => "p.title".into(),
        "created_time" => "r.created_at".into(),
        "updated_time" => "p.updated_at".into(),
        "unique_id" => "r.unique_id".into(),
        "date" => format!("json_extract({}, '$.start')", raw(ctx, prop)),
        "checkbox" => format!("COALESCE(json_extract({}, '$'), 0)", raw(ctx, prop)),
        "multi_select" => raw(ctx, prop),
        "formula" | "rollup" => {
            let n = ctx.push(Sql::Text(prop.id.clone()));
            let base =
                format!("(SELECT v FROM calc WHERE record_id = r.id AND property_id = ?{n})");
            if class_of(prop) == Class::Checkbox {
                format!("COALESCE({base}, 0)")
            } else {
                base
            }
        }
        _ => format!("json_extract({}, '$')", raw(ctx, prop)),
    }
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn text_of(v: &Value) -> AppResult<String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => bad("expected text"),
    }
}

fn number_of(v: &Value) -> AppResult<f64> {
    match v {
        Value::Number(n) => n
            .as_f64()
            .filter(|x| x.is_finite())
            .map_or_else(|| bad("expected a number"), Ok),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|x| x.is_finite())
            .map_or_else(|| bad("expected a number"), Ok),
        _ => bad("expected a number"),
    }
}

/// A calendar day as "YYYY-MM-DD": a literal date/time string, or `{"relativeDays": n}` from today.
fn day_of(ctx: &Ctx, v: &Value) -> AppResult<String> {
    if let Some(n) = v.get("relativeDays").and_then(Value::as_i64) {
        if n.abs() > 36_500 {
            return bad("relative date is out of range");
        }
        return Ok((ctx.today + Duration::days(n))
            .format("%Y-%m-%d")
            .to_string());
    }
    match v.as_str().map(|s| s.get(..10).unwrap_or(s)) {
        Some(d) if NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok() => Ok(d.to_string()),
        _ => bad("expected a date"),
    }
}

fn leaf(ctx: &mut Ctx, prop: &Property, op: &str, value: &Value) -> AppResult<String> {
    let cls = class_of(prop);
    let unsupported = || {
        bad(format!(
            "'{op}' cannot be used with a {} property",
            prop.property_type
        ))
    };
    match cls {
        Class::Relation => {
            let n = ctx.push(Sql::Text(prop.id.clone()));
            let links = format!(
                "SELECT 1 FROM db_relation rel JOIN db_record tr ON tr.id = rel.to_record_id JOIN page tp ON tp.id = tr.page_id                  WHERE rel.property_id = ?{n} AND rel.from_record_id = r.id AND tp.deleted_at IS NULL"
            );
            match op {
                "is_empty" => Ok(format!("NOT EXISTS ({links})")),
                "is_not_empty" => Ok(format!("EXISTS ({links})")),
                "contains" | "not_contains" => {
                    let id = ctx.push(Sql::Text(text_of(value)?));
                    let exists = format!("EXISTS ({links} AND rel.to_record_id = ?{id})");
                    Ok(if op == "contains" {
                        exists
                    } else {
                        format!("NOT {exists}")
                    })
                }
                _ => unsupported(),
            }
        }
        Class::Multi => {
            let raw1 = raw(ctx, prop);
            match op {
                "contains" | "not_contains" => {
                    let id = ctx.push(Sql::Text(text_of(value)?));
                    let exists =
                        format!("EXISTS (SELECT 1 FROM json_each({raw1}) WHERE value = ?{id})");
                    Ok(if op == "contains" {
                        exists
                    } else {
                        format!("NOT {exists}")
                    })
                }
                "is_empty" => Ok(format!("({raw1} IS NULL OR {raw1} = '[]')")),
                "is_not_empty" => Ok(format!("({raw1} IS NOT NULL AND {raw1} <> '[]')")),
                _ => unsupported(),
            }
        }
        _ => {
            let sx = scalar(ctx, prop);
            match (&cls, op) {
                (_, "is_empty") => Ok(if cls == Class::Text {
                    format!("({sx} IS NULL OR {sx} = '')")
                } else {
                    format!("{sx} IS NULL")
                }),
                (_, "is_not_empty") => Ok(if cls == Class::Text {
                    format!("({sx} IS NOT NULL AND {sx} <> '')")
                } else {
                    format!("{sx} IS NOT NULL")
                }),
                (Class::Text, "=") => {
                    let n = ctx.push(Sql::Text(text_of(value)?));
                    Ok(format!("{sx} = ?{n} COLLATE NOCASE"))
                }
                (Class::Text, "!=") => {
                    let n = ctx.push(Sql::Text(text_of(value)?));
                    Ok(format!("({sx} IS NULL OR {sx} <> ?{n} COLLATE NOCASE)"))
                }
                (Class::Text, "contains") => {
                    let n = ctx.push(Sql::Text(format!("%{}%", like_escape(&text_of(value)?))));
                    Ok(format!("{sx} LIKE ?{n} ESCAPE '\\'"))
                }
                (Class::Text, "not_contains") => {
                    let n = ctx.push(Sql::Text(format!("%{}%", like_escape(&text_of(value)?))));
                    Ok(format!("({sx} IS NULL OR {sx} NOT LIKE ?{n} ESCAPE '\\')"))
                }
                (Class::Number, "=" | ">" | ">=" | "<" | "<=") => {
                    let n = ctx.push(Sql::Real(number_of(value)?));
                    Ok(format!("{sx} {op} ?{n}"))
                }
                (Class::Number, "!=") => {
                    let n = ctx.push(Sql::Real(number_of(value)?));
                    Ok(format!("({sx} IS NULL OR {sx} <> ?{n})"))
                }
                (Class::Option, "=") => {
                    let n = ctx.push(Sql::Text(text_of(value)?));
                    Ok(format!("{sx} = ?{n}"))
                }
                (Class::Option, "!=") => {
                    let n = ctx.push(Sql::Text(text_of(value)?));
                    Ok(format!("({sx} IS NULL OR {sx} <> ?{n})"))
                }
                (Class::Date, "=" | "before" | "after") => {
                    let n = ctx.push(Sql::Text(day_of(ctx, value)?));
                    let cmp = match op {
                        "=" => "=",
                        "before" => "<",
                        _ => ">",
                    };
                    Ok(format!("substr({sx}, 1, 10) {cmp} ?{n}"))
                }
                (Class::Date, "between") => {
                    let Some([a, b]) = value
                        .as_array()
                        .map(|v| v.as_slice())
                        .and_then(|s| <&[Value; 2]>::try_from(s).ok())
                    else {
                        return bad("between needs two dates");
                    };
                    let (lo, hi) = (day_of(ctx, a)?, day_of(ctx, b)?);
                    let (n1, n2) = (ctx.push(Sql::Text(lo)), ctx.push(Sql::Text(hi)));
                    Ok(format!(
                        "(substr({sx}, 1, 10) >= ?{n1} AND substr({sx}, 1, 10) <= ?{n2})"
                    ))
                }
                (Class::Checkbox, "=") => {
                    let b = value
                        .as_bool()
                        .map_or_else(|| bad("expected true or false"), Ok)?;
                    let n = ctx.push(Sql::Integer(b as i64));
                    Ok(format!("{sx} = ?{n}"))
                }
                _ => unsupported(),
            }
        }
    }
}

fn node(ctx: &mut Ctx, f: &FilterNode, depth: usize) -> AppResult<Option<String>> {
    ctx.nodes += 1;
    if ctx.nodes > MAX_FILTER_NODES || depth > MAX_FILTER_DEPTH {
        return bad("the filter is too large or too deeply nested");
    }
    match f {
        FilterNode::Group { op, children } => {
            let joiner = match op.as_str() {
                "and" => " AND ",
                "or" => " OR ",
                _ => return bad("a filter group must be 'and' or 'or'"),
            };
            let mut parts = Vec::new();
            for c in children {
                if let Some(sql) = node(ctx, c, depth + 1)? {
                    parts.push(sql);
                }
            }
            Ok(if parts.is_empty() {
                None
            } else {
                Some(format!("({})", parts.join(joiner)))
            })
        }
        FilterNode::Leaf {
            property_id,
            operator,
            value,
        } => {
            if property_id == SEARCH_ALL && operator == "search" {
                return search_clause(ctx, value);
            }
            // A property removed since the filter was saved is ignored rather than failing the view.
            let Some(prop) = ctx.props.get(property_id.as_str()).copied() else {
                return Ok(None);
            };
            leaf(ctx, prop, operator, value).map(|s| Some(format!("({s})")))
        }
    }
}

/// The pseudo property id of the "any text property contains" condition: a leaf with this id and
/// the operator `search` matches records whose title, text, url, email or phone contains the
/// text, or whose select, status or multi-select option names do. It is never saved in a view; the
/// app adds it as an extra filter while someone searches inside a view.
pub const SEARCH_ALL: &str = "*";
const MAX_SEARCH_LEN: usize = 200;

fn search_clause(ctx: &mut Ctx, value: &Value) -> AppResult<Option<String>> {
    let term = text_of(value)?;
    let term = term.trim();
    if term.is_empty() {
        return Ok(None);
    }
    if term.chars().count() > MAX_SEARCH_LEN {
        return bad("the search text is too long");
    }
    let like = ctx.push(Sql::Text(format!("%{}%", like_escape(term))));
    let lower = term.to_lowercase();
    let mut props: Vec<&Property> = ctx.props.values().copied().collect();
    props.sort_by(|a, b| a.id.cmp(&b.id));
    let mut parts = Vec::new();
    for p in props {
        match p.property_type.as_str() {
            t if is_text_like(t) => {
                let sx = scalar(ctx, p);
                parts.push(format!("{sx} LIKE ?{like} ESCAPE '\\'"));
            }
            "select" | "status" | "multi_select" => {
                let ids: Vec<String> = p
                    .config
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter(|o| {
                                o.get("name")
                                    .and_then(Value::as_str)
                                    .is_some_and(|n| n.to_lowercase().contains(&lower))
                            })
                            .filter_map(|o| o.get("id").and_then(Value::as_str).map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                if ids.is_empty() {
                    continue;
                }
                let marks: Vec<String> = ids
                    .into_iter()
                    .map(|id| format!("?{}", ctx.push(Sql::Text(id))))
                    .collect();
                let list = marks.join(", ");
                let sx = scalar(ctx, p);
                parts.push(if p.property_type == "multi_select" {
                    format!("EXISTS (SELECT 1 FROM json_each({sx}) WHERE value IN ({list}))")
                } else {
                    format!("{sx} IN ({list})")
                });
            }
            _ => {}
        }
    }
    Ok(if parts.is_empty() {
        // Without a text-like property nothing can match.
        Some("(0)".into())
    } else {
        Some(format!("({})", parts.join(" OR ")))
    })
}

pub const EMPTY_GROUP: &str = "__empty";

/// A restriction to one group of a view's grouping.
pub struct GroupFilter<'a> {
    pub spec: &'a GroupSpec,
    pub key: &'a str,
}

/// Whether a property type can be grouped by.
pub fn can_group(property_type: &str) -> bool {
    matches!(
        property_type,
        "select" | "status" | "checkbox" | "date" | "created_time" | "updated_time"
    )
}

pub fn is_date_like(property_type: &str) -> bool {
    matches!(property_type, "date" | "created_time" | "updated_time")
}

/// SQL for a record's group key as text (NULL when the record has no value).
fn group_expr(ctx: &mut Ctx, prop: &Property, spec: &GroupSpec) -> AppResult<String> {
    if !can_group(&prop.property_type) {
        return bad(format!(
            "records cannot be grouped by a {} property",
            prop.property_type
        ));
    }
    let sx = scalar(ctx, prop);
    Ok(match class_of(prop) {
        Class::Checkbox => format!("CASE WHEN {sx} = 1 THEN 'true' ELSE 'false' END"),
        Class::Date => match spec.bucket.as_deref().unwrap_or("month") {
            "day" => format!("substr({sx}, 1, 10)"),
            "week" => format!("strftime('%Y-W%W', substr({sx}, 1, 10))"),
            "month" => format!("substr({sx}, 1, 7)"),
            "year" => format!("substr({sx}, 1, 4)"),
            other => return bad(format!("unknown date grouping '{other}'")),
        },
        _ => sx,
    })
}

fn group_where(ctx: &mut Ctx, g: &GroupFilter) -> AppResult<String> {
    let Some(prop) = ctx.props.get(g.spec.property_id.as_str()).copied() else {
        return bad("the view groups by a property that no longer exists");
    };
    let expr = group_expr(ctx, prop, g.spec)?;
    if g.key == EMPTY_GROUP {
        Ok(format!("({expr} IS NULL)"))
    } else {
        let n = ctx.push(Sql::Text(g.key.to_string()));
        Ok(format!("({expr} = ?{n})"))
    }
}

/// `SELECT` that counts records per group (and subgroup). Columns: group key, subgroup key, count.
pub fn build_group_counts(
    database_id: &str,
    props: &[Property],
    cfg: &ViewConfig,
    today: NaiveDate,
) -> AppResult<(String, Vec<Sql>)> {
    let Some(group) = &cfg.group else {
        return bad("this view has no grouping");
    };
    let mut ctx = Ctx {
        props: props.iter().map(|p| (p.id.as_str(), p)).collect(),
        params: vec![Sql::Text(database_id.to_string())],
        nodes: 0,
        today,
    };
    let where_sql = match &cfg.filter {
        Some(f) => node(&mut ctx, f, 0)?.unwrap_or_else(|| "1".into()),
        None => "1".into(),
    };
    let Some(gp) = ctx.props.get(group.property_id.as_str()).copied() else {
        return bad("the view groups by a property that no longer exists");
    };
    let g1 = group_expr(&mut ctx, gp, group)?;
    let g2 = match &cfg.subgroup {
        Some(sub) => {
            let Some(sp) = ctx.props.get(sub.property_id.as_str()).copied() else {
                return bad("the view subgroups by a property that no longer exists");
            };
            group_expr(&mut ctx, sp, sub)?
        }
        None => "NULL".to_string(),
    };
    let sql = format!(
        "SELECT {g1}, {g2}, COUNT(*) FROM db_record r JOIN page p ON p.id = r.page_id \
         WHERE r.database_id = ?1 AND p.deleted_at IS NULL AND {where_sql} GROUP BY 1, 2"
    );
    Ok((sql, ctx.params))
}

/// Builds the WHERE and ORDER BY fragments for a view. Parameter ?1 is the database id.
pub fn build(
    database_id: &str,
    props: &[Property],
    cfg: &ViewConfig,
    today: NaiveDate,
    groups: &[GroupFilter],
) -> AppResult<Built> {
    let mut ctx = Ctx {
        props: props.iter().map(|p| (p.id.as_str(), p)).collect(),
        params: vec![Sql::Text(database_id.to_string())],
        nodes: 0,
        today,
    };

    let where_sql = match &cfg.filter {
        Some(f) => node(&mut ctx, f, 0)?.unwrap_or_else(|| "1".into()),
        None => "1".into(),
    };

    let mut where_sql = where_sql;
    for g in groups {
        let clause = group_where(&mut ctx, g)?;
        where_sql = format!("{where_sql} AND {clause}");
    }
    let where_params = ctx.params.len();

    if cfg.sorts.len() > MAX_SORTS {
        return bad("too many sorts");
    }
    let mut order = Vec::new();
    let mut sort_columns = Vec::new();
    for s in &cfg.sorts {
        let dir = match s.direction.as_str() {
            "asc" => "ASC",
            "desc" => "DESC",
            _ => return bad("sort direction must be 'asc' or 'desc'"),
        };
        let Some(prop) = ctx.props.get(s.property_id.as_str()).copied() else {
            continue;
        };
        let expr = scalar(&mut ctx, prop);
        let sx = format!("sort_{}", sort_columns.len());
        sort_columns.push(format!("{expr} AS {sx}"));
        match class_of(prop) {
            Class::Multi => return bad("multi-select properties cannot be sorted"),
            Class::Relation => return bad("relations cannot be sorted"),
            Class::Text => {
                order.push(format!(
                    "({sx} IS NULL OR {sx} = '') ASC, {sx} COLLATE NOCASE {dir}"
                ));
            }
            Class::Option => {
                let mut case = String::from("CASE ");
                let ids: Vec<String> = prop
                    .config
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|o| o.get("id").and_then(Value::as_str).map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                let sxs = sx.clone();
                for (i, id) in ids.iter().enumerate() {
                    let n = ctx.push(Sql::Text(id.clone()));
                    case.push_str(&format!("WHEN {sxs} = ?{n} THEN {i} "));
                }
                case.push_str("ELSE 9999 END");
                order.push(format!("({sxs} IS NULL) ASC, {case} {dir}"));
            }
            _ => {
                order.push(format!("({sx} IS NULL) ASC, {sx} {dir}"));
            }
        }
    }
    // Creation order: the unique id counts up per database, so it never ties.
    order.push("r.unique_id ASC".into());

    Ok(Built {
        where_params,
        where_sql,
        order_sql: order.join(", "),
        sort_columns,
        params: ctx.params,
    })
}

/// Whether a property holds numbers (what a chart can sum or average).
pub fn is_numeric(p: &Property) -> bool {
    class_of(p) == Class::Number
}

/// `SELECT` for a chart. Columns: x key, series key, aggregated value, record count. A KPI has
/// no axis, so it is a single row.
pub fn build_chart(
    database_id: &str,
    props: &[Property],
    cfg: &ViewConfig,
    spec: &super::ChartSpec,
    today: NaiveDate,
) -> AppResult<(String, Vec<Sql>)> {
    build_chart_grouped(database_id, props, cfg, spec, None, today)
}

/// [`build_chart`] whose series property may be a date, bucketed by `group_bucket` (pivot columns).
pub fn build_chart_grouped(
    database_id: &str,
    props: &[Property],
    cfg: &ViewConfig,
    spec: &super::ChartSpec,
    group_bucket: Option<String>,
    today: NaiveDate,
) -> AppResult<(String, Vec<Sql>)> {
    let mut ctx = Ctx {
        props: props.iter().map(|p| (p.id.as_str(), p)).collect(),
        params: vec![Sql::Text(database_id.to_string())],
        nodes: 0,
        today,
    };
    let where_sql = match &cfg.filter {
        Some(f) => node(&mut ctx, f, 0)?.unwrap_or_else(|| "1".into()),
        None => "1".into(),
    };
    let kpi = spec.chart_type == "kpi";
    let axis = |ctx: &mut Ctx, id: &Option<String>, bucket: Option<String>| -> AppResult<String> {
        let Some(id) = id else {
            return Ok("NULL".into());
        };
        let Some(p) = ctx.props.get(id.as_str()).copied() else {
            return bad("the chart uses a property that no longer exists");
        };
        group_expr(
            ctx,
            p,
            &GroupSpec {
                property_id: id.clone(),
                bucket,
            },
        )
    };
    let x = if kpi {
        "NULL".to_string()
    } else {
        axis(&mut ctx, &spec.x_property_id, spec.bucket.clone())?
    };
    let g = if kpi {
        "NULL".to_string()
    } else {
        axis(&mut ctx, &spec.group_property_id, group_bucket)?
    };
    let value = if spec.aggregation == "count" {
        "COUNT(*)".to_string()
    } else {
        let Some(yid) = &spec.y_property_id else {
            return bad("choose a number property to calculate");
        };
        let Some(yp) = ctx.props.get(yid.as_str()).copied() else {
            return bad("the chart uses a property that no longer exists");
        };
        if class_of(yp) != Class::Number {
            return bad("only number properties can be summed or averaged");
        }
        let sx = scalar(&mut ctx, yp);
        let f = match spec.aggregation.as_str() {
            "sum" => "SUM",
            "average" => "AVG",
            "min" => "MIN",
            "max" => "MAX",
            _ => return bad("unknown aggregation"),
        };
        format!("{f}({sx})")
    };
    let tail = if kpi {
        String::new()
    } else {
        format!(
            " GROUP BY xk, gk ORDER BY xk IS NULL, xk, gk IS NULL, gk LIMIT {}",
            super::MAX_CHART_ROWS + 1
        )
    };
    let sql = format!(
        "SELECT {x} AS xk, {g} AS gk, {value}, COUNT(*) FROM db_record r JOIN page p ON p.id = r.page_id \
         WHERE r.database_id = ?1 AND p.deleted_at IS NULL AND {where_sql}{tail}"
    );
    Ok((sql, ctx.params))
}

/// Whether a summary makes sense for the property (the totals row only offers these).
pub fn aggregate_ok(p: &Property, aggregate: &str) -> bool {
    if p.property_type == "button" {
        return false;
    }
    match aggregate {
        "count" | "empty" | "filled" | "percent_filled" => true,
        "sum" | "average" | "median" | "min" | "max" | "range" => class_of(p) == Class::Number,
        "earliest" | "latest" | "date_range" => class_of(p) == Class::Date,
        "percent_checked" => class_of(p) == Class::Checkbox,
        _ => false,
    }
}

/// One aggregate as a SQL expression over the records in scope.
fn aggregate_expr(ctx: &mut Ctx, prop: &Property, aggregate: &str) -> AppResult<String> {
    let cls = class_of(prop);
    let empty = |ctx: &mut Ctx| -> AppResult<String> {
        if cls == Class::Checkbox {
            // A checkbox is never missing: "empty" means unchecked.
            Ok(format!("{} = 0", scalar(ctx, prop)))
        } else {
            leaf(ctx, prop, "is_empty", &Value::Null)
        }
    };
    Ok(match aggregate {
        "count" => "COUNT(*)".into(),
        "empty" => format!(
            "COALESCE(SUM(CASE WHEN {} THEN 1 ELSE 0 END), 0)",
            empty(ctx)?
        ),
        "filled" => format!(
            "COALESCE(SUM(CASE WHEN {} THEN 0 ELSE 1 END), 0)",
            empty(ctx)?
        ),
        "percent_filled" => format!("AVG(CASE WHEN {} THEN 0.0 ELSE 1.0 END)", empty(ctx)?),
        "sum" => format!("TOTAL({})", scalar(ctx, prop)),
        "average" => format!("AVG({})", scalar(ctx, prop)),
        "min" | "earliest" => format!("MIN({})", scalar(ctx, prop)),
        "max" | "latest" => format!("MAX({})", scalar(ctx, prop)),
        "range" => {
            let a = scalar(ctx, prop);
            let b = scalar(ctx, prop);
            format!("(MAX({a}) - MIN({b}))")
        }
        "date_range" => {
            let a = scalar(ctx, prop);
            let b = scalar(ctx, prop);
            format!("(julianday(MAX(substr({a}, 1, 10))) - julianday(MIN(substr({b}, 1, 10))))")
        }
        "percent_checked" => format!("AVG({})", scalar(ctx, prop)),
        other => return bad(format!("unknown summary '{other}'")),
    })
}

fn scoped_ctx<'a>(
    database_id: &str,
    props: &'a [Property],
    cfg: &ViewConfig,
    today: NaiveDate,
) -> AppResult<(Ctx<'a>, String)> {
    let mut ctx = Ctx {
        props: props.iter().map(|p| (p.id.as_str(), p)).collect(),
        params: vec![Sql::Text(database_id.to_string())],
        nodes: 0,
        today,
    };
    let where_sql = match &cfg.filter {
        Some(f) => node(&mut ctx, f, 0)?.unwrap_or_else(|| "1".into()),
        None => "1".into(),
    };
    Ok((ctx, where_sql))
}

/// `SELECT` for a totals row. Columns: group key (NULL when ungrouped), record count, then one
/// column per entry of `specs` that this query can compute (the median is left to
/// [`build_median`]); the returned indexes say which. With `by_group` there is a row per group.
pub fn build_aggregates(
    database_id: &str,
    props: &[Property],
    cfg: &ViewConfig,
    specs: &[(String, String)],
    by_group: bool,
    today: NaiveDate,
) -> AppResult<(String, Vec<Sql>, Vec<usize>)> {
    let (mut ctx, where_sql) = scoped_ctx(database_id, props, cfg, today)?;
    let mut key = "NULL".to_string();
    let mut tail = "";
    if by_group {
        let Some(group) = &cfg.group else {
            return bad("this view has no grouping");
        };
        let Some(gp) = ctx.props.get(group.property_id.as_str()).copied() else {
            return bad("the view groups by a property that no longer exists");
        };
        key = group_expr(&mut ctx, gp, group)?;
        tail = " GROUP BY 1";
    }
    let mut exprs = Vec::new();
    let mut kept = Vec::new();
    for (i, (pid, agg)) in specs.iter().enumerate() {
        let Some(prop) = ctx.props.get(pid.as_str()).copied() else {
            continue;
        };
        if agg == "median" || !aggregate_ok(prop, agg) {
            continue;
        }
        exprs.push(aggregate_expr(&mut ctx, prop, agg)?);
        kept.push(i);
    }
    let cols: String = exprs.iter().map(|e| format!(", {e}")).collect();
    let sql = format!(
        "SELECT {key}, COUNT(*){cols} FROM db_record r JOIN page p ON p.id = r.page_id \
         WHERE r.database_id = ?1 AND p.deleted_at IS NULL AND {where_sql}{tail}"
    );
    Ok((sql, ctx.params, kept))
}

/// `SELECT` for the median of one number column over the records in scope (one row, NULL when
/// no record has a value).
pub fn build_median(
    database_id: &str,
    props: &[Property],
    cfg: &ViewConfig,
    property_id: &str,
    today: NaiveDate,
) -> AppResult<(String, Vec<Sql>)> {
    let (mut ctx, where_sql) = scoped_ctx(database_id, props, cfg, today)?;
    let Some(prop) = ctx.props.get(property_id).copied() else {
        return bad("that property no longer exists");
    };
    if !aggregate_ok(prop, "median") {
        return bad("a median needs a number property");
    }
    let sx = scalar(&mut ctx, prop);
    let sql = format!(
        "SELECT AVG(v) FROM (SELECT v, ROW_NUMBER() OVER (ORDER BY v) AS rn, COUNT(*) OVER () AS c \
         FROM (SELECT {sx} AS v FROM db_record r JOIN page p ON p.id = r.page_id \
         WHERE r.database_id = ?1 AND p.deleted_at IS NULL AND {where_sql}) WHERE v IS NOT NULL) \
         WHERE rn IN ((c + 1) / 2, (c + 2) / 2)"
    );
    Ok((sql, ctx.params))
}

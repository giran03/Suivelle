//! Calculated properties: formula results and the in-memory path for filtering and sorting by them.
//!
//! Formula and rollup values are never stored, so SQL cannot compare them. When a view filters or
//! sorts by one, the records are loaded (up to a cap), the values are computed in memory and copied
//! into a temporary table that the compiled query reads like any other column.

use super::formula::{self, Env, Expr, FormulaError, Ty, Val};
use super::service::{load_properties, load_rows};
use super::*;
use crate::errors::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

pub const MAX_CALC_RECORDS: i64 = 10_000;

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

pub fn is_calculated(t: &str) -> bool {
    matches!(t, "formula" | "rollup")
}

pub fn expression_of(p: &Property) -> &str {
    p.config
        .get("expression")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn result_ty(p: &Property) -> Ty {
    Ty::from_name(
        p.config
            .get("resultType")
            .and_then(Value::as_str)
            .unwrap_or("any"),
    )
}

/// Property types by lowercase name, as a formula sees them.
fn ty_map(props: &[Property], skip: Option<&str>) -> HashMap<String, Ty> {
    let formulas: HashMap<String, Ty> = props
        .iter()
        .filter(|p| p.property_type == "formula")
        .map(|p| (p.id.clone(), result_ty(p)))
        .collect();
    props
        .iter()
        .filter(|p| Some(p.id.as_str()) != skip)
        .map(|p| (p.name.to_lowercase(), formula::property_ty(p, &formulas)))
        .collect()
}

fn describe(e: FormulaError, src: &str) -> AppError {
    let (line, col) = {
        let before: String = src.chars().take(e.position).collect();
        (
            before.matches('\n').count() + 1,
            before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1,
        )
    };
    AppError::Validation(format!("{} (line {line}, column {col})", e.message))
}

/// Would `candidate` (a formula named `name`) end up depending on itself?
fn has_cycle(props: &[Property], own_id: Option<&str>, name: &str, expr: &Expr) -> bool {
    let by_name: HashMap<String, &Property> =
        props.iter().map(|p| (p.name.to_lowercase(), p)).collect();
    let target = name.to_lowercase();
    let mut seen: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = Vec::new();
    refs_of(expr, &mut stack);
    while let Some(n) = stack.pop() {
        let n = n.to_lowercase();
        if n == target {
            return true;
        }
        if !seen.insert(n.clone()) {
            continue;
        }
        if let Some(p) = by_name.get(&n) {
            if p.property_type == "formula" && Some(p.id.as_str()) != own_id {
                if let Ok(Some(e)) = formula::parse(expression_of(p)) {
                    refs_of(&e, &mut stack);
                }
            }
        }
    }
    false
}

fn refs_of(e: &Expr, out: &mut Vec<String>) {
    formula::refs(e, out);
}

/// Validates a formula's config and returns it with its inferred result type.
pub fn normalize_formula(
    props: &[Property],
    own_id: Option<&str>,
    name: &str,
    config: &Value,
) -> AppResult<Value> {
    let src = config
        .get("expression")
        .and_then(Value::as_str)
        .unwrap_or("");
    let parsed = formula::parse(src).map_err(|e| describe(e, src))?;
    let tys = ty_map(props, own_id);
    let ty = match &parsed {
        None => Ty::Any,
        Some(e) => {
            let mut names = Vec::new();
            refs_of(e, &mut names);
            if names
                .iter()
                .any(|n| n.to_lowercase() == name.to_lowercase())
            {
                return bad("a formula cannot refer to itself");
            }
            if has_cycle(props, own_id, name, e) {
                return bad("formulas cannot refer to each other in a circle");
            }
            formula::check(src, &tys, true).map_err(|e| describe(e, src))?
        }
    };
    Ok(json!({ "expression": src, "resultType": ty.name() }))
}

/// Re-infers every formula's result type after a schema change.
pub fn refresh_types(conn: &Connection, database_id: &str) -> AppResult<()> {
    let mut props = load_properties(conn, database_id)?;
    let n = props
        .iter()
        .filter(|p| p.property_type == "formula")
        .count();
    if n == 0 {
        return Ok(());
    }
    for _ in 0..=n {
        let mut changed = false;
        let tys = ty_map(&props, None);
        for p in props.iter_mut().filter(|p| p.property_type == "formula") {
            let ty = formula::check(expression_of(p), &tys, false).unwrap_or(Ty::Any);
            if p.config.get("resultType").and_then(Value::as_str) != Some(ty.name()) {
                p.config["resultType"] = json!(ty.name());
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    for p in props.iter().filter(|p| p.property_type == "formula") {
        conn.execute(
            "UPDATE db_property SET config_json = ?2 WHERE id = ?1 AND config_json <> ?2",
            params![p.id, p.config.to_string()],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// evaluating
// ---------------------------------------------------------------------------------------------

struct RowEval<'a> {
    by_name: HashMap<String, &'a Property>,
    exprs: HashMap<String, Option<Expr>>,
    row: &'a RecordRow,
    memo: RefCell<HashMap<String, Val>>,
    active: RefCell<HashSet<String>>,
    now: chrono::NaiveDateTime,
}

impl RowEval<'_> {
    fn value(&self, name: &str) -> Val {
        let Some(p) = self.by_name.get(name) else {
            return formula::missing_ref_value();
        };
        if p.property_type != "formula" {
            return formula::from_cell(
                p,
                self.row.values.get(&p.id),
                &self.row.title,
                self.row.unique_id,
            );
        }
        if let Some(v) = self.memo.borrow().get(&p.id) {
            return v.clone();
        }
        if !self.active.borrow_mut().insert(p.id.clone()) {
            return Val::Err("#ERROR");
        }
        let v = match self.exprs.get(&p.id) {
            Some(Some(e)) => {
                let get = |n: &str| self.value(n);
                formula::eval(
                    e,
                    &Env {
                        now: self.now,
                        get: &get,
                    },
                )
            }
            _ => Val::Empty,
        };
        self.active.borrow_mut().remove(&p.id);
        self.memo.borrow_mut().insert(p.id.clone(), v.clone());
        v
    }
}

/// Computes every formula of `props` for `row` and stores the results in its values.
pub fn apply_formulas(rows: &mut [RecordRow], props: &[Property], now: chrono::NaiveDateTime) {
    let formulas: Vec<&Property> = props
        .iter()
        .filter(|p| p.property_type == "formula")
        .collect();
    if formulas.is_empty() {
        return;
    }
    let by_name: HashMap<String, &Property> =
        props.iter().map(|p| (p.name.to_lowercase(), p)).collect();
    let exprs: HashMap<String, Option<Expr>> = formulas
        .iter()
        .map(|p| {
            (
                p.id.clone(),
                formula::parse(expression_of(p)).ok().flatten(),
            )
        })
        .collect();
    let known: HashSet<String> = by_name.keys().cloned().collect();
    for row in rows.iter_mut() {
        if row.database_id != formulas[0].database_id {
            continue;
        }
        let results: Vec<(String, Val)> = {
            let ev = RowEval {
                by_name: by_name.clone(),
                exprs: exprs.clone(),
                row,
                memo: RefCell::new(HashMap::new()),
                active: RefCell::new(HashSet::new()),
                now,
            };
            formulas
                .iter()
                .map(|p| {
                    let broken = matches!(exprs.get(&p.id), Some(Some(e)) if formula::missing_refs(e, &known));
                    let v = if broken { formula::missing_ref_value() } else { ev.value(&p.name.to_lowercase()) };
                    (p.id.clone(), v)
                })
                .collect()
        };
        for (id, v) in results {
            match v.to_json() {
                Some(j) => row.values.insert(id, j),
                None => row.values.remove(&id),
            };
        }
    }
}

pub struct Preview {
    pub result_type: Option<String>,
    pub error: Option<FormulaError>,
    pub samples: Vec<(String, Option<Value>)>,
}

/// Checks an expression and evaluates it on the first few records, without saving anything.
pub fn preview(
    conn: &Connection,
    database_id: &str,
    own_id: Option<&str>,
    expression: &str,
) -> AppResult<(Preview, Vec<String>)> {
    let names = names_of(&load_properties(conn, database_id)?, own_id);
    Ok((preview_inner(conn, database_id, own_id, expression)?, names))
}

fn preview_inner(
    conn: &Connection,
    database_id: &str,
    own_id: Option<&str>,
    expression: &str,
) -> AppResult<Preview> {
    let props = load_properties(conn, database_id)?;
    let own = own_id.and_then(|id| props.iter().find(|p| p.id == id));
    let tys = ty_map(&props, own_id);
    let parsed = match formula::parse(expression) {
        Ok(p) => p,
        Err(e) => {
            return Ok(Preview {
                result_type: None,
                error: Some(e),
                samples: vec![],
            })
        }
    };
    let mut names = Vec::new();
    if let Some(e) = &parsed {
        refs_of(e, &mut names);
    }
    if let Some(o) = own {
        if names.iter().any(|n| n.eq_ignore_ascii_case(&o.name)) {
            return Ok(Preview {
                result_type: None,
                error: Some(FormulaError {
                    message: "a formula cannot refer to itself".into(),
                    position: 0,
                }),
                samples: vec![],
            });
        }
        if let Some(e) = &parsed {
            if has_cycle(&props, own_id, &o.name, e) {
                return Ok(Preview {
                    result_type: None,
                    error: Some(FormulaError {
                        message: "formulas cannot refer to each other in a circle".into(),
                        position: 0,
                    }),
                    samples: vec![],
                });
            }
        }
    }
    let ty = match formula::check(expression, &tys, true) {
        Ok(t) => t,
        Err(e) => {
            return Ok(Preview {
                result_type: None,
                error: Some(e),
                samples: vec![],
            })
        }
    };
    // Evaluate as a temporary formula property next to the real ones.
    let mut temp = Property {
        id: "__preview".into(),
        database_id: database_id.into(),
        name: "__preview".into(),
        property_type: "formula".into(),
        config: json!({ "expression": expression, "resultType": ty.name() }),
        position: 0.0,
    };
    let mut all: Vec<Property> = props
        .into_iter()
        .filter(|p| Some(p.id.as_str()) != own_id)
        .collect();
    temp.position = all.len() as f64;
    all.push(temp);
    let mut stmt = conn.prepare(
        "SELECT r.id FROM db_record r JOIN page p ON p.id = r.page_id WHERE r.database_id = ?1 AND p.deleted_at IS NULL ORDER BY r.unique_id LIMIT 5",
    )?;
    let ids: Vec<String> = stmt
        .query_map([database_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut rows = load_rows(conn, &ids)?;
    apply_formulas(&mut rows, &all, chrono::Local::now().naive_local());
    let samples = rows
        .into_iter()
        .map(|r| (r.title.clone(), r.values.get("__preview").cloned()))
        .collect();
    Ok(Preview {
        result_type: Some(ty.name().into()),
        error: None,
        samples,
    })
}

// ---------------------------------------------------------------------------------------------
// filtering and sorting
// ---------------------------------------------------------------------------------------------

fn filter_props(f: &FilterNode, out: &mut HashSet<String>) {
    match f {
        FilterNode::Group { children, .. } => children.iter().for_each(|c| filter_props(c, out)),
        FilterNode::Leaf { property_id, .. } => {
            out.insert(property_id.clone());
        }
    }
}

/// The calculated properties a view's filter or sorts depend on.
pub fn used_by<'a>(props: &'a [Property], cfg: &ViewConfig) -> Vec<&'a Property> {
    let mut ids = HashSet::new();
    if let Some(f) = &cfg.filter {
        filter_props(f, &mut ids);
    }
    ids.extend(cfg.sorts.iter().map(|s| s.property_id.clone()));
    props
        .iter()
        .filter(|p| is_calculated(&p.property_type) && ids.contains(&p.id))
        .collect()
}

/// Fills the temporary `calc` table with the values of every property in `needed`.
pub fn prepare(conn: &Connection, database_id: &str, needed: &[&Property]) -> AppResult<()> {
    if needed.is_empty() {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS calc (record_id TEXT NOT NULL, property_id TEXT NOT NULL, v, PRIMARY KEY (record_id, property_id)) WITHOUT ROWID; DELETE FROM calc;",
    )?;
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM db_record r JOIN page p ON p.id = r.page_id WHERE r.database_id = ?1 AND p.deleted_at IS NULL",
        [database_id],
        |r| r.get(0),
    )?;
    if total > MAX_CALC_RECORDS {
        return bad(format!(
            "filtering or sorting by a formula or rollup works on up to {MAX_CALC_RECORDS} records; this database has {total}"
        ));
    }
    let mut stmt = conn.prepare(
        "SELECT r.id FROM db_record r JOIN page p ON p.id = r.page_id WHERE r.database_id = ?1 AND p.deleted_at IS NULL",
    )?;
    let ids: Vec<String> = stmt
        .query_map([database_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut insert = conn
        .prepare("INSERT OR REPLACE INTO calc (record_id, property_id, v) VALUES (?1, ?2, ?3)")?;
    for chunk in ids.chunks(400) {
        for row in load_rows(conn, chunk)? {
            for p in needed {
                let v: Option<rusqlite::types::Value> = row.values.get(&p.id).and_then(sql_of);
                if let Some(v) = v {
                    insert.execute(params![row.id, p.id, v])?;
                }
            }
        }
    }
    Ok(())
}

fn sql_of(v: &Value) -> Option<rusqlite::types::Value> {
    use rusqlite::types::Value as S;
    match v {
        Value::Number(n) => n.as_f64().map(S::Real),
        Value::String(s) => Some(S::Text(s.clone())),
        Value::Bool(b) => Some(S::Integer(*b as i64)),
        Value::Object(o) if o.contains_key("error") => None,
        Value::Object(o) => o
            .get("start")
            .and_then(Value::as_str)
            .map(|s| S::Text(s.to_string())),
        Value::Array(_) => Some(S::Text(v.to_string())),
        Value::Null => None,
    }
}

/// After a property is renamed, formulas that referred to it by name are rewritten to the new name.
pub fn rename_in_formulas(
    conn: &Connection,
    database_id: &str,
    old: &str,
    new: &str,
) -> AppResult<()> {
    for p in load_properties(conn, database_id)?
        .iter()
        .filter(|p| p.property_type == "formula")
    {
        let src = expression_of(p);
        let next = formula::rename_refs(src, old, new);
        if next != src {
            let mut config = p.config.clone();
            config["expression"] = json!(next);
            conn.execute(
                "UPDATE db_property SET config_json = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?1",
                params![p.id, config.to_string(), crate::domain::now()],
            )?;
        }
    }
    Ok(())
}

fn names_of(props: &[Property], skip: Option<&str>) -> Vec<String> {
    props
        .iter()
        .filter(|p| Some(p.id.as_str()) != skip)
        .map(|p| p.name.clone())
        .collect()
}

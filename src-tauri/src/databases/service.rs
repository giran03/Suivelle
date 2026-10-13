//! Database services: every write validates, runs in one transaction, and keeps search in step.

use super::query::{self, GroupFilter};
use super::values::{self, is_text_like};
use super::*;
use crate::domain::{new_id, now, validate_id, validate_title, Block, Page};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use crate::search;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

fn not_found(what: &str) -> AppError {
    AppError::NotFound(what.into())
}

// ---------------------------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------------------------

const DB_COLS: &str = "id, page_id, workspace_id, next_unique_id, created_at, updated_at";

fn database_row(r: &Row) -> rusqlite::Result<Database> {
    Ok(Database {
        id: r.get(0)?,
        page_id: r.get(1)?,
        workspace_id: r.get(2)?,
        next_unique_id: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

fn property_row(r: &Row) -> rusqlite::Result<Property> {
    let config: String = r.get(4)?;
    Ok(Property {
        id: r.get(0)?,
        database_id: r.get(1)?,
        name: r.get(2)?,
        property_type: r.get(3)?,
        config: serde_json::from_str(&config).unwrap_or_else(|_| json!({})),
        position: r.get(5)?,
    })
}

const PROP_COLS: &str = "id, database_id, name, type, config_json, position";

pub fn load_database(conn: &Connection, id: &str) -> AppResult<Database> {
    conn.query_row(
        &format!("SELECT {DB_COLS} FROM db_database WHERE id = ?1"),
        [id],
        database_row,
    )
    .optional()?
    .ok_or_else(|| not_found("database"))
}

pub fn load_properties(conn: &Connection, database_id: &str) -> AppResult<Vec<Property>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PROP_COLS} FROM db_property WHERE database_id = ?1 ORDER BY position, id"
    ))?;
    let rows = stmt.query_map([database_id], property_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub(super) fn load_property(conn: &Connection, id: &str) -> AppResult<Property> {
    conn.query_row(
        &format!("SELECT {PROP_COLS} FROM db_property WHERE id = ?1"),
        [id],
        property_row,
    )
    .optional()?
    .ok_or_else(|| not_found("property"))
}

/// Both filters must hold. Either may be absent.
pub(super) fn and_filters(a: Option<FilterNode>, b: Option<FilterNode>) -> Option<FilterNode> {
    match (a, b) {
        (Some(a), Some(b)) => Some(FilterNode::Group {
            op: "and".into(),
            children: vec![a, b],
        }),
        (a, None) => a,
        (None, b) => b,
    }
}

fn view_config_of(json_text: &str) -> ViewConfig {
    serde_json::from_str(json_text).unwrap_or_default()
}

const VIEW_COLS: &str = "id, database_id, name, type, config_json";

fn view_row(r: &Row) -> rusqlite::Result<DbView> {
    Ok(DbView {
        id: r.get(0)?,
        database_id: r.get(1)?,
        name: r.get(2)?,
        view_type: r.get(3)?,
        config: view_config_of(&r.get::<_, String>(4)?),
    })
}

fn insert_view(
    conn: &Connection,
    database_id: &str,
    name: &str,
    view_type: &str,
    config: &ViewConfig,
    position: f64,
) -> AppResult<DbView> {
    let (id, now) = (new_id(), now());
    conn.execute(
        "INSERT INTO db_view (id, database_id, name, type, config_json, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, database_id, name, view_type, serde_json::to_string(config).map_err(|e| AppError::Internal(e.to_string()))?, position, now],
    )?;
    Ok(DbView {
        id,
        database_id: database_id.into(),
        name: name.into(),
        view_type: view_type.into(),
        config: config.clone(),
    })
}

/// A database's views in tab order. A database always has at least one, so a missing table view is recreated.
pub fn load_views(conn: &Connection, database_id: &str) -> AppResult<Vec<DbView>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {VIEW_COLS} FROM db_view WHERE database_id = ?1 ORDER BY position, created_at, id"
    ))?;
    let views: Vec<DbView> = stmt
        .query_map([database_id], view_row)?
        .collect::<Result<_, _>>()?;
    if !views.is_empty() {
        return Ok(views);
    }
    let props = load_properties(conn, database_id)?;
    let config = normalize_view(ViewConfig::default(), &props, database_id, "table")?;
    Ok(vec![insert_view(
        conn,
        database_id,
        "Table",
        "table",
        &config,
        0.0,
    )?])
}

pub(super) fn load_view_by_id(conn: &Connection, id: &str) -> AppResult<DbView> {
    conn.query_row(
        &format!("SELECT {VIEW_COLS} FROM db_view WHERE id = ?1"),
        [id],
        view_row,
    )
    .optional()?
    .ok_or_else(|| not_found("view"))
}

/// The requested view, or the first one when none is named.
pub(super) fn pick_view(
    conn: &Connection,
    database_id: &str,
    view_id: Option<&str>,
) -> AppResult<DbView> {
    match view_id {
        Some(id) => {
            validate_id(id, "view")?;
            let v = load_view_by_id(conn, id)?;
            if v.database_id != database_id {
                return bad("that view belongs to another database");
            }
            Ok(v)
        }
        None => Ok(load_views(conn, database_id)?.remove(0)),
    }
}

fn detail(conn: &Connection, db: Database) -> AppResult<DatabaseDetail> {
    let page = repo::page::get(conn, &db.page_id)?.ok_or_else(|| not_found("database page"))?;
    let properties = load_properties(conn, &db.id)?;
    let views = load_views(conn, &db.id)?;
    Ok(DatabaseDetail {
        database: db,
        page,
        properties,
        views,
    })
}

pub fn database_detail(conn: &Connection, database_id: &str) -> AppResult<DatabaseDetail> {
    validate_id(database_id, "database")?;
    detail(conn, load_database(conn, database_id)?)
}

/// Looks a database up by its page id (what the UI knows when a database page is opened).
pub fn database_detail_by_page(conn: &Connection, page_id: &str) -> AppResult<DatabaseDetail> {
    validate_id(page_id, "page")?;
    let db = conn
        .query_row(
            &format!("SELECT {DB_COLS} FROM db_database WHERE page_id = ?1"),
            [page_id],
            database_row,
        )
        .optional()?
        .ok_or_else(|| not_found("database"))?;
    detail(conn, db)
}

// ---------------------------------------------------------------------------------------------
// view normalization
// ---------------------------------------------------------------------------------------------

fn normalize_group(
    spec: Option<GroupSpec>,
    known: &HashMap<&str, &Property>,
) -> AppResult<Option<GroupSpec>> {
    let Some(spec) = spec else { return Ok(None) };
    let Some(p) = known.get(spec.property_id.as_str()) else {
        return Ok(None);
    };
    if !query::can_group(&p.property_type) {
        return bad(format!(
            "records cannot be grouped by a {} property",
            p.property_type
        ));
    }
    let bucket = if query::is_date_like(&p.property_type) {
        let b = spec.bucket.unwrap_or_else(|| "month".into());
        if !matches!(b.as_str(), "day" | "week" | "month" | "year") {
            return bad("date groups can be by day, week, month or year");
        }
        Some(b)
    } else {
        None
    };
    Ok(Some(GroupSpec {
        property_id: spec.property_id,
        bucket,
    }))
}

/// Brings a view configuration in line with the database's properties: unknown properties are
/// dropped, new ones appended, sorts, filters and grouping validated for the view's type.
pub fn normalize_view(
    cfg: ViewConfig,
    props: &[Property],
    database_id: &str,
    view_type: &str,
) -> AppResult<ViewConfig> {
    if !VIEW_TYPES.contains(&view_type) {
        return bad(format!("unknown view type '{view_type}'"));
    }
    let known: HashMap<&str, &Property> = props.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut seen = std::collections::HashSet::new();
    let mut columns: Vec<ViewColumn> = Vec::new();
    for c in cfg.columns {
        if known.contains_key(c.property_id.as_str()) && seen.insert(c.property_id.clone()) {
            columns.push(ViewColumn {
                width: c.width.map(|w| w.clamp(60.0, 800.0)),
                ..c
            });
        }
    }
    for p in props {
        if seen.insert(p.id.clone()) {
            columns.push(ViewColumn {
                property_id: p.id.clone(),
                width: None,
                hidden: false,
            });
        }
    }
    // The title can be narrowed but never hidden: it is how a record is opened.
    for c in &mut columns {
        if known
            .get(c.property_id.as_str())
            .is_some_and(|p| p.property_type == "title")
        {
            c.hidden = false;
        }
    }

    let mut sorts: Vec<ViewSort> = Vec::new();
    for s in cfg.sorts {
        let Some(p) = known.get(s.property_id.as_str()) else {
            continue;
        };
        if !matches!(s.direction.as_str(), "asc" | "desc") {
            return bad("sort direction must be 'asc' or 'desc'");
        }
        if matches!(p.property_type.as_str(), "multi_select" | "relation")
            || sorts.iter().any(|x| x.property_id == s.property_id)
        {
            continue;
        }
        sorts.push(s);
    }
    if sorts.len() > MAX_SORTS {
        return bad("too many sorts");
    }

    let group = normalize_group(cfg.group, &known)?;
    let subgroup = match normalize_group(cfg.subgroup, &known)? {
        Some(sub)
            if group
                .as_ref()
                .is_some_and(|g| g.property_id != sub.property_id) =>
        {
            Some(sub)
        }
        _ => None,
    };
    let date_property_id = cfg
        .date_property_id
        .filter(|id| {
            known
                .get(id.as_str())
                .is_some_and(|p| query::is_date_like(&p.property_type))
        })
        .or_else(|| {
            if matches!(view_type, "calendar" | "timeline") {
                props
                    .iter()
                    .find(|p| p.property_type == "date")
                    .map(|p| p.id.clone())
            } else {
                None
            }
        });
    let card_size = match cfg.card_size.as_deref() {
        Some(v @ ("small" | "medium" | "large")) => Some(v.to_string()),
        Some(_) => return bad("card size must be small, medium or large"),
        None => (view_type == "gallery").then(|| "medium".to_string()),
    };
    let zoom = match cfg.zoom.as_deref() {
        Some(v @ ("week" | "month" | "quarter")) => Some(v.to_string()),
        Some(_) => return bad("timeline zoom must be week, month or quarter"),
        None => (view_type == "timeline").then(|| "month".to_string()),
    };

    let chart = match view_type {
        "chart" => Some(charts::normalize(
            cfg.chart.unwrap_or_else(|| charts::default_spec(props)),
            props,
        )?),
        _ => None,
    };
    let form = match view_type {
        "form" => Some(forms::normalize(
            cfg.form.unwrap_or_else(|| forms::default_spec(props)),
            props,
        )?),
        _ => None,
    };
    let feed_order = match cfg.feed_order.as_deref() {
        Some(v @ ("created" | "updated")) => Some(v.to_string()),
        Some(_) => return bad("a feed is ordered by created or updated"),
        None => (view_type == "feed").then(|| "created".to_string()),
    };
    let out = ViewConfig {
        columns,
        sorts,
        filter: cfg.filter,
        group,
        subgroup,
        hide_empty_groups: cfg.hide_empty_groups,
        date_property_id,
        card_size,
        zoom,
        chart,
        form,
        feed_order,
    };
    // Dry-run the compiler so an invalid filter or grouping is rejected when saved, not when queried.
    query::build(
        database_id,
        props,
        &out,
        chrono::Local::now().date_naive(),
        &[],
    )?;
    if out.group.is_some() {
        query::build_group_counts(database_id, props, &out, chrono::Local::now().date_naive())?;
    }
    Ok(out)
}

fn save_view(conn: &Connection, view_id: &str, cfg: &ViewConfig) -> AppResult<()> {
    conn.execute(
        "UPDATE db_view SET config_json = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?1",
        params![view_id, serde_json::to_string(cfg).map_err(|e| AppError::Internal(e.to_string()))?, now()],
    )?;
    Ok(())
}

fn prune_filter(f: FilterNode, property_id: &str) -> Option<FilterNode> {
    match f {
        FilterNode::Leaf { property_id: p, .. } if p == property_id => None,
        FilterNode::Group { op, children } => {
            let kept: Vec<FilterNode> = children
                .into_iter()
                .filter_map(|c| prune_filter(c, property_id))
                .collect();
            (!kept.is_empty()).then_some(FilterNode::Group { op, children: kept })
        }
        leaf => Some(leaf),
    }
}

fn view_name(name: &str) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 60 {
        return bad("view names must be 1-60 characters");
    }
    Ok(n.to_string())
}

pub fn update_view(conn: &mut Connection, input: ViewUpdate) -> AppResult<DbView> {
    let tx = conn.transaction()?;
    let out = update_view_in(&tx, input)?;
    tx.commit()?;
    Ok(out)
}

/// The body of [`update_view`], for callers that already hold a transaction.
pub(crate) fn update_view_in(tx: &Connection, input: ViewUpdate) -> AppResult<DbView> {
    validate_id(&input.view_id, "view")?;
    let mut view = load_view_by_id(tx, &input.view_id)?;
    let props = load_properties(tx, &view.database_id)?;
    view.config = normalize_view(input.config, &props, &view.database_id, &view.view_type)?;
    if let Some(n) = &input.name {
        view.name = view_name(n)?;
        tx.execute(
            "UPDATE db_view SET name = ?2 WHERE id = ?1",
            params![view.id, view.name],
        )?;
    }
    save_view(tx, &view.id, &view.config)?;
    Ok(view)
}

/// New views start with sensible properties shown (the title and up to three more); a board starts
/// grouped by the first status or select property.
pub fn create_view(conn: &mut Connection, input: ViewCreate) -> AppResult<DbView> {
    let tx = conn.transaction()?;
    let out = create_view_in(&tx, input)?;
    tx.commit()?;
    Ok(out)
}

/// The body of [`create_view`], for callers that already hold a transaction.
pub(crate) fn create_view_in(tx: &Connection, input: ViewCreate) -> AppResult<DbView> {
    validate_id(&input.database_id, "database")?;
    if !VIEW_TYPES.contains(&input.view_type.as_str()) {
        return bad(format!("unknown view type '{}'", input.view_type));
    }
    let db = load_database(tx, &input.database_id)?;
    let views = load_views(tx, &db.id)?;
    if views.len() >= MAX_VIEWS {
        return bad(format!("a database can have at most {MAX_VIEWS} views"));
    }
    let props = load_properties(tx, &db.id)?;
    let mut cfg = input.config.unwrap_or_default();
    if cfg.columns.is_empty() && input.view_type != "table" {
        let mut shown = 0;
        cfg.columns = props
            .iter()
            .map(|p| {
                let show = p.property_type == "title"
                    || (shown < 3
                        && !matches!(p.property_type.as_str(), "created_time" | "updated_time"));
                if show && p.property_type != "title" {
                    shown += 1;
                }
                ViewColumn {
                    property_id: p.id.clone(),
                    width: None,
                    hidden: !show,
                }
            })
            .collect();
    }
    if input.view_type == "board" && cfg.group.is_none() {
        cfg.group = props
            .iter()
            .find(|p| p.property_type == "status")
            .or_else(|| props.iter().find(|p| p.property_type == "select"))
            .map(|p| GroupSpec {
                property_id: p.id.clone(),
                bucket: None,
            });
    }
    let config = normalize_view(cfg, &props, &db.id, &input.view_type)?;
    let default_name = match input.view_type.as_str() {
        "table" => "Table",
        "board" => "Board",
        "list" => "List",
        "gallery" => "Gallery",
        "calendar" => "Calendar",
        "chart" => "Chart",
        "form" => "Form",
        "feed" => "Feed",
        _ => "Timeline",
    };
    let name = match input.name.as_deref() {
        Some(n) => view_name(n)?,
        None => default_name.to_string(),
    };
    let position = views.last().map_or(0.0, |v| load_position(tx, &v.id)) + 1.0;
    let view = insert_view(tx, &db.id, &name, &input.view_type, &config, position)?;
    Ok(view)
}

fn load_position(conn: &Connection, view_id: &str) -> f64 {
    conn.query_row(
        "SELECT position FROM db_view WHERE id = ?1",
        [view_id],
        |r| r.get(0),
    )
    .unwrap_or(0.0)
}

pub fn duplicate_view(conn: &mut Connection, view_id: &str) -> AppResult<DbView> {
    validate_id(view_id, "view")?;
    let tx = conn.transaction()?;
    let src = load_view_by_id(&tx, view_id)?;
    let views = load_views(&tx, &src.database_id)?;
    if views.len() >= MAX_VIEWS {
        return bad(format!("a database can have at most {MAX_VIEWS} views"));
    }
    let name: String = format!("{} copy", src.name).chars().take(60).collect();
    let position = views.last().map_or(0.0, |v| load_position(&tx, &v.id)) + 1.0;
    let view = insert_view(
        &tx,
        &src.database_id,
        &name,
        &src.view_type,
        &src.config,
        position,
    )?;
    tx.commit()?;
    Ok(view)
}

pub fn delete_view(conn: &mut Connection, view_id: &str) -> AppResult<()> {
    validate_id(view_id, "view")?;
    let tx = conn.transaction()?;
    let view = load_view_by_id(&tx, view_id)?;
    if load_views(&tx, &view.database_id)?.len() <= 1 {
        return bad("a database needs at least one view");
    }
    tx.execute("DELETE FROM db_view WHERE id = ?1", [view_id])?;
    tx.commit()?;
    Ok(())
}

/// Orders group keys for display: options in their defined order, checkbox unchecked first, dates
/// chronologically; the "no value" group comes last.
fn order_group_keys(
    prop: &Property,
    present: &HashMap<String, i64>,
    hide_empty: bool,
) -> Vec<String> {
    let mut keys: Vec<String> = match prop.property_type.as_str() {
        "select" | "status" => {
            let mut k = values::option_ids(prop);
            let mut extra: Vec<&String> = present
                .keys()
                .filter(|x| x.as_str() != query::EMPTY_GROUP && !k.contains(x))
                .collect();
            extra.sort();
            k.extend(extra.into_iter().cloned());
            k
        }
        "checkbox" => vec!["false".into(), "true".into()],
        _ => {
            let mut k: Vec<String> = present
                .keys()
                .filter(|x| x.as_str() != query::EMPTY_GROUP)
                .cloned()
                .collect();
            k.sort();
            k
        }
    };
    let is_dated = query::is_date_like(&prop.property_type);
    if hide_empty || is_dated {
        keys.retain(|k| present.get(k).copied().unwrap_or(0) > 0);
    }
    if present.get(query::EMPTY_GROUP).copied().unwrap_or(0) > 0
        || (!hide_empty && !is_dated && prop.property_type != "checkbox")
    {
        keys.push(query::EMPTY_GROUP.into());
    }
    keys
}

/// Record counts per group (and subgroup) for a grouped view.
pub fn group_counts(conn: &Connection, input: &GroupCountsQuery) -> AppResult<Vec<GroupCount>> {
    validate_id(&input.database_id, "database")?;
    let db = load_database(conn, &input.database_id)?;
    let props = load_properties(conn, &db.id)?;
    let mut view = pick_view(conn, &db.id, input.view_id.as_deref())?;
    view.config.filter = and_filters(view.config.filter.take(), input.extra_filter.clone());
    let cfg = &view.config;
    let Some(group) = &cfg.group else {
        return bad("this view has no grouping");
    };
    calc::prepare(conn, &db.id, &calc::used_by(&props, cfg))?;
    let (sql, params) =
        query::build_group_counts(&db.id, &props, cfg, chrono::Local::now().date_naive())?;
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<(Option<String>, Option<String>, i64)> = stmt
        .query_map(params_from_iter(params.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<Result<_, _>>()?;
    let key = |k: Option<String>| k.unwrap_or_else(|| query::EMPTY_GROUP.to_string());

    let mut by_group: HashMap<String, i64> = HashMap::new();
    let mut by_sub: HashMap<String, i64> = HashMap::new();
    let mut by_pair: HashMap<(String, String), i64> = HashMap::new();
    for (g, sg, n) in rows {
        let (g, sg) = (key(g), key(sg));
        *by_group.entry(g.clone()).or_default() += n;
        *by_sub.entry(sg.clone()).or_default() += n;
        by_pair.insert((g, sg), n);
    }
    let group_prop = props
        .iter()
        .find(|p| p.id == group.property_id)
        .ok_or_else(|| not_found("group property"))?;
    let sub_prop = cfg
        .subgroup
        .as_ref()
        .and_then(|s| props.iter().find(|p| p.id == s.property_id));
    let sub_keys = sub_prop
        .map(|p| order_group_keys(p, &by_sub, cfg.hide_empty_groups))
        .unwrap_or_default();

    Ok(
        order_group_keys(group_prop, &by_group, cfg.hide_empty_groups)
            .into_iter()
            .map(|k| GroupCount {
                count: by_group.get(&k).copied().unwrap_or(0),
                subgroups: sub_keys
                    .iter()
                    .map(|sk| GroupCount {
                        key: sk.clone(),
                        count: by_pair.get(&(k.clone(), sk.clone())).copied().unwrap_or(0),
                        subgroups: vec![],
                    })
                    .collect(),
                key: k,
            })
            .collect(),
    )
}

// ---------------------------------------------------------------------------------------------
// databases and properties
// ---------------------------------------------------------------------------------------------

pub(super) fn insert_property(
    conn: &Connection,
    database_id: &str,
    name: &str,
    ptype: &str,
    config: &Value,
    position: f64,
) -> AppResult<Property> {
    let (id, now) = (new_id(), now());
    conn.execute(
        "INSERT INTO db_property (id, database_id, name, type, config_json, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, database_id, name, ptype, config.to_string(), position, now],
    )?;
    Ok(Property {
        id,
        database_id: database_id.into(),
        name: name.into(),
        property_type: ptype.into(),
        config: config.clone(),
        position,
    })
}

pub fn create_database(conn: &mut Connection, input: DatabaseCreate) -> AppResult<DatabaseDetail> {
    let tx = conn.transaction()?;
    let out = create_database_in(&tx, input)?;
    tx.commit()?;
    Ok(out)
}

/// The body of [`create_database`], for callers that already hold a transaction.
pub(crate) fn create_database_in(
    tx: &Connection,
    input: DatabaseCreate,
) -> AppResult<DatabaseDetail> {
    validate_id(&input.workspace_id, "workspace")?;
    if let Some(p) = &input.parent_page_id {
        validate_id(p, "parent page")?;
    }
    let title = input.title.unwrap_or_default();
    validate_title(&title)?;
    let title = if title.trim().is_empty() {
        "Untitled database".to_string()
    } else {
        title
    };

    if repo::workspace::get(tx, &input.workspace_id)?.is_none() {
        return Err(not_found("workspace"));
    }
    if let Some(pid) = &input.parent_page_id {
        match repo::page::get(tx, pid)? {
            Some(p)
                if p.workspace_id == input.workspace_id
                    && p.deleted_at.is_none()
                    && p.kind == "page" => {}
            _ => return Err(not_found("parent page")),
        }
    }
    let now_s = now();
    let page = Page {
        id: new_id(),
        workspace_id: input.workspace_id.clone(),
        parent_page_id: input.parent_page_id.clone(),
        title,
        icon: None,
        cover: None,
        position: repo::page::next_position(
            tx,
            &input.workspace_id,
            input.parent_page_id.as_deref(),
        )?,
        favorite: false,
        archived: false,
        deleted_at: None,
        revision: 1,
        created_at: now_s.clone(),
        updated_at: now_s.clone(),
        child_count: 0,
        kind: "database".into(),
    };
    repo::page::insert(tx, &page)?;
    search::index::upsert_page(tx, &page)?;

    let db_id = new_id();
    tx.execute(
        "INSERT INTO db_database (id, page_id, workspace_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![db_id, page.id, page.workspace_id, now_s],
    )?;
    insert_property(tx, &db_id, "Name", "title", &json!({}), 0.0)?;
    insert_property(
        tx,
        &db_id,
        "Tags",
        "multi_select",
        &values::default_config("multi_select"),
        1.0,
    )?;
    let props = load_properties(tx, &db_id)?;
    let config = normalize_view(ViewConfig::default(), &props, &db_id, "table")?;
    insert_view(tx, &db_id, "Table", "table", &config, 0.0)?;
    let d = detail(tx, load_database(tx, &db_id)?)?;
    Ok(d)
}

/// A database with only its title property and one table view, for importers that bring their
/// own properties. `title_name` names the title property.
pub(crate) fn create_database_empty_in(
    tx: &Connection,
    input: DatabaseCreate,
    title_name: &str,
) -> AppResult<DatabaseDetail> {
    let made = create_database_in(tx, input)?;
    tx.execute(
        "DELETE FROM db_property WHERE database_id = ?1 AND type = 'multi_select' AND name = 'Tags'",
        [&made.database.id],
    )?;
    let title = validate_property_name(title_name)?;
    tx.execute(
        "UPDATE db_property SET name = ?2 WHERE database_id = ?1 AND type = 'title'",
        params![made.database.id, title],
    )?;
    let view = made.views.first().ok_or_else(|| not_found("view"))?;
    update_view_in(
        tx,
        ViewUpdate {
            view_id: view.id.clone(),
            name: None,
            config: ViewConfig::default(),
        },
    )?;
    detail(tx, load_database(tx, &made.database.id)?)
}

fn validate_property_name(name: &str) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 60 {
        return bad("property names must be 1-60 characters");
    }
    Ok(n.to_string())
}

pub(super) fn ensure_unique_name(
    props: &[Property],
    name: &str,
    except: Option<&str>,
) -> AppResult<()> {
    if props
        .iter()
        .any(|p| Some(p.id.as_str()) != except && p.name.to_lowercase() == name.to_lowercase())
    {
        return bad(format!("there is already a property named '{name}'"));
    }
    Ok(())
}

pub fn add_property(conn: &mut Connection, input: PropertyCreate) -> AppResult<Property> {
    let tx = conn.transaction()?;
    let out = add_property_in(&tx, input)?;
    tx.commit()?;
    Ok(out)
}

/// The body of [`add_property`], for callers that already hold a transaction.
pub(crate) fn add_property_in(tx: &Connection, input: PropertyCreate) -> AppResult<Property> {
    validate_id(&input.database_id, "database")?;
    let name = validate_property_name(&input.name)?;
    let ptype = input.property_type.as_str();
    if !PROPERTY_TYPES.contains(&ptype) {
        return bad(format!("unknown property type '{ptype}'"));
    }
    if ptype == "title" {
        return bad("a database has exactly one title property");
    }
    let db = load_database(tx, &input.database_id)?;
    let props = load_properties(tx, &db.id)?;
    if props.len() >= MAX_PROPERTIES {
        return bad(format!(
            "a database can have at most {MAX_PROPERTIES} properties"
        ));
    }
    ensure_unique_name(&props, &name, None)?;
    let empty = json!({});
    let prop = match ptype {
        "relation" => {
            relations::create_relation(tx, &db, &name, input.config.as_ref().unwrap_or(&empty))?
        }
        _ => {
            let config = match (ptype, &input.config) {
                ("rollup", c) => {
                    relations::normalize_rollup(tx, &props, c.as_ref().unwrap_or(&empty))?
                }
                ("formula", c) => {
                    calc::normalize_formula(&props, None, &name, c.as_ref().unwrap_or(&empty))?
                }
                (_, Some(c)) => values::normalize_config(ptype, c)?,
                (_, None) => values::normalize_config(ptype, &values::default_config(ptype))?,
            };
            let position = props.iter().map(|p| p.position).fold(0.0, f64::max) + 1.0;
            let prop = insert_property(tx, &db.id, &name, ptype, &config, position)?;
            attach_columns(tx, &db.id, &prop)?;
            prop
        }
    };
    calc::refresh_types(tx, &db.id)?;
    let prop = load_property(tx, &prop.id)?;
    Ok(prop)
}

/// Adds a new property to every view. Table views show it straight away; cards and rows stay
/// uncluttered until it is turned on.
pub(super) fn attach_columns(
    conn: &Connection,
    database_id: &str,
    prop: &Property,
) -> AppResult<()> {
    for view in load_views(conn, database_id)? {
        let mut cfg = view.config;
        cfg.columns.push(ViewColumn {
            property_id: prop.id.clone(),
            width: None,
            hidden: view.view_type != "table",
        });
        save_view(conn, &view.id, &cfg)?;
    }
    Ok(())
}

pub fn update_property(conn: &mut Connection, input: PropertyUpdate) -> AppResult<Property> {
    validate_id(&input.id, "property")?;
    let tx = conn.transaction()?;
    let mut prop = load_property(&tx, &input.id)?;
    let mut renamed_from: Option<String> = None;
    if let Some(n) = &input.name {
        let name = validate_property_name(n)?;
        ensure_unique_name(
            &load_properties(&tx, &prop.database_id)?,
            &name,
            Some(&prop.id),
        )?;
        if name != prop.name {
            renamed_from = Some(prop.name.clone());
        }
        prop.name = name;
    }
    if let Some(c) = &input.config {
        prop.config = match prop.property_type.as_str() {
            "relation" => {
                return bad("a relation's database cannot be changed; delete it and add another")
            }
            "rollup" => {
                let props = load_properties(&tx, &prop.database_id)?;
                relations::normalize_rollup(&tx, &props, c)?
            }
            "formula" => {
                let props = load_properties(&tx, &prop.database_id)?;
                calc::normalize_formula(&props, Some(&prop.id), &prop.name, c)?
            }
            t => values::normalize_config(t, c)?,
        };
    }
    if let Some(p) = input.position {
        if !p.is_finite() {
            return bad("position must be a finite number");
        }
        prop.position = p;
    }
    tx.execute(
        "UPDATE db_property SET name = ?2, config_json = ?3, position = ?4, revision = revision + 1, updated_at = ?5 WHERE id = ?1",
        params![prop.id, prop.name, prop.config.to_string(), prop.position, now()],
    )?;
    if renamed_from.is_some() || prop.property_type == "formula" {
        if let Some(old) = &renamed_from {
            calc::rename_in_formulas(&tx, &prop.database_id, old, &prop.name)?;
        }
        calc::refresh_types(&tx, &prop.database_id)?;
        prop = load_property(&tx, &prop.id)?;
    }
    tx.commit()?;
    Ok(prop)
}

pub fn delete_property(conn: &mut Connection, id: &str) -> AppResult<()> {
    validate_id(id, "property")?;
    let tx = conn.transaction()?;
    let prop = load_property(&tx, id)?;
    if prop.property_type == "title" {
        return bad("the title property cannot be deleted");
    }
    search::index::remove_property_docs(&tx, id)?;
    if prop.property_type == "relation" {
        relations::detach_relation(&tx, &prop)?;
    }
    tx.execute("DELETE FROM db_property WHERE id = ?1", [id])?; // values and links cascade
    calc::refresh_types(&tx, &prop.database_id)?;
    for view in load_views(&tx, &prop.database_id)? {
        let mut cfg = view.config;
        cfg.columns.retain(|c| c.property_id != id);
        cfg.sorts.retain(|s| s.property_id != id);
        cfg.filter = cfg.filter.and_then(|f| prune_filter(f, id));
        if cfg.group.as_ref().is_some_and(|g| g.property_id == id) {
            cfg.group = None;
            cfg.subgroup = None;
        }
        if cfg.subgroup.as_ref().is_some_and(|g| g.property_id == id) {
            cfg.subgroup = None;
        }
        if cfg.date_property_id.as_deref() == Some(id) {
            cfg.date_property_id = None;
        }
        if let Some(form) = &mut cfg.form {
            form.fields.retain(|f| f.property_id != id);
        }
        if let Some(chart) = &mut cfg.chart {
            for slot in [
                &mut chart.x_property_id,
                &mut chart.y_property_id,
                &mut chart.group_property_id,
            ] {
                if slot.as_deref() == Some(id) {
                    *slot = None;
                }
            }
        }
        save_view(&tx, &view.id, &cfg)?;
    }
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------------------------

/// Loads rows (with all their values) in the order of `ids`.
pub fn load_rows(conn: &Connection, ids: &[String]) -> AppResult<Vec<RecordRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let marks = vec!["?"; ids.len()].join(",");
    let mut rows: HashMap<String, RecordRow> = HashMap::new();
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT r.id, r.page_id, r.database_id, p.title, r.unique_id, r.created_at, p.updated_at
             FROM db_record r JOIN page p ON p.id = r.page_id WHERE r.id IN ({marks})"
        ))?;
        let mapped = stmt.query_map(params_from_iter(ids.iter()), |r| {
            Ok(RecordRow {
                id: r.get(0)?,
                page_id: r.get(1)?,
                database_id: r.get(2)?,
                title: r.get(3)?,
                unique_id: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                values: Map::new(),
            })
        })?;
        for row in mapped {
            let row = row?;
            rows.insert(row.id.clone(), row);
        }
    }
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT record_id, property_id, value_json FROM db_value WHERE record_id IN ({marks})"
        ))?;
        let mapped = stmt.query_map(params_from_iter(ids.iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for v in mapped {
            let (rid, pid, json_text) = v?;
            if let (Some(row), Ok(value)) = (
                rows.get_mut(&rid),
                serde_json::from_str::<Value>(&json_text),
            ) {
                row.values.insert(pid, value);
            }
        }
    }
    let mut out: Vec<RecordRow> = ids.iter().filter_map(|id| rows.remove(id)).collect();
    relations::decorate(conn, &mut out)?;
    Ok(out)
}

fn record_row(conn: &Connection, record_id: &str) -> AppResult<RecordRow> {
    load_rows(conn, &[record_id.to_string()])?
        .into_iter()
        .next()
        .ok_or_else(|| not_found("record"))
}

fn record_info(conn: &Connection, record_id: &str) -> AppResult<(String, String, String)> {
    conn.query_row(
        "SELECT r.database_id, r.page_id, d.workspace_id FROM db_record r JOIN db_database d ON d.id = r.database_id WHERE r.id = ?1",
        [record_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()?
    .ok_or_else(|| not_found("record"))
}

fn index_value(
    conn: &Connection,
    ws: &str,
    page_id: &str,
    record_id: &str,
    prop: &Property,
    value: Option<&Value>,
) -> AppResult<()> {
    if !is_text_like(&prop.property_type) || prop.property_type == "title" {
        return Ok(());
    }
    match value.and_then(values::searchable_text) {
        Some(text) => {
            search::index::upsert_property_text(conn, ws, page_id, record_id, &prop.id, &text)
        }
        None => search::index::remove_property_text(conn, record_id, &prop.id),
    }
}

fn write_value(
    conn: &Connection,
    record_id: &str,
    prop: &Property,
    value: Option<&Value>,
) -> AppResult<()> {
    match value {
        Some(v) => conn.execute(
            "INSERT INTO db_value (record_id, property_id, value_json) VALUES (?1, ?2, ?3)
             ON CONFLICT(record_id, property_id) DO UPDATE SET value_json = excluded.value_json",
            params![record_id, prop.id, v.to_string()],
        )?,
        None => conn.execute(
            "DELETE FROM db_value WHERE record_id = ?1 AND property_id = ?2",
            params![record_id, prop.id],
        )?,
    };
    Ok(())
}

pub fn create_record(conn: &mut Connection, input: RecordCreate) -> AppResult<RecordRow> {
    let tx = conn.transaction()?;
    let out = create_record_in(&tx, input)?;
    tx.commit()?;
    Ok(out)
}

/// The body of [`create_record`], for callers that already hold a transaction.
pub(crate) fn create_record_in(tx: &Connection, input: RecordCreate) -> AppResult<RecordRow> {
    validate_id(&input.database_id, "database")?;
    let db = load_database(tx, &input.database_id)?;
    let template = match &input.template_id {
        Some(id) => Some(record_templates::load(tx, id, &db.id)?),
        None => None,
    };
    let title = match (input.title, &template) {
        (Some(t), _) if !t.is_empty() => t,
        (_, Some(t)) => t.info.title.clone(),
        _ => String::new(),
    };
    validate_title(&title)?;
    let db_page = repo::page::get(tx, &db.page_id)?
        .filter(|p| p.deleted_at.is_none())
        .ok_or_else(|| not_found("database"))?;
    let props = load_properties(tx, &db.id)?;
    let by_id: HashMap<&str, &Property> = props.iter().map(|p| (p.id.as_str(), p)).collect();

    // A template's values go first; ones that no longer fit the database are skipped.
    let mut merged = Map::new();
    if let Some(t) = &template {
        for (pid, v) in &t.info.values {
            if by_id.get(pid.as_str()).is_some_and(|p| {
                p.property_type != "title" && values::normalize_value(p, v).is_ok()
            }) {
                merged.insert(pid.clone(), v.clone());
            }
        }
    }
    for (pid, v) in &input.values {
        merged.insert(pid.clone(), v.clone());
    }
    let mut cells: Vec<(&Property, Option<Value>)> = Vec::new();
    for (pid, v) in &merged {
        let Some(prop) = by_id.get(pid.as_str()).copied() else {
            return bad("unknown property");
        };
        if prop.property_type == "title" {
            return bad("set the record's title with the title field");
        }
        cells.push((prop, values::normalize_value(prop, v)?));
    }

    let now_s = now();
    let unique_id = db.next_unique_id;
    tx.execute(
        "UPDATE db_database SET next_unique_id = next_unique_id + 1, updated_at = ?2 WHERE id = ?1",
        params![db.id, now_s],
    )?;
    let page = Page {
        id: new_id(),
        workspace_id: db.workspace_id.clone(),
        parent_page_id: Some(db_page.id.clone()),
        title,
        icon: None,
        cover: None,
        position: repo::page::next_position(tx, &db.workspace_id, Some(&db_page.id))?,
        favorite: false,
        archived: false,
        deleted_at: None,
        revision: 1,
        created_at: now_s.clone(),
        updated_at: now_s.clone(),
        child_count: 0,
        kind: "record".into(),
    };
    repo::page::insert(tx, &page)?;
    search::index::upsert_page(tx, &page)?;
    let record_id = new_id();
    tx.execute(
        "INSERT INTO db_record (id, database_id, page_id, unique_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![record_id, db.id, page.id, unique_id, now_s],
    )?;
    for (prop, v) in &cells {
        write_value(tx, &record_id, prop, v.as_ref())?;
        index_value(tx, &db.workspace_id, &page.id, &record_id, prop, v.as_ref())?;
    }
    if let Some(t) = &template {
        record_templates::apply_body(tx, &page.id, t)?;
    }
    let row = record_row(tx, &record_id)?;
    Ok(row)
}

pub fn set_value(conn: &mut Connection, input: SetValue) -> AppResult<RecordRow> {
    let tx = conn.transaction()?;
    let out = set_value_in(&tx, input)?;
    tx.commit()?;
    Ok(out)
}

const MAX_BULK: usize = 2000;

/// Sets one property to one value on many records in a single transaction: either every record is
/// updated or, if any one is refused (a value the property cannot hold), none is.
pub fn bulk_set_value(
    conn: &mut Connection,
    property_id: &str,
    record_ids: &[String],
    value: &Value,
) -> AppResult<Vec<RecordRow>> {
    let mut seen = std::collections::HashSet::new();
    let ids: Vec<&String> = record_ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    if ids.len() > MAX_BULK {
        return bad(format!("at most {MAX_BULK} records can be changed at once"));
    }
    let tx = conn.transaction()?;
    let mut rows = Vec::with_capacity(ids.len());
    for id in ids {
        rows.push(set_value_in(
            &tx,
            SetValue {
                record_id: id.clone(),
                property_id: property_id.to_string(),
                value: value.clone(),
            },
        )?);
    }
    tx.commit()?;
    Ok(rows)
}

/// The body of [`set_value`], for callers that already hold a transaction.
pub(crate) fn set_value_in(tx: &Connection, input: SetValue) -> AppResult<RecordRow> {
    validate_id(&input.record_id, "record")?;
    validate_id(&input.property_id, "property")?;
    let (database_id, page_id, ws) = record_info(tx, &input.record_id)?;
    let prop = load_property(tx, &input.property_id)?;
    if prop.database_id != database_id {
        return bad("that property belongs to another database");
    }
    let page = repo::page::get(tx, &page_id)?
        .filter(|p| p.deleted_at.is_none())
        .ok_or_else(|| not_found("record"))?;
    if prop.property_type == "title" {
        let title = input.value.as_str().unwrap_or("");
        validate_title(title)?;
        let mut page = page;
        page.title = title.to_string();
        page.updated_at = now();
        repo::page::update(tx, &page)?;
        search::index::upsert_page(tx, &page)?;
    } else if prop.property_type == "relation" {
        let ids: Vec<String> = match &input.value {
            Value::Null => Vec::new(),
            Value::Array(a) => a
                .iter()
                .map(|v| v.as_str().map(String::from))
                .collect::<Option<_>>()
                .ok_or_else(|| AppError::Validation("expected record ids".into()))?,
            _ => return bad("expected a list of records"),
        };
        relations::set_links(tx, &prop, &input.record_id, &ids)?;
        repo::page::touch_updated(tx, &page_id, &now())?;
    } else {
        let value = values::normalize_value(&prop, &input.value)?;
        write_value(tx, &input.record_id, &prop, value.as_ref())?;
        index_value(tx, &ws, &page_id, &input.record_id, &prop, value.as_ref())?;
        repo::page::touch_updated(tx, &page_id, &now())?;
    }
    let row = record_row(tx, &input.record_id)?;
    Ok(row)
}

fn copy_blocks(conn: &Connection, ws: &str, from_page: &str, to_page: &str) -> AppResult<()> {
    let blocks = repo::block::list(conn, from_page)?;
    let mut map: HashMap<String, String> = HashMap::new();
    let mut remaining: Vec<&Block> = blocks.iter().collect();
    while !remaining.is_empty() {
        let before = remaining.len();
        let mut deferred = Vec::new();
        for b in remaining {
            let parent = match &b.parent_block_id {
                None => None,
                Some(p) => match map.get(p) {
                    Some(np) => Some(np.clone()),
                    None => {
                        deferred.push(b);
                        continue;
                    }
                },
            };
            let copy = Block {
                id: new_id(),
                page_id: to_page.into(),
                parent_block_id: parent,
                revision: 1,
                ..b.clone()
            };
            repo::block::insert(conn, &copy)?;
            search::index::upsert_block(
                conn,
                ws,
                to_page,
                &copy.id,
                &copy.block_type,
                copy.schema_version,
                &copy.data_json,
            )?;
            map.insert(b.id.clone(), copy.id);
        }
        if deferred.len() == before {
            return Err(AppError::Internal("block hierarchy is inconsistent".into()));
        }
        remaining = deferred;
    }
    Ok(())
}

pub fn duplicate_record(conn: &mut Connection, record_id: &str) -> AppResult<RecordRow> {
    let tx = conn.transaction()?;
    let row = duplicate_record_in(&tx, record_id)?;
    tx.commit()?;
    Ok(row)
}

/// The body of [`duplicate_record`], for callers that already hold a transaction.
pub(crate) fn duplicate_record_in(tx: &Connection, record_id: &str) -> AppResult<RecordRow> {
    validate_id(record_id, "record")?;
    let (database_id, page_id, ws) = record_info(tx, record_id)?;
    let db = load_database(tx, &database_id)?;
    let src = repo::page::get(tx, &page_id)?
        .filter(|p| p.deleted_at.is_none())
        .ok_or_else(|| not_found("record"))?;
    let props = load_properties(tx, &database_id)?;
    let now_s = now();
    let unique_id = db.next_unique_id;
    tx.execute(
        "UPDATE db_database SET next_unique_id = next_unique_id + 1, updated_at = ?2 WHERE id = ?1",
        params![db.id, now_s],
    )?;
    let title: String = format!("{} (copy)", src.title.trim())
        .trim()
        .chars()
        .take(500)
        .collect();
    let page = Page {
        id: new_id(),
        title,
        position: repo::page::next_position(tx, &ws, src.parent_page_id.as_deref())?,
        revision: 1,
        created_at: now_s.clone(),
        updated_at: now_s.clone(),
        child_count: 0,
        favorite: false,
        ..src
    };
    repo::page::insert(tx, &page)?;
    search::index::upsert_page(tx, &page)?;
    let new_record = new_id();
    tx.execute(
        "INSERT INTO db_record (id, database_id, page_id, unique_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![new_record, database_id, page.id, unique_id, now_s],
    )?;
    tx.execute(
        "INSERT INTO db_value (record_id, property_id, value_json) SELECT ?1, property_id, value_json FROM db_value WHERE record_id = ?2",
        params![new_record, record_id],
    )?;
    for prop in &props {
        let v: Option<Value> = tx
            .query_row(
                "SELECT value_json FROM db_value WHERE record_id = ?1 AND property_id = ?2",
                params![new_record, prop.id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .and_then(|s| serde_json::from_str(&s).ok());
        index_value(tx, &ws, &page.id, &new_record, prop, v.as_ref())?;
    }
    copy_blocks(tx, &ws, &page_id, &page.id)?;
    let row = record_row(tx, &new_record)?;
    Ok(row)
}

pub fn record_detail(conn: &Connection, page_id: &str) -> AppResult<RecordDetail> {
    validate_id(page_id, "page")?;
    let record_id: String = conn
        .query_row(
            "SELECT id FROM db_record WHERE page_id = ?1",
            [page_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| not_found("record"))?;
    let record = record_row(conn, &record_id)?;
    let database = database_detail(conn, &record.database_id)?;
    Ok(RecordDetail { record, database })
}

pub fn query_records(conn: &Connection, input: &RecordQuery) -> AppResult<RecordPage> {
    validate_id(&input.database_id, "database")?;
    let db = load_database(conn, &input.database_id)?;
    let page = repo::page::get(conn, &db.page_id)?.filter(|p| p.deleted_at.is_none());
    if page.is_none() {
        return Err(not_found("database"));
    }
    let props = load_properties(conn, &db.id)?;
    let mut view = pick_view(conn, &db.id, input.view_id.as_deref())?;
    view.config.filter = and_filters(view.config.filter.take(), input.extra_filter.clone());
    let mut groups: Vec<GroupFilter> = Vec::new();
    if let (Some(key), Some(spec)) = (&input.group_key, &view.config.group) {
        groups.push(GroupFilter { spec, key });
    }
    if let (Some(key), Some(spec)) = (&input.subgroup_key, &view.config.subgroup) {
        groups.push(GroupFilter { spec, key });
    }
    if view.view_type == "feed" {
        view.config.sorts.clear();
    }
    calc::prepare(conn, &db.id, &calc::used_by(&props, &view.config))?;
    let mut built = query::build(
        &db.id,
        &props,
        &view.config,
        chrono::Local::now().date_naive(),
        &groups,
    )?;
    if view.view_type == "feed" {
        // A feed is a timeline of changes: newest first, whatever the saved sorts say.
        let stamp = if view.config.feed_order.as_deref() == Some("updated") {
            "p.updated_at"
        } else {
            "r.created_at"
        };
        built.order_sql = format!("{stamp} DESC, r.unique_id DESC");
        built.sort_columns.clear();
    }
    let offset = match input.cursor.as_deref() {
        None => 0,
        Some(c) => c
            .strip_prefix("o:")
            .and_then(|n| n.parse::<i64>().ok())
            .filter(|n| *n >= 0)
            .ok_or_else(|| AppError::Validation("invalid cursor".into()))?,
    };
    let limit = input
        .limit
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);

    // A date window adds a clause (and its parameters) after the view's own; it skips the count.
    let mut range_sql = String::new();
    if let Some(r) = &input.range {
        let prop = props
            .iter()
            .find(|p| p.id == r.property_id && p.property_type == "date")
            .ok_or_else(|| AppError::Validation("choose a date property".into()))?;
        for d in [&r.from, &r.to].into_iter().flatten() {
            if chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_err() {
                return bad("dates must be YYYY-MM-DD");
            }
        }
        built
            .params
            .push(rusqlite::types::Value::Text(prop.id.clone()));
        let n = built.params.len();
        let cell = format!(
            "(SELECT value_json FROM db_value WHERE record_id = r.id AND property_id = ?{n})"
        );
        let start = format!("json_extract({cell}, '$.start')");
        let end = format!("json_extract({cell}, '$.end')");
        range_sql = match (&r.from, &r.to) {
            (Some(from), Some(to)) => {
                built
                    .params
                    .push(rusqlite::types::Value::Text(from.clone()));
                built.params.push(rusqlite::types::Value::Text(to.clone()));
                let (f, t) = (built.params.len() - 1, built.params.len());
                format!(" AND {start} IS NOT NULL AND substr({start}, 1, 10) <= ?{t} AND COALESCE(substr({end}, 1, 10), substr({start}, 1, 10)) >= ?{f}")
            }
            _ => format!(" AND {start} IS NULL"),
        };
    }
    let predicate = format!(
        "WHERE r.database_id = ?1 AND p.deleted_at IS NULL AND {}{}",
        built.where_sql, range_sql
    );
    let from = "FROM db_record r JOIN page p ON p.id = r.page_id";
    let base = format!("{from} {predicate}");
    let needs_total = !input.skip_total && input.range.is_none();
    let shared_total = needs_total && !built.sort_columns.is_empty();
    let count = || -> AppResult<i64> {
        Ok(conn.query_row(
            &format!("SELECT COUNT(*) {base}"),
            params_from_iter(built.params[..built.where_params].iter()),
            |r| r.get(0),
        )?)
    };
    let mut total = if needs_total && !shared_total {
        Some(count()?)
    } else {
        None
    };
    let sql = if built.sort_columns.is_empty() {
        format!(
            "SELECT r.id {base} ORDER BY {} LIMIT {} OFFSET {offset}",
            built.order_sql,
            limit + 1
        )
    } else {
        // Reuse the filtered candidates for the total instead of evaluating every filter twice.
        let count_column = if shared_total {
            ", (SELECT COUNT(*) FROM candidates)"
        } else {
            ""
        };
        format!(
            "WITH candidates AS MATERIALIZED (SELECT r.id, r.unique_id, {} {base}) \
             SELECT r.id{count_column} FROM candidates r ORDER BY {} LIMIT {} OFFSET {offset}",
            built.sort_columns.join(", "),
            built.order_sql,
            limit + 1
        )
    };
    let mut stmt = conn.prepare(&sql)?;
    let mut result = stmt.query(params_from_iter(built.params.iter()))?;
    let mut ids = Vec::new();
    while let Some(row) = result.next()? {
        ids.push(row.get::<_, String>(0)?);
        if shared_total && total.is_none() {
            total = Some(row.get(1)?);
        }
    }
    // An empty or out-of-range page still reports the correct total.
    if shared_total && total.is_none() {
        total = Some(count()?);
    }
    let has_more = ids.len() as i64 > limit;
    ids.truncate(limit as usize);
    Ok(RecordPage {
        rows: load_rows(conn, &ids)?,
        total,
        next_cursor: has_more.then(|| format!("o:{}", offset + limit)),
    })
}

/// Checks a formula and shows its result on the first few records.
pub fn formula_preview(
    conn: &Connection,
    input: &FormulaPreviewInput,
) -> AppResult<FormulaPreview> {
    validate_id(&input.database_id, "database")?;
    load_database(conn, &input.database_id)?;
    let (p, properties) = calc::preview(
        conn,
        &input.database_id,
        input.property_id.as_deref(),
        &input.expression,
    )?;
    Ok(FormulaPreview {
        properties,
        result_type: p.result_type,
        error: p.error,
        samples: p
            .samples
            .into_iter()
            .map(|(title, value)| FormulaSample { title, value })
            .collect(),
    })
}

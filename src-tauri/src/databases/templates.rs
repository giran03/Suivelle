//! Project-management templates. A template is a recipe that builds ordinary databases, relations,
//! rollups, formulas and views inside one transaction, so a failure leaves nothing behind. There is
//! no separate task storage: the result can be renamed, extended or deleted like any other database.

use super::service::{
    add_property_in, create_database_in, create_record_in, create_view_in, load_properties,
    set_value_in, update_view_in,
};
use super::*;
use crate::domain::{new_id, now, validate_id, validate_title, Page};
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use crate::search;
use chrono::{Duration, NaiveDate};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub blurb: &'static str,
    /// The databases it creates, in order.
    pub databases: &'static [&'static str],
}

pub const TEMPLATES: &[TemplateInfo] = &[
    TemplateInfo {
        id: "project_manager",
        name: "Project Manager",
        blurb:
            "Projects, milestones, sprints and tasks with subtasks, dependencies and live progress.",
        databases: &["Projects", "Milestones", "Sprints", "Tasks"],
    },
    TemplateInfo {
        id: "task_tracker",
        name: "Task Tracker",
        blurb: "One Tasks database with subtasks, dependencies, a board, calendar and timeline.",
        databases: &["Tasks"],
    },
    TemplateInfo {
        id: "software_project",
        name: "Software Project",
        blurb: "The Project Manager setup with a task Type (feature, bug, chore) and a Bugs view.",
        databases: &["Projects", "Milestones", "Sprints", "Tasks"],
    },
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCreate {
    pub workspace_id: String,
    pub parent_page_id: Option<String>,
    pub template: String,
    /// Fill the databases with a few example records.
    #[serde(default = "yes")]
    pub sample_data: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateResult {
    /// The page that holds the new databases.
    pub page_id: String,
    pub database_page_ids: Vec<String>,
}

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

struct Db {
    id: String,
    page_id: String,
    props: HashMap<String, Property>,
}

impl Db {
    fn p(&self, name: &str) -> AppResult<&Property> {
        self.props.get(name).ok_or_else(|| {
            AppError::Internal(format!("template refers to missing property '{name}'"))
        })
    }
    fn id_of(&self, name: &str) -> AppResult<String> {
        Ok(self.p(name)?.id.clone())
    }
    fn option(&self, prop: &str, option: &str) -> AppResult<String> {
        self.p(prop)?
            .config
            .get("options")
            .and_then(Value::as_array)
            .and_then(|o| o.iter().find(|o| o["name"] == option))
            .and_then(|o| o["id"].as_str().map(String::from))
            .ok_or_else(|| {
                AppError::Internal(format!("template refers to missing option '{option}'"))
            })
    }
    fn refresh(&mut self, tx: &Connection) -> AppResult<()> {
        self.props = load_properties(tx, &self.id)?
            .into_iter()
            .map(|p| (p.name.clone(), p))
            .collect();
        Ok(())
    }
}

struct Builder<'a> {
    tx: &'a Connection,
    ws: String,
    root: String,
    today: NaiveDate,
    sample: bool,
}

fn options(list: &[(&str, &str, &str)]) -> Value {
    json!({ "options": list.iter().map(|(name, color, group)| {
        let mut o = json!({ "name": name, "color": color });
        if !group.is_empty() { o["group"] = json!(group); }
        o
    }).collect::<Vec<_>>() })
}

impl Builder<'_> {
    fn day(&self, offset: i64) -> String {
        (self.today + Duration::days(offset))
            .format("%Y-%m-%d")
            .to_string()
    }
    fn span(&self, from: i64, to: i64) -> Value {
        json!({ "start": self.day(from), "end": self.day(to) })
    }

    fn database(&self, title: &str) -> AppResult<Db> {
        let detail = create_database_in(
            self.tx,
            DatabaseCreate {
                workspace_id: self.ws.clone(),
                parent_page_id: Some(self.root.clone()),
                title: Some(title.into()),
            },
        )?;
        let mut db = Db {
            id: detail.database.id,
            page_id: detail.page.id,
            props: HashMap::new(),
        };
        db.refresh(self.tx)?;
        Ok(db)
    }

    fn prop(&self, db: &mut Db, name: &str, ptype: &str, config: Value) -> AppResult<()> {
        add_property_in(
            self.tx,
            PropertyCreate {
                database_id: db.id.clone(),
                name: name.into(),
                property_type: ptype.into(),
                config: Some(config),
            },
        )?;
        db.refresh(self.tx)
    }

    /// A two-way relation from `from` to `to`; the property on `to` is named `reverse`.
    fn relate(&self, from: &mut Db, name: &str, to: &mut Db, reverse: &str) -> AppResult<()> {
        self.prop(
            from,
            name,
            "relation",
            json!({ "targetDatabaseId": to.id, "twoWay": true, "reverseName": reverse }),
        )?;
        to.refresh(self.tx)
    }

    fn rollup(
        &self,
        db: &mut Db,
        name: &str,
        relation: &str,
        target: &Property,
        function: &str,
    ) -> AppResult<()> {
        let rel = db.id_of(relation)?;
        self.prop(db, name, "rollup", json!({ "relationPropertyId": rel, "targetPropertyId": target.id, "function": function }))
    }

    fn record(&self, db: &Db, title: &str, values: &[(&str, Value)]) -> AppResult<String> {
        let mut map = Map::new();
        for (name, v) in values {
            map.insert(db.id_of(name)?, v.clone());
        }
        let row = create_record_in(
            self.tx,
            RecordCreate {
                template_id: None,
                database_id: db.id.clone(),
                title: Some(title.into()),
                values: map,
            },
        )?;
        Ok(row.id)
    }

    fn link(&self, db: &Db, record: &str, property: &str, to: &[&String]) -> AppResult<()> {
        set_value_in(
            self.tx,
            SetValue {
                record_id: record.into(),
                property_id: db.id_of(property)?,
                value: json!(to),
            },
        )?;
        Ok(())
    }

    /// Adds a view and lets `f` shape its configuration. `show` lists the property names whose
    /// columns (or card fields) are visible; the title always is.
    fn view(
        &self,
        db: &Db,
        vtype: &str,
        name: &str,
        show: &[&str],
        f: impl FnOnce(&mut ViewConfig) -> AppResult<()>,
    ) -> AppResult<()> {
        let props = load_properties(self.tx, &db.id)?;
        let columns = props
            .iter()
            .map(|p| ViewColumn {
                property_id: p.id.clone(),
                width: None,
                hidden: p.property_type != "title" && !show.contains(&p.name.as_str()),
            })
            .collect();
        let mut cfg = ViewConfig {
            columns,
            ..Default::default()
        };
        f(&mut cfg)?;
        create_view_in(
            self.tx,
            ViewCreate {
                database_id: db.id.clone(),
                name: Some(name.into()),
                view_type: vtype.into(),
                config: Some(cfg),
            },
        )?;
        Ok(())
    }

    /// Renames the database's first (table) view and chooses its columns and sort.
    fn table(
        &self,
        db: &Db,
        name: &str,
        show: &[&str],
        sort: Option<(&str, &str)>,
    ) -> AppResult<()> {
        let first = load_views_of(self.tx, &db.id)?;
        let mut cfg = first.config.clone();
        for c in &mut cfg.columns {
            let p = db.props.values().find(|p| p.id == c.property_id);
            c.hidden =
                p.is_some_and(|p| p.property_type != "title" && !show.contains(&p.name.as_str()));
        }
        if let Some((prop, dir)) = sort {
            cfg.sorts = vec![ViewSort {
                property_id: db.id_of(prop)?,
                direction: dir.into(),
            }];
        }
        update_view_in(
            self.tx,
            ViewUpdate {
                view_id: first.id,
                name: Some(name.into()),
                config: cfg,
            },
        )?;
        Ok(())
    }
}

fn load_views_of(tx: &Connection, database_id: &str) -> AppResult<DbView> {
    super::service::load_views(tx, database_id)?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Internal("a database always has a view".into()))
}

fn leaf(prop: &Property, op: &str, value: Value) -> FilterNode {
    FilterNode::Leaf {
        property_id: prop.id.clone(),
        operator: op.into(),
        value,
    }
}

fn group_by(p: &Property) -> GroupSpec {
    GroupSpec {
        property_id: p.id.clone(),
        bucket: None,
    }
}

fn sort(p: &Property, dir: &str) -> ViewSort {
    ViewSort {
        property_id: p.id.clone(),
        direction: dir.into(),
    }
}

// ---------------------------------------------------------------------------------------------
// the recipes
// ---------------------------------------------------------------------------------------------

const TASK_STATUSES: [(&str, &str, &str); 5] = [
    ("Backlog", "gray", "todo"),
    ("To do", "violet", "todo"),
    ("In progress", "blue", "doing"),
    ("Blocked", "red", "doing"),
    ("Done", "green", "done"),
];
const PRIORITIES: [(&str, &str, &str); 4] = [
    ("Urgent", "red", ""),
    ("High", "orange", ""),
    ("Medium", "violet", ""),
    ("Low", "gray", ""),
];

/// The Tasks database: subtasks, dependencies and progress, plus whatever `extra` adds.
fn tasks_database(b: &Builder, software: bool) -> AppResult<Db> {
    let mut t = b.database("Tasks")?;
    b.prop(&mut t, "Status", "status", options(&TASK_STATUSES))?;
    b.prop(&mut t, "Priority", "select", options(&PRIORITIES))?;
    if software {
        b.prop(
            &mut t,
            "Type",
            "select",
            options(&[
                ("Feature", "violet", ""),
                ("Bug", "red", ""),
                ("Chore", "gray", ""),
            ]),
        )?;
    }
    b.prop(&mut t, "Dates", "date", json!({}))?;
    Ok(t)
}

/// Subtask, dependency and progress properties, added once the other databases exist.
fn task_structure(b: &Builder, t: &mut Db) -> AppResult<()> {
    let me = t.id.clone();
    b.prop(
        t,
        "Parent",
        "relation",
        json!({ "targetDatabaseId": me, "twoWay": true, "reverseName": "Subtasks" }),
    )?;
    b.prop(
        t,
        "Blocked by",
        "relation",
        json!({ "targetDatabaseId": me, "twoWay": true, "reverseName": "Blocking" }),
    )?;
    let status = t.p("Status")?.clone();
    b.rollup(t, "Subtask progress", "Subtasks", &status, "percent_done")?;
    b.rollup(t, "Blockers done", "Blocked by", &status, "percent_done")?;
    b.prop(
        t,
        "Blocked",
        "formula",
        json!({ "expression": "length(prop(\"Blocked by\")) > 0 && prop(\"Blockers done\") < 100" }),
    )?;
    Ok(())
}

fn task_views(b: &Builder, t: &Db, planning: bool, software: bool) -> AppResult<()> {
    let status = t.p("Status")?.clone();
    let priority = t.p("Priority")?.clone();
    let done = t.option("Status", "Done")?;
    let mut cards: Vec<&str> = vec!["Status", "Priority", "Dates", "Blocked", "Subtask progress"];
    if planning {
        cards.push("Project");
    }
    let mut all: Vec<&str> = vec![
        "Status",
        "Priority",
        "Dates",
        "Parent",
        "Blocked by",
        "Blocked",
        "Subtask progress",
        "Tags",
    ];
    if planning {
        all.splice(3..3, ["Project", "Milestone", "Sprint"]);
    }
    if software {
        all.insert(2, "Type");
    }
    b.table(t, "All tasks", &all, Some(("Priority", "asc")))?;
    let (status2, priority2) = (status.clone(), priority.clone());
    b.view(t, "board", "Board", &cards, move |c| {
        c.group = Some(group_by(&status2));
        c.sorts = vec![sort(&priority2, "asc")];
        Ok(())
    })?;
    if planning {
        let sprint = t.p("Sprint")?.clone();
        let (s, d, p) = (status.clone(), done.clone(), priority.clone());
        b.view(
            t,
            "list",
            "Backlog",
            &["Status", "Priority", "Project"],
            move |c| {
                c.filter = Some(FilterNode::Group {
                    op: "and".into(),
                    children: vec![
                        leaf(&sprint, "is_empty", Value::Null),
                        leaf(&s, "!=", json!(d)),
                    ],
                });
                c.sorts = vec![sort(&p, "asc")];
                Ok(())
            },
        )?;
        let sprint = t.p("Sprint")?.clone();
        let (s, p) = (status.clone(), priority.clone());
        b.view(t, "board", "Current sprint", &cards, move |c| {
            c.filter = Some(leaf(&sprint, "is_not_empty", Value::Null));
            c.group = Some(group_by(&s));
            c.sorts = vec![sort(&p, "asc")];
            Ok(())
        })?;
    }
    let dates = t.id_of("Dates")?;
    for (kind, name) in [("calendar", "Calendar"), ("timeline", "Timeline")] {
        let d = dates.clone();
        b.view(t, kind, name, &["Status", "Priority"], move |c| {
            c.date_property_id = Some(d);
            Ok(())
        })?;
    }
    if software {
        let ty = t.p("Type")?.clone();
        let bug = t.option("Type", "Bug")?;
        let (s, d, p) = (status.clone(), done, priority);
        b.view(
            t,
            "table",
            "Bugs",
            &["Status", "Priority", "Type", "Dates"],
            move |c| {
                c.filter = Some(FilterNode::Group {
                    op: "and".into(),
                    children: vec![leaf(&ty, "=", json!(bug)), leaf(&s, "!=", json!(d))],
                });
                c.sorts = vec![sort(&p, "asc")];
                Ok(())
            },
        )?;
    }
    Ok(())
}

fn build_task_tracker(b: &Builder) -> AppResult<Vec<String>> {
    let mut t = tasks_database(b, false)?;
    task_structure(b, &mut t)?;
    task_views(b, &t, false, false)?;
    if b.sample {
        let status = |n: &str| t.option("Status", n).map(|id| json!(id));
        let pri = |n: &str| t.option("Priority", n).map(|id| json!(id));
        let design = b.record(
            &t,
            "Plan the week",
            &[
                ("Status", status("In progress")?),
                ("Priority", pri("High")?),
                ("Dates", b.span(-1, 3)),
            ],
        )?;
        let a = b.record(
            &t,
            "Book the venue",
            &[
                ("Status", status("Done")?),
                ("Priority", pri("Medium")?),
                ("Dates", b.span(-4, -2)),
            ],
        )?;
        let c = b.record(
            &t,
            "Send invitations",
            &[
                ("Status", status("To do")?),
                ("Priority", pri("High")?),
                ("Dates", b.span(2, 4)),
            ],
        )?;
        let d = b.record(
            &t,
            "Order catering",
            &[
                ("Status", status("To do")?),
                ("Priority", pri("Medium")?),
                ("Dates", b.span(3, 6)),
            ],
        )?;
        b.record(
            &t,
            "Ideas for later",
            &[("Status", status("Backlog")?), ("Priority", pri("Low")?)],
        )?;
        b.link(&t, &a, "Parent", &[&design])?;
        b.link(&t, &c, "Parent", &[&design])?;
        b.link(&t, &c, "Blocked by", &[&a])?;
        b.link(&t, &d, "Blocked by", &[&c])?;
    }
    Ok(vec![t.page_id])
}

fn build_project_manager(b: &Builder, software: bool) -> AppResult<Vec<String>> {
    // Projects, milestones and sprints first, so tasks can relate to them.
    let mut projects = b.database("Projects")?;
    b.prop(
        &mut projects,
        "Status",
        "status",
        options(&[
            ("Planning", "gray", "todo"),
            ("Active", "blue", "doing"),
            ("On hold", "orange", "doing"),
            ("Done", "green", "done"),
        ]),
    )?;
    b.prop(&mut projects, "Owner", "text", json!({}))?;
    b.prop(&mut projects, "Dates", "date", json!({}))?;

    let mut milestones = b.database("Milestones")?;
    b.prop(
        &mut milestones,
        "Status",
        "status",
        options(&[
            ("Not started", "gray", "todo"),
            ("In progress", "blue", "doing"),
            ("Done", "green", "done"),
        ]),
    )?;
    b.prop(&mut milestones, "Due", "date", json!({}))?;

    let mut sprints = b.database("Sprints")?;
    b.prop(
        &mut sprints,
        "Status",
        "status",
        options(&[
            ("Planned", "gray", "todo"),
            ("Active", "blue", "doing"),
            ("Done", "green", "done"),
        ]),
    )?;
    b.prop(&mut sprints, "Dates", "date", json!({}))?;

    let mut tasks = tasks_database(b, software)?;
    b.relate(&mut milestones, "Project", &mut projects, "Milestones")?;
    b.relate(&mut tasks, "Project", &mut projects, "Tasks")?;
    // Durable IDs for palette task creation, independent of database/property names.
    let workspace =
        repo::workspace::get(b.tx, &b.ws)?.ok_or_else(|| AppError::NotFound("workspace".into()))?;
    let mut settings: Value =
        serde_json::from_str(&workspace.settings_json).unwrap_or_else(|_| json!({}));
    if !settings.is_object() {
        settings = json!({});
    }
    let mut ids = settings
        .get("projectTaskRelationIds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    ids.push(json!(tasks.id_of("Project")?));
    settings["projectTaskRelationIds"] = json!(ids);
    b.tx.execute(
        "UPDATE workspace SET settings_json = ?2 WHERE id = ?1",
        rusqlite::params![b.ws, settings.to_string()],
    )?;
    b.relate(&mut tasks, "Milestone", &mut milestones, "Tasks")?;
    b.relate(&mut tasks, "Sprint", &mut sprints, "Tasks")?;
    task_structure(b, &mut tasks)?;
    for d in [&mut projects, &mut milestones, &mut sprints] {
        d.refresh(b.tx)?;
    }

    // Progress: the share of linked tasks whose status is in the Done group.
    let task_status = tasks.p("Status")?.clone();
    for d in [&mut projects, &mut milestones, &mut sprints] {
        b.rollup(d, "Progress", "Tasks", &task_status, "percent_done")?;
    }

    // views
    let pstatus = projects.p("Status")?.clone();
    b.table(
        &projects,
        "All projects",
        &["Status", "Owner", "Dates", "Progress", "Milestones", "Tags"],
        None,
    )?;
    b.view(
        &projects,
        "board",
        "Board",
        &["Owner", "Dates", "Progress"],
        |c| {
            c.group = Some(group_by(&pstatus));
            Ok(())
        },
    )?;
    let pd = projects.id_of("Dates")?;
    b.view(
        &projects,
        "timeline",
        "Timeline",
        &["Status", "Progress"],
        |c| {
            c.date_property_id = Some(pd);
            Ok(())
        },
    )?;

    b.table(
        &milestones,
        "All milestones",
        &["Project", "Status", "Due", "Progress"],
        Some(("Due", "asc")),
    )?;
    let md = milestones.id_of("Due")?;
    b.view(
        &milestones,
        "calendar",
        "Calendar",
        &["Project", "Progress"],
        |c| {
            c.date_property_id = Some(md);
            Ok(())
        },
    )?;

    b.table(
        &sprints,
        "All sprints",
        &["Status", "Dates", "Progress"],
        Some(("Dates", "desc")),
    )?;
    let sd = sprints.id_of("Dates")?;
    b.view(
        &sprints,
        "timeline",
        "Timeline",
        &["Status", "Progress"],
        |c| {
            c.date_property_id = Some(sd);
            Ok(())
        },
    )?;

    task_views(b, &tasks, true, software)?;

    if b.sample {
        sample_project_data(b, &projects, &milestones, &sprints, &tasks, software)?;
    }
    Ok(vec![
        projects.page_id,
        milestones.page_id,
        sprints.page_id,
        tasks.page_id,
    ])
}

fn sample_project_data(
    b: &Builder,
    projects: &Db,
    milestones: &Db,
    sprints: &Db,
    tasks: &Db,
    software: bool,
) -> AppResult<()> {
    let pstat = |n: &str| projects.option("Status", n).map(|id| json!(id));
    let web = b.record(
        projects,
        "Website relaunch",
        &[("Status", pstat("Active")?), ("Dates", b.span(-14, 30))],
    )?;
    let app = b.record(
        projects,
        "Mobile app",
        &[("Status", pstat("Planning")?), ("Dates", b.span(7, 60))],
    )?;

    let mstat = |n: &str| milestones.option("Status", n).map(|id| json!(id));
    let m_design = b.record(
        milestones,
        "Design complete",
        &[
            ("Status", mstat("In progress")?),
            ("Due", json!({ "start": b.day(5) })),
        ],
    )?;
    let m_launch = b.record(
        milestones,
        "Launch",
        &[
            ("Status", mstat("Not started")?),
            ("Due", json!({ "start": b.day(28) })),
        ],
    )?;
    let m_proto = b.record(
        milestones,
        "Prototype",
        &[
            ("Status", mstat("Not started")?),
            ("Due", json!({ "start": b.day(30) })),
        ],
    )?;
    b.link(milestones, &m_design, "Project", &[&web])?;
    b.link(milestones, &m_launch, "Project", &[&web])?;
    b.link(milestones, &m_proto, "Project", &[&app])?;

    let sstat = |n: &str| sprints.option("Status", n).map(|id| json!(id));
    let s1 = b.record(
        sprints,
        "Sprint 1",
        &[("Status", sstat("Active")?), ("Dates", b.span(-3, 10))],
    )?;
    let s2 = b.record(
        sprints,
        "Sprint 2",
        &[("Status", sstat("Planned")?), ("Dates", b.span(11, 24))],
    )?;

    let st = |n: &str| tasks.option("Status", n).map(|id| json!(id));
    let pr = |n: &str| tasks.option("Priority", n).map(|id| json!(id));
    let ty = |n: &str| tasks.option("Type", n).map(|id| json!(id));
    let mk = |title: &str,
              status: &str,
              priority: &str,
              dates: Option<Value>,
              kind: &str|
     -> AppResult<String> {
        let mut v = vec![("Status", st(status)?), ("Priority", pr(priority)?)];
        if let Some(d) = dates {
            v.push(("Dates", d));
        }
        if software {
            v.push(("Type", ty(kind)?));
        }
        b.record(tasks, title, &v)
    };
    let t_struct = mk(
        "Define site structure",
        "Done",
        "High",
        Some(b.span(-10, -6)),
        "Chore",
    )?;
    let t_home = mk(
        "Design homepage",
        "In progress",
        "High",
        Some(b.span(-3, 3)),
        "Feature",
    )?;
    let t_article = mk(
        "Design article page",
        "To do",
        "Medium",
        Some(b.span(2, 5)),
        "Feature",
    )?;
    let t_hero = mk(
        "Hero section",
        "Done",
        "Medium",
        Some(b.span(-3, -1)),
        "Feature",
    )?;
    let t_nav = mk(
        "Navigation",
        "In progress",
        "Medium",
        Some(b.span(-1, 2)),
        "Feature",
    )?;
    let t_tpl = mk(
        "Build page templates",
        "To do",
        "High",
        Some(b.span(6, 12)),
        "Feature",
    )?;
    let t_copy = mk("Write launch copy", "Backlog", "Low", None, "Chore")?;
    let t_stats = mk("Set up analytics", "Backlog", "Medium", None, "Chore")?;
    let t_flows = mk(
        "Sketch app flows",
        "To do",
        "High",
        Some(b.span(8, 14)),
        "Feature",
    )?;
    let t_stack = mk("Pick tech stack", "Backlog", "Medium", None, "Chore")?;
    let t_bug = if software {
        Some(mk(
            "Fix broken navigation link",
            "To do",
            "Urgent",
            Some(b.span(0, 1)),
            "Bug",
        )?)
    } else {
        None
    };

    for id in [
        &t_struct, &t_home, &t_article, &t_hero, &t_nav, &t_tpl, &t_copy, &t_stats,
    ] {
        b.link(tasks, id, "Project", &[&web])?;
    }
    for id in [&t_flows, &t_stack] {
        b.link(tasks, id, "Project", &[&app])?;
    }
    for id in [&t_struct, &t_home, &t_article, &t_hero, &t_nav] {
        b.link(tasks, id, "Milestone", &[&m_design])?;
    }
    for id in [&t_tpl, &t_copy] {
        b.link(tasks, id, "Milestone", &[&m_launch])?;
    }
    b.link(tasks, &t_flows, "Milestone", &[&m_proto])?;
    for id in [&t_struct, &t_home, &t_article, &t_hero, &t_nav] {
        b.link(tasks, id, "Sprint", &[&s1])?;
    }
    for id in [&t_tpl, &t_flows] {
        b.link(tasks, id, "Sprint", &[&s2])?;
    }
    b.link(tasks, &t_hero, "Parent", &[&t_home])?;
    b.link(tasks, &t_nav, "Parent", &[&t_home])?;
    b.link(tasks, &t_tpl, "Blocked by", &[&t_home, &t_article])?;
    b.link(tasks, &t_article, "Blocked by", &[&t_struct])?;
    if let Some(bug) = t_bug {
        b.link(tasks, &bug, "Project", &[&web])?;
        b.link(tasks, &bug, "Sprint", &[&s1])?;
    }
    Ok(())
}

pub fn create_from_template(
    conn: &mut Connection,
    input: TemplateCreate,
) -> AppResult<TemplateResult> {
    validate_id(&input.workspace_id, "workspace")?;
    if let Some(p) = &input.parent_page_id {
        validate_id(p, "parent page")?;
    }
    let Some(info) = TEMPLATES.iter().find(|t| t.id == input.template) else {
        return bad(format!("unknown template '{}'", input.template));
    };
    validate_title(info.name)?;
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
    let now_s = now();
    let root = Page {
        id: new_id(),
        workspace_id: input.workspace_id.clone(),
        parent_page_id: input.parent_page_id.clone(),
        title: info.name.into(),
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
        created_at: now_s.clone(),
        updated_at: now_s,
        child_count: 0,
        kind: "page".into(),
    };
    repo::page::insert(&tx, &root)?;
    search::index::upsert_page(&tx, &root)?;

    let b = Builder {
        tx: &tx,
        ws: input.workspace_id.clone(),
        root: root.id.clone(),
        today: chrono::Local::now().date_naive(),
        sample: input.sample_data,
    };
    let database_page_ids = match info.id {
        "task_tracker" => build_task_tracker(&b)?,
        "project_manager" => build_project_manager(&b, false)?,
        _ => build_project_manager(&b, true)?,
    };
    tx.commit()?;
    Ok(TemplateResult {
        page_id: root.id,
        database_page_ids,
    })
}

// ---------------------------------------------------------------------------------------------
// agent hub
// ---------------------------------------------------------------------------------------------

pub const MEMORY_KINDS: [(&str, &str, &str); 6] = [
    ("Fact", "blue", ""),
    ("Decision", "violet", ""),
    ("Preference", "green", ""),
    ("Feedback", "orange", ""),
    ("Project", "blue", ""),
    ("Reference", "gray", ""),
];
pub const MEMORY_STATUSES: [(&str, &str, &str); 4] = [
    ("Active", "green", ""),
    ("Superseded", "gray", ""),
    ("Expired", "gray", ""),
    ("Disputed", "orange", ""),
];
pub const AGENT_TASK_STATUSES: [(&str, &str, &str); 5] = [
    ("Queued", "gray", ""),
    ("In progress", "blue", ""),
    ("Review", "violet", ""),
    ("Done", "green", ""),
    ("Failed", "red", ""),
];

/// The Memory and Agent tasks databases under `root`. Returns their database ids.
pub(crate) fn build_agent_hub(
    tx: &Connection,
    workspace_id: &str,
    root: &str,
) -> AppResult<(String, String)> {
    let b = Builder {
        tx,
        ws: workspace_id.into(),
        root: root.into(),
        today: chrono::Local::now().date_naive(),
        sample: false,
    };
    let mut m = b.database("Memory")?;
    b.prop(&mut m, "Kind", "select", options(&MEMORY_KINDS))?;
    b.prop(&mut m, "Status", "select", options(&MEMORY_STATUSES))?;
    b.prop(
        &mut m,
        "Confidence",
        "select",
        options(&[
            ("Stated", "blue", ""),
            ("Inferred", "gray", ""),
            ("Verified", "green", ""),
        ]),
    )?;
    b.prop(&mut m, "Scope", "text", json!({}))?;
    b.prop(&mut m, "Source", "text", json!({}))?;
    b.prop(&mut m, "Expires", "date", json!({}))?;
    let me = m.id.clone();
    b.prop(
        &mut m,
        "Supersedes",
        "relation",
        json!({ "targetDatabaseId": me, "twoWay": true, "reverseName": "Superseded by" }),
    )?;
    b.table(
        &m,
        "All memories",
        &["Kind", "Status", "Confidence", "Scope", "Source", "Expires"],
        None,
    )?;
    let status = m.p("Status")?.clone();
    let active = m.option("Status", "Active")?;
    b.view(
        &m,
        "board",
        "By kind",
        &["Status", "Scope", "Source"],
        |c| {
            c.group = Some(group_by(m.p("Kind")?));
            c.filter = Some(leaf(&status, "=", json!(active)));
            Ok(())
        },
    )?;

    let mut t = b.database("Agent tasks")?;
    b.prop(&mut t, "Status", "select", options(&AGENT_TASK_STATUSES))?;
    b.prop(&mut t, "Agent", "text", json!({}))?;
    b.prop(&mut t, "Claimed by", "text", json!({}))?;
    b.prop(&mut t, "Lease until", "text", json!({}))?;
    b.prop(&mut t, "Attempts", "number", json!({}))?;
    b.prop(&mut t, "Due", "date", json!({}))?;
    b.prop(&mut t, "Source", "text", json!({}))?;
    // "block:<id>" when the task was promoted from a to-do; finishing the task checks it.
    b.prop(&mut t, "Origin", "text", json!({}))?;
    b.table(
        &t,
        "All tasks",
        &["Status", "Agent", "Claimed by", "Due", "Attempts", "Source"],
        None,
    )?;
    b.view(&t, "board", "Board", &["Agent", "Due", "Claimed by"], |c| {
        c.group = Some(group_by(t.p("Status")?));
        Ok(())
    })?;
    Ok((m.id, t.id))
}

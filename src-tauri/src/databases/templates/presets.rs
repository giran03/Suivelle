//! Everyday starters. Each one is a plain description (properties, sample rows, views) that the
//! shared `Builder` turns into an ordinary database, so the result can be changed like any other.
//! The two-database starter (Goals & OKRs) is written out by hand because it needs a relation.

use super::*;

/// A sample value. Options are given by name and looked up on the property.
enum S {
    T(&'static str),
    N(f64),
    /// A day, as days from today.
    D(i64),
    O(&'static str),
    M(&'static [&'static str]),
    C(bool),
}

type Row = (&'static str, Vec<(&'static str, S)>);

enum V {
    Table {
        name: &'static str,
        show: &'static [&'static str],
        sort: Option<(&'static str, &'static str)>,
        /// Totals row: (property, summary).
        totals: &'static [(&'static str, &'static str)],
    },
    Board { name: &'static str, group: &'static str, show: &'static [&'static str] },
    Gallery { name: &'static str, show: &'static [&'static str] },
    Calendar { name: &'static str, date: &'static str, show: &'static [&'static str] },
    List {
        name: &'static str,
        show: &'static [&'static str],
        /// Keep records whose option property equals the named option.
        only: Option<(&'static str, &'static str)>,
        sort: Option<(&'static str, &'static str)>,
    },
    Chart {
        name: &'static str,
        kind: &'static str,
        x: &'static str,
        y: Option<&'static str>,
        aggregation: &'static str,
        bucket: Option<&'static str>,
    },
}

struct Preset {
    title: &'static str,
    props: Vec<(&'static str, &'static str, Value)>,
    rows: Vec<Row>,
    /// The first view must be a table: it is the database's own first view, renamed.
    views: Vec<V>,
}

fn value(b: &Builder, db: &Db, prop: &str, s: &S) -> AppResult<Value> {
    Ok(match s {
        S::T(t) => json!(t),
        S::N(n) => json!(n),
        S::D(o) => json!({ "start": b.day(*o) }),
        S::C(c) => json!(c),
        S::O(name) => json!(db.option(prop, name)?),
        S::M(names) => json!(names
            .iter()
            .map(|n| db.option(prop, n))
            .collect::<AppResult<Vec<_>>>()?),
    })
}

fn views(b: &Builder, db: &Db, list: &[V]) -> AppResult<()> {
    for (i, v) in list.iter().enumerate() {
        match v {
            V::Table { name, show, sort, totals } => {
                if i != 0 {
                    return Err(AppError::Internal("a table view must come first".into()));
                }
                b.table(db, name, show, *sort)?;
                if !totals.is_empty() {
                    let first = load_views_of(b.tx, &db.id)?;
                    let mut cfg = first.config.clone();
                    for (prop, how) in *totals {
                        let id = db.id_of(prop)?;
                        for c in cfg.columns.iter_mut().filter(|c| c.property_id == id) {
                            c.aggregate = Some((*how).into());
                        }
                    }
                    update_view_in(
                        b.tx,
                        ViewUpdate { view_id: first.id, name: None, config: cfg },
                    )?;
                }
            }
            V::Board { name, group, show } => {
                let g = db.p(group)?.clone();
                b.view(db, "board", name, show, move |c| {
                    c.group = Some(group_by(&g));
                    Ok(())
                })?;
            }
            V::Gallery { name, show } => b.view(db, "gallery", name, show, |_| Ok(()))?,
            V::Calendar { name, date, show } => {
                let d = db.id_of(date)?;
                b.view(db, "calendar", name, show, move |c| {
                    c.date_property_id = Some(d);
                    Ok(())
                })?;
            }
            V::List { name, show, only, sort: by } => {
                let filter = match only {
                    Some((prop, option)) => {
                        Some(leaf(db.p(prop)?, "=", json!(db.option(prop, option)?)))
                    }
                    None => None,
                };
                let s = match by {
                    Some((prop, dir)) => Some(sort(db.p(prop)?, dir)),
                    None => None,
                };
                b.view(db, "list", name, show, move |c| {
                    c.filter = filter;
                    c.sorts = s.into_iter().collect();
                    Ok(())
                })?;
            }
            V::Chart { name, kind, x, y, aggregation, bucket } => {
                let spec = ChartSpec {
                    chart_type: (*kind).into(),
                    x_property_id: Some(db.id_of(x)?),
                    bucket: bucket.map(String::from),
                    y_property_id: match y {
                        Some(y) => Some(db.id_of(y)?),
                        None => None,
                    },
                    aggregation: (*aggregation).into(),
                    group_property_id: None,
                    sort: if *kind == "line" || *kind == "area" { "x" } else { "value_desc" }.into(),
                };
                b.view(db, "chart", name, &[], move |c| {
                    c.chart = Some(spec);
                    Ok(())
                })?;
            }
        }
    }
    Ok(())
}

fn build(b: &Builder, p: &Preset) -> AppResult<Vec<String>> {
    let mut db = b.database(p.title)?;
    for (name, ptype, config) in &p.props {
        b.prop(&mut db, name, ptype, config.clone())?;
    }
    views(b, &db, &p.views)?;
    if b.sample {
        for (title, cells) in &p.rows {
            let mut values = Vec::new();
            for (prop, s) in cells {
                values.push((*prop, value(b, &db, prop, s)?));
            }
            b.record(&db, title, &values)?;
        }
    }
    Ok(vec![db.page_id])
}

pub const PRESETS: &[TemplateInfo] = &[
    TemplateInfo {
        id: "reading_list",
        name: "Reading List",
        blurb: "Books to read, reading and finished, with ratings, genres and a shelf gallery.",
        databases: &["Books"],
    },
    TemplateInfo {
        id: "crm",
        name: "Contacts & Deals",
        blurb: "A light CRM: people, companies, deal stage and value, last contact and a pipeline board.",
        databases: &["Contacts"],
    },
    TemplateInfo {
        id: "content_calendar",
        name: "Content Calendar",
        blurb: "Plan posts and articles by channel and publish date, with a calendar and a board.",
        databases: &["Content"],
    },
    TemplateInfo {
        id: "expense_tracker",
        name: "Expense Tracker",
        blurb: "Spending by category and month, with a totals row and a chart.",
        databases: &["Expenses"],
    },
    TemplateInfo {
        id: "job_search",
        name: "Job Search",
        blurb: "Applications from wishlist to offer, with salary, contacts and follow-up dates.",
        databases: &["Applications"],
    },
    TemplateInfo {
        id: "inventory",
        name: "Inventory",
        blurb: "Stock with quantity, price, reorder level and a calculated stock value and low-stock flag.",
        databases: &["Inventory"],
    },
    TemplateInfo {
        id: "recipes",
        name: "Recipe Book",
        blurb: "Recipes with cuisine, meal, time and rating, plus a gallery and a quick-meals list.",
        databases: &["Recipes"],
    },
    TemplateInfo {
        id: "meeting_notes",
        name: "Meeting Notes",
        blurb: "Meetings by type and date with attendees and a follow-up status, on a calendar.",
        databases: &["Meetings"],
    },
    TemplateInfo {
        id: "habit_tracker",
        name: "Habit Tracker",
        blurb: "A daily log of habits with a done checkbox, streak-friendly views and a weekly chart.",
        databases: &["Habit log"],
    },
    TemplateInfo {
        id: "goals_okrs",
        name: "Goals & OKRs",
        blurb: "Objectives with key results; each objective's progress is the average of its key results.",
        databases: &["Objectives", "Key results"],
    },
];

pub fn build_preset(b: &Builder, id: &str) -> AppResult<Vec<String>> {
    match id {
        "goals_okrs" => goals(b),
        _ => build(b, &spec(id)?),
    }
}

fn spec(id: &str) -> AppResult<Preset> {
    let text = |name: &'static str| (name, "text", json!({}));
    let date = |name: &'static str| (name, "date", json!({}));
    let number = |name: &'static str| (name, "number", json!({}));
    Ok(match id {
        "reading_list" => Preset {
            title: "Books",
            props: vec![
                ("Status", "status", options(&[("Want to read", "gray", "todo"), ("Reading", "blue", "doing"), ("Finished", "green", "done"), ("Abandoned", "red", "done")])),
                text("Author"),
                ("Genre", "multi_select", options(&[("Fiction", "violet", ""), ("Non-fiction", "blue", ""), ("Science", "green", ""), ("History", "orange", ""), ("Biography", "gray", "")])),
                number("Pages"),
                number("Rating"),
                date("Finished on"),
            ],
            rows: vec![
                ("The Left Hand of Darkness", vec![("Status", S::O("Finished")), ("Author", S::T("Ursula K. Le Guin")), ("Genre", S::M(&["Fiction"])), ("Pages", S::N(304.0)), ("Rating", S::N(5.0)), ("Finished on", S::D(-20))]),
                ("A Short History of Nearly Everything", vec![("Status", S::O("Reading")), ("Author", S::T("Bill Bryson")), ("Genre", S::M(&["Science", "History"])), ("Pages", S::N(544.0))]),
                ("Educated", vec![("Status", S::O("Finished")), ("Author", S::T("Tara Westover")), ("Genre", S::M(&["Biography"])), ("Pages", S::N(352.0)), ("Rating", S::N(4.0)), ("Finished on", S::D(-60))]),
                ("Sapiens", vec![("Status", S::O("Want to read")), ("Author", S::T("Yuval Noah Harari")), ("Genre", S::M(&["Non-fiction", "History"])), ("Pages", S::N(498.0))]),
            ],
            views: vec![
                V::Table { name: "All books", show: &["Status", "Author", "Genre", "Pages", "Rating", "Finished on"], sort: Some(("Status", "asc")), totals: &[("Pages", "sum"), ("Rating", "average")] },
                V::Board { name: "Shelf", group: "Status", show: &["Author", "Rating"] },
                V::Gallery { name: "Gallery", show: &["Author", "Rating"] },
                V::Chart { name: "Finished by month", kind: "bar", x: "Finished on", y: None, aggregation: "count", bucket: Some("month") },
            ],
        },
        "crm" => Preset {
            title: "Contacts",
            props: vec![
                ("Stage", "status", options(&[("Lead", "gray", "todo"), ("Contacted", "violet", "doing"), ("Proposal", "blue", "doing"), ("Won", "green", "done"), ("Lost", "red", "done")])),
                text("Company"),
                ("Email", "email", json!({})),
                ("Phone", "phone", json!({})),
                number("Deal value"),
                date("Last contacted"),
                date("Follow up"),
            ],
            rows: vec![
                ("Ada Lovelace", vec![("Stage", S::O("Proposal")), ("Company", S::T("Analytical Engines")), ("Email", S::T("ada@example.com")), ("Deal value", S::N(12000.0)), ("Last contacted", S::D(-3)), ("Follow up", S::D(4))]),
                ("Grace Hopper", vec![("Stage", S::O("Contacted")), ("Company", S::T("Compiler Co")), ("Email", S::T("grace@example.com")), ("Deal value", S::N(5400.0)), ("Last contacted", S::D(-8)), ("Follow up", S::D(2))]),
                ("Alan Turing", vec![("Stage", S::O("Won")), ("Company", S::T("Bletchley Labs")), ("Email", S::T("alan@example.com")), ("Deal value", S::N(30000.0)), ("Last contacted", S::D(-14))]),
                ("Katherine Johnson", vec![("Stage", S::O("Lead")), ("Company", S::T("Orbit Dynamics")), ("Email", S::T("katherine@example.com"))]),
            ],
            views: vec![
                V::Table { name: "All contacts", show: &["Stage", "Company", "Email", "Phone", "Deal value", "Last contacted", "Follow up"], sort: Some(("Last contacted", "desc")), totals: &[("Deal value", "sum")] },
                V::Board { name: "Pipeline", group: "Stage", show: &["Company", "Deal value", "Follow up"] },
                V::Calendar { name: "Follow-ups", date: "Follow up", show: &["Stage", "Company"] },
            ],
        },
        "content_calendar" => Preset {
            title: "Content",
            props: vec![
                ("Status", "status", options(&[("Idea", "gray", "todo"), ("Drafting", "blue", "doing"), ("Review", "violet", "doing"), ("Scheduled", "orange", "doing"), ("Published", "green", "done")])),
                ("Channel", "select", options(&[("Blog", "blue", ""), ("Newsletter", "violet", ""), ("Social", "orange", ""), ("Video", "red", "")])),
                text("Author"),
                date("Publish date"),
                ("Link", "url", json!({})),
            ],
            rows: vec![
                ("Launch announcement", vec![("Status", S::O("Scheduled")), ("Channel", S::O("Blog")), ("Author", S::T("Sam")), ("Publish date", S::D(3))]),
                ("Monthly newsletter", vec![("Status", S::O("Drafting")), ("Channel", S::O("Newsletter")), ("Author", S::T("Jo")), ("Publish date", S::D(7))]),
                ("Behind the scenes reel", vec![("Status", S::O("Idea")), ("Channel", S::O("Video")), ("Author", S::T("Sam"))]),
                ("Tips thread", vec![("Status", S::O("Published")), ("Channel", S::O("Social")), ("Author", S::T("Jo")), ("Publish date", S::D(-2))]),
            ],
            views: vec![
                V::Table { name: "All content", show: &["Status", "Channel", "Author", "Publish date", "Link"], sort: Some(("Publish date", "asc")), totals: &[] },
                V::Calendar { name: "Calendar", date: "Publish date", show: &["Status", "Channel"] },
                V::Board { name: "Pipeline", group: "Status", show: &["Channel", "Publish date"] },
                V::Chart { name: "By channel", kind: "donut", x: "Channel", y: None, aggregation: "count", bucket: None },
            ],
        },
        "expense_tracker" => Preset {
            title: "Expenses",
            props: vec![
                number("Amount"),
                ("Category", "select", options(&[("Housing", "blue", ""), ("Food", "green", ""), ("Transport", "orange", ""), ("Fun", "violet", ""), ("Health", "red", ""), ("Other", "gray", "")])),
                date("Date"),
                ("Paid with", "select", options(&[("Card", "violet", ""), ("Cash", "green", ""), ("Bank transfer", "blue", "")])),
                text("Note"),
            ],
            rows: vec![
                ("Rent", vec![("Amount", S::N(950.0)), ("Category", S::O("Housing")), ("Date", S::D(-12)), ("Paid with", S::O("Bank transfer"))]),
                ("Groceries", vec![("Amount", S::N(86.4)), ("Category", S::O("Food")), ("Date", S::D(-5)), ("Paid with", S::O("Card"))]),
                ("Train pass", vec![("Amount", S::N(54.0)), ("Category", S::O("Transport")), ("Date", S::D(-3)), ("Paid with", S::O("Card"))]),
                ("Cinema", vec![("Amount", S::N(22.0)), ("Category", S::O("Fun")), ("Date", S::D(-1)), ("Paid with", S::O("Cash"))]),
                ("Pharmacy", vec![("Amount", S::N(17.8)), ("Category", S::O("Health")), ("Date", S::D(0)), ("Paid with", S::O("Card"))]),
            ],
            views: vec![
                V::Table { name: "All expenses", show: &["Amount", "Category", "Date", "Paid with", "Note"], sort: Some(("Date", "desc")), totals: &[("Amount", "sum")] },
                V::Chart { name: "By category", kind: "donut", x: "Category", y: Some("Amount"), aggregation: "sum", bucket: None },
                V::Chart { name: "By month", kind: "bar", x: "Date", y: Some("Amount"), aggregation: "sum", bucket: Some("month") },
            ],
        },
        "job_search" => Preset {
            title: "Applications",
            props: vec![
                ("Stage", "status", options(&[("Wishlist", "gray", "todo"), ("Applied", "blue", "doing"), ("Interview", "violet", "doing"), ("Offer", "green", "done"), ("Rejected", "red", "done")])),
                text("Company"),
                ("Link", "url", json!({})),
                number("Salary"),
                date("Applied on"),
                date("Follow up"),
                text("Contact"),
            ],
            rows: vec![
                ("Frontend engineer", vec![("Stage", S::O("Interview")), ("Company", S::T("Northwind")), ("Salary", S::N(68000.0)), ("Applied on", S::D(-10)), ("Follow up", S::D(2)), ("Contact", S::T("Priya, recruiter"))]),
                ("Product designer", vec![("Stage", S::O("Applied")), ("Company", S::T("Fabrikam")), ("Salary", S::N(62000.0)), ("Applied on", S::D(-4)), ("Follow up", S::D(5))]),
                ("Data analyst", vec![("Stage", S::O("Wishlist")), ("Company", S::T("Contoso"))]),
                ("Support engineer", vec![("Stage", S::O("Rejected")), ("Company", S::T("Tailspin")), ("Applied on", S::D(-25))]),
            ],
            views: vec![
                V::Table { name: "All applications", show: &["Stage", "Company", "Salary", "Applied on", "Follow up", "Contact", "Link"], sort: Some(("Applied on", "desc")), totals: &[] },
                V::Board { name: "Pipeline", group: "Stage", show: &["Company", "Salary", "Follow up"] },
                V::Calendar { name: "Follow-ups", date: "Follow up", show: &["Stage", "Company"] },
            ],
        },
        "inventory" => Preset {
            title: "Inventory",
            props: vec![
                text("SKU"),
                ("Category", "select", options(&[("Hardware", "blue", ""), ("Supplies", "green", ""), ("Packaging", "orange", ""), ("Other", "gray", "")])),
                number("Quantity"),
                number("Reorder level"),
                number("Unit price"),
                ("Stock value", "formula", json!({ "expression": "prop(\"Quantity\") * prop(\"Unit price\")" })),
                ("Low stock", "formula", json!({ "expression": "prop(\"Quantity\") <= prop(\"Reorder level\")" })),
            ],
            rows: vec![
                ("Mounting bracket", vec![("SKU", S::T("HW-001")), ("Category", S::O("Hardware")), ("Quantity", S::N(120.0)), ("Reorder level", S::N(40.0)), ("Unit price", S::N(2.5))]),
                ("Shipping box (M)", vec![("SKU", S::T("PK-014")), ("Category", S::O("Packaging")), ("Quantity", S::N(18.0)), ("Reorder level", S::N(25.0)), ("Unit price", S::N(0.8))]),
                ("Label roll", vec![("SKU", S::T("SP-203")), ("Category", S::O("Supplies")), ("Quantity", S::N(60.0)), ("Reorder level", S::N(20.0)), ("Unit price", S::N(6.9))]),
            ],
            views: vec![
                V::Table { name: "All items", show: &["SKU", "Category", "Quantity", "Reorder level", "Unit price", "Stock value", "Low stock"], sort: Some(("Category", "asc")), totals: &[("Quantity", "sum"), ("Stock value", "sum")] },
                V::Board { name: "By category", group: "Category", show: &["Quantity", "Low stock"] },
                V::Chart { name: "Stock value by category", kind: "bar", x: "Category", y: Some("Stock value"), aggregation: "sum", bucket: None },
            ],
        },
        "recipes" => Preset {
            title: "Recipes",
            props: vec![
                ("Meal", "select", options(&[("Breakfast", "orange", ""), ("Lunch", "green", ""), ("Dinner", "blue", ""), ("Dessert", "violet", "")])),
                ("Cuisine", "select", options(&[("Italian", "green", ""), ("Asian", "red", ""), ("Mexican", "orange", ""), ("Home", "gray", "")])),
                number("Minutes"),
                number("Servings"),
                number("Rating"),
                ("Favourite", "checkbox", json!({})),
                ("Source", "url", json!({})),
            ],
            rows: vec![
                ("Tomato basil pasta", vec![("Meal", S::O("Dinner")), ("Cuisine", S::O("Italian")), ("Minutes", S::N(25.0)), ("Servings", S::N(2.0)), ("Rating", S::N(5.0)), ("Favourite", S::C(true))]),
                ("Veggie stir-fry", vec![("Meal", S::O("Dinner")), ("Cuisine", S::O("Asian")), ("Minutes", S::N(20.0)), ("Servings", S::N(3.0)), ("Rating", S::N(4.0))]),
                ("Overnight oats", vec![("Meal", S::O("Breakfast")), ("Cuisine", S::O("Home")), ("Minutes", S::N(5.0)), ("Servings", S::N(1.0)), ("Rating", S::N(4.0))]),
                ("Tacos al pastor", vec![("Meal", S::O("Lunch")), ("Cuisine", S::O("Mexican")), ("Minutes", S::N(45.0)), ("Servings", S::N(4.0)), ("Rating", S::N(5.0)), ("Favourite", S::C(true))]),
            ],
            views: vec![
                V::Table { name: "All recipes", show: &["Meal", "Cuisine", "Minutes", "Servings", "Rating", "Favourite", "Source"], sort: Some(("Rating", "desc")), totals: &[] },
                V::Gallery { name: "Gallery", show: &["Meal", "Minutes", "Rating"] },
                V::Board { name: "By meal", group: "Meal", show: &["Cuisine", "Minutes"] },
            ],
        },
        "meeting_notes" => Preset {
            title: "Meetings",
            props: vec![
                date("Date"),
                ("Type", "select", options(&[("One-on-one", "violet", ""), ("Team", "blue", ""), ("Client", "orange", ""), ("Planning", "green", "")])),
                text("Attendees"),
                ("Follow-up", "status", options(&[("None", "gray", "todo"), ("Needed", "orange", "doing"), ("Done", "green", "done")])),
            ],
            rows: vec![
                ("Weekly sync", vec![("Date", S::D(-2)), ("Type", S::O("Team")), ("Attendees", S::T("Sam, Jo, Priya")), ("Follow-up", S::O("Done"))]),
                ("Client check-in", vec![("Date", S::D(1)), ("Type", S::O("Client")), ("Attendees", S::T("Sam, Ada")), ("Follow-up", S::O("None"))]),
                ("Quarter planning", vec![("Date", S::D(6)), ("Type", S::O("Planning")), ("Attendees", S::T("Everyone")), ("Follow-up", S::O("Needed"))]),
            ],
            views: vec![
                V::Table { name: "All meetings", show: &["Date", "Type", "Attendees", "Follow-up"], sort: Some(("Date", "desc")), totals: &[] },
                V::Calendar { name: "Calendar", date: "Date", show: &["Type", "Follow-up"] },
                V::List { name: "Needs follow-up", show: &["Date", "Type"], only: Some(("Follow-up", "Needed")), sort: Some(("Date", "asc")) },
            ],
        },
        "habit_tracker" => Preset {
            title: "Habit log",
            props: vec![
                date("Date"),
                ("Habit", "select", options(&[("Exercise", "red", ""), ("Read", "blue", ""), ("Meditate", "violet", ""), ("Water", "green", "")])),
                ("Done", "checkbox", json!({})),
                number("Minutes"),
            ],
            rows: vec![
                ("Morning run", vec![("Date", S::D(0)), ("Habit", S::O("Exercise")), ("Done", S::C(true)), ("Minutes", S::N(30.0))]),
                ("Twenty pages", vec![("Date", S::D(0)), ("Habit", S::O("Read")), ("Done", S::C(true)), ("Minutes", S::N(25.0))]),
                ("Evening sit", vec![("Date", S::D(-1)), ("Habit", S::O("Meditate")), ("Done", S::C(false))]),
                ("Morning run", vec![("Date", S::D(-1)), ("Habit", S::O("Exercise")), ("Done", S::C(true)), ("Minutes", S::N(35.0))]),
                ("Two litres", vec![("Date", S::D(-2)), ("Habit", S::O("Water")), ("Done", S::C(true))]),
            ],
            views: vec![
                V::Table { name: "Log", show: &["Date", "Habit", "Done", "Minutes"], sort: Some(("Date", "desc")), totals: &[("Done", "percent_checked"), ("Minutes", "sum")] },
                V::Calendar { name: "Calendar", date: "Date", show: &["Habit", "Done"] },
                V::Chart { name: "Minutes per week", kind: "bar", x: "Date", y: Some("Minutes"), aggregation: "sum", bucket: Some("week") },
            ],
        },
        _ => return Err(AppError::Internal(format!("no preset '{id}'"))),
    })
}

/// Objectives and their key results. Progress rolls up as the average of the key results.
fn goals(b: &Builder) -> AppResult<Vec<String>> {
    let mut objectives = b.database("Objectives")?;
    let mut results = b.database("Key results")?;
    b.prop(&mut objectives, "Status", "status", options(&[("Not started", "gray", "todo"), ("On track", "green", "doing"), ("At risk", "orange", "doing"), ("Done", "blue", "done")]))?;
    b.prop(&mut objectives, "Quarter", "select", options(&[("Q1", "gray", ""), ("Q2", "gray", ""), ("Q3", "gray", ""), ("Q4", "gray", "")]))?;
    b.prop(&mut results, "Progress", "number", json!({}))?;
    b.prop(&mut results, "Target", "number", json!({}))?;
    b.prop(&mut results, "Owner", "text", json!({}))?;
    b.relate(&mut results, "Objective", &mut objectives, "Key results")?;
    let progress = results.p("Progress")?.clone();
    b.rollup(&mut objectives, "Progress", "Key results", &progress, "average")?;

    b.table(&objectives, "All objectives", &["Status", "Quarter", "Key results", "Progress"], Some(("Status", "asc")))?;
    let status = objectives.p("Status")?.clone();
    b.view(&objectives, "board", "By status", &["Quarter", "Progress"], move |c| {
        c.group = Some(group_by(&status));
        Ok(())
    })?;
    b.table(&results, "All key results", &["Objective", "Progress", "Target", "Owner"], Some(("Progress", "desc")))?;

    if b.sample {
        let status = |n: &str| objectives.option("Status", n).map(|id| json!(id));
        let quarter = |n: &str| objectives.option("Quarter", n).map(|id| json!(id));
        let grow = b.record(&objectives, "Grow the newsletter", &[("Status", status("On track")?), ("Quarter", quarter("Q1")?)])?;
        let ship = b.record(&objectives, "Ship the 1.0 release", &[("Status", status("At risk")?), ("Quarter", quarter("Q1")?)])?;
        for (title, objective, done, target, owner) in [
            ("Reach 2,000 subscribers", &grow, 55.0, 100.0, "Jo"),
            ("Publish 12 issues", &grow, 75.0, 100.0, "Sam"),
            ("Close all blocker bugs", &ship, 30.0, 100.0, "Priya"),
            ("Finish the migration guide", &ship, 60.0, 100.0, "Sam"),
        ] {
            let r = b.record(&results, title, &[("Progress", json!(done)), ("Target", json!(target)), ("Owner", json!(owner))])?;
            b.link(&results, &r, "Objective", &[objective])?;
        }
    }
    Ok(vec![objectives.page_id, results.page_id])
}

//! Calendars are views over ordinary pages. Event schedules are typed blocks, never duplicated
//! into view configuration. This keeps content in existing history, trash and archive paths.
use crate::{
    domain::*,
    errors::{AppError, AppResult},
    repositories as repo, search,
};
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub page_id: String,
    pub block_id: Option<String>,
    #[serde(default)]
    pub label: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repeat {
    pub frequency: String,
    pub interval: u32,
    #[serde(default)]
    pub days: Vec<u32>,
    pub until: Option<String>,
    pub count: Option<u32>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exception {
    pub date: String,
    #[serde(default)]
    pub cancelled: bool,
    pub start: Option<String>,
    pub end: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    #[serde(default)]
    pub imported_description: Option<String>,
    #[serde(default)]
    pub follow_source_title: bool,
    pub calendar_id: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub all_day: bool,
    pub timezone: String,
    pub recurrence: Option<Repeat>,
    #[serde(default)]
    pub exceptions: Vec<Exception>,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub reminders: Vec<i64>,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub completed: bool,
    #[serde(default = "busy")]
    pub busy: bool,
    /// An explicit `#RRGGBB` color for this event; absent means the view picks one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}
fn busy() -> bool {
    true
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub notes: String,
    pub page_id: String,
    pub block_id: String,
    pub revision: i64,
    pub title: String,
    pub data: Schedule,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub id: String,
    pub page_id: String,
    pub original_date: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub collections: Vec<Page>,
    pub events: Vec<Event>,
    pub occurrences: Vec<Occurrence>,
    pub truncated: bool,
    pub invalid: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    pub workspace_id: String,
    pub page_id: Option<String>,
    pub revision: Option<i64>,
    pub title: String,
    pub data: Schedule,
    pub split_date: Option<String>,
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn date(s: &str) -> AppResult<NaiveDate> {
    let d = NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| invalid("choose a valid calendar date"))?;
    if d.to_string() != s {
        return Err(invalid("use a date in YYYY-MM-DD format"));
    }
    Ok(d)
}
fn local(s: &str, all_day: bool) -> AppResult<NaiveDateTime> {
    if all_day {
        return Ok(date(s)?.and_hms_opt(0, 0, 0).unwrap());
    }
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M")
        .map_err(|_| invalid("choose a valid date and time"))
}
fn instant(time: NaiveDateTime, zone: Tz) -> AppResult<chrono::DateTime<Utc>> {
    zone.from_local_datetime(&time)
        .single()
        .map(|t| t.with_timezone(&Utc))
        .ok_or_else(|| {
            invalid("this time is missing or ambiguous in the chosen timezone; choose another time")
        })
}
pub fn validate(data: &Schedule) -> AppResult<()> {
    validate_id(&data.calendar_id, "calendar")?;
    let zone: Tz = data
        .timezone
        .parse()
        .map_err(|_| invalid("choose an IANA timezone, such as Asia/Manila"))?;
    let start = local(&data.start, data.all_day)?;
    let end = local(&data.end, data.all_day)?;
    if end <= start || end - start > Duration::days(366) {
        return Err(invalid(
            "the end must follow the start and be within one year",
        ));
    }
    if !data.all_day {
        instant(start, zone)?;
        instant(end, zone)?;
    }
    if let Some(color) = &data.color {
        let hex = color.strip_prefix('#').unwrap_or("");
        if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(invalid("choose an event color as #RRGGBB"));
        }
    }
    if data.location.chars().count() > 1000
        || data.links.len() > 64
        || data.reminders.len() > 8
        || data.exceptions.len() > 1000
    {
        return Err(invalid("this event has too much metadata"));
    }
    for l in &data.links {
        validate_id(&l.page_id, "linked page")?;
        if let Some(id) = &l.block_id {
            validate_id(id, "linked block")?;
        }
        if l.label.chars().count() > 500 {
            return Err(invalid("keep link labels under 500 characters"));
        }
    }
    if data.reminders.iter().any(|n| *n < 0 || *n > 43200) {
        return Err(invalid(
            "reminders must be between zero and 30 days before the event",
        ));
    }
    if let Some(r) = &data.recurrence {
        if !["daily", "weekly", "monthly", "yearly"].contains(&r.frequency.as_str())
            || !(1..=99).contains(&r.interval)
            || r.days.len() > 7
            || r.days.iter().any(|n| *n > 6)
            || r.count.is_some_and(|n| n == 0 || n > 10000)
        {
            return Err(invalid("invalid recurrence rule"));
        }
        if let Some(until) = &r.until {
            if date(until)? < start.date() {
                return Err(invalid("recurrence must end on or after its start"));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    for x in &data.exceptions {
        date(&x.date)?;
        if !seen.insert(&x.date) {
            return Err(invalid("an occurrence has more than one exception"));
        }
        if data.recurrence.is_none()
            || date(&x.date)? < start.date()
            || !matching(
                date(&x.date)?,
                start.date(),
                data.recurrence.as_ref().unwrap(),
            )
        {
            return Err(invalid(
                "an exception must refer to a date in its recurring series",
            ));
        }
        if x.start.is_some() != x.end.is_some() {
            return Err(invalid("rescheduled occurrences need both start and end"));
        }
        let r = data.recurrence.as_ref().unwrap();
        let target = date(&x.date)?;
        if r.until.as_ref().is_some_and(|until| x.date > *until) {
            return Err(invalid("an exception must precede the series end"));
        }
        if let Some(limit) = r.count {
            if (target - start.date()).num_days() > 36600 {
                return Err(invalid("finite series are limited to 100 years"));
            }
            let mut current = start.date();
            let mut ordinal = 0;
            while current <= target {
                if matching(current, start.date(), r) {
                    ordinal += 1;
                }
                current += Duration::days(1);
            }
            if ordinal > limit {
                return Err(invalid("an exception exceeds the series occurrence count"));
            }
        }
        if let (Some(a), Some(b)) = (&x.start, &x.end) {
            let a = local(a, data.all_day)?;
            let b = local(b, data.all_day)?;
            if b <= a {
                return Err(invalid("an occurrence must end after it starts"));
            }
            if !data.all_day {
                instant(a, zone)?;
                instant(b, zone)?;
            }
        }
    }
    Ok(())
}
pub fn validate_block(kind: &str, text: &str) -> AppResult<()> {
    if kind == "calendar_event" {
        let data: Schedule =
            serde_json::from_str(text).map_err(|_| invalid("invalid event schedule"))?;
        validate(&data)?;
    }
    Ok(())
}
fn require_page(conn: &Connection, id: &str, workspace: &str) -> AppResult<Page> {
    repo::page::get(conn, id)?
        .filter(|p| p.workspace_id == workspace && p.deleted_at.is_none())
        .ok_or_else(|| invalid("the calendar or page is unavailable in this workspace"))
}
fn insert_page(
    conn: &Connection,
    workspace: &str,
    parent: Option<String>,
    title: &str,
) -> AppResult<Page> {
    validate_id(workspace, "workspace")?;
    validate_title(title)?;
    if repo::workspace::get(conn, workspace)?.is_none() {
        return Err(invalid("workspace not found"));
    }
    let stamp = now();
    let p = Page {
        id: new_id(),
        workspace_id: workspace.into(),
        parent_page_id: parent.clone(),
        title: title.into(),
        icon: Some("icon:calendar".into()),
        cover: None,
        position: repo::page::next_position(conn, workspace, parent.as_deref())?,
        favorite: false,
        archived: false,
        deleted_at: None,
        revision: 1,
        created_at: stamp.clone(),
        updated_at: stamp,
        child_count: 0,
        kind: "page".into(),
    };
    repo::page::insert(conn, &p)?;
    search::index::upsert_page(conn, &p)?;
    Ok(p)
}
fn insert_block(conn: &Connection, page: &Page, kind: &str, data: Value) -> AppResult<Block> {
    let stamp = now();
    let b = Block {
        id: new_id(),
        page_id: page.id.clone(),
        parent_block_id: None,
        block_type: kind.into(),
        position: 0.,
        data_json: data.to_string(),
        schema_version: BLOCK_SCHEMA_VERSION,
        revision: 1,
        created_at: stamp.clone(),
        updated_at: stamp,
    };
    repo::block::insert(conn, &b)?;
    search::index::upsert_block(
        conn,
        &page.workspace_id,
        &page.id,
        &b.id,
        kind,
        BLOCK_SCHEMA_VERSION,
        &b.data_json,
    )?;
    Ok(b)
}
pub fn create_collection(conn: &mut Connection, workspace: &str, title: &str) -> AppResult<Page> {
    let tx = conn.transaction()?;
    let p = insert_page(&tx, workspace, None, title)?;
    tx.execute(
        "INSERT INTO calendar_collection(page_id,workspace_id) VALUES(?1,?2)",
        params![p.id, workspace],
    )?;
    insert_block(
        &tx,
        &p,
        "calendar",
        json!({"isCollection":true,"calendarId":p.id,"sources":[{"kind":"calendar","pageId":p.id}],"view":"dayGridMonth"}),
    )?;
    tx.commit()?;
    Ok(p)
}
pub fn save(conn: &mut Connection, input: Save) -> AppResult<Event> {
    save_with_template(conn, input, None)
}
pub fn save_with_template(
    conn: &mut Connection,
    input: Save,
    template_id: Option<String>,
) -> AppResult<Event> {
    let tx = conn.transaction()?;
    if template_id.is_some() && input.page_id.is_some() {
        return Err(invalid("apply a notes template when creating a new event"));
    }
    let workspace = input.workspace_id.clone();
    let result = save_in(&tx, input)?;
    if let Some(id) = template_id {
        let template = require_page(&tx, &id, &workspace)?;
        if template.kind != "page" {
            return Err(invalid("choose an ordinary page template"));
        }
        let blocks = repo::block::list(&tx, &id)?
            .into_iter()
            .filter(|b| b.block_type != "calendar_event")
            .collect::<Vec<_>>();
        let ids = blocks
            .iter()
            .map(|b| (b.id.clone(), new_id()))
            .collect::<std::collections::HashMap<_, _>>();
        let upserts = blocks
            .iter()
            .enumerate()
            .map(|(i, b)| BlockUpsert {
                id: ids[&b.id].clone(),
                parent_block_id: b
                    .parent_block_id
                    .as_ref()
                    .and_then(|id| ids.get(id).cloned()),
                block_type: b.block_type.clone(),
                position: i as f64 + 1.,
                data_json: if b.block_type == "calendar" {
                    let mut data: Value = serde_json::from_str(&b.data_json).unwrap_or(json!({}));
                    data["isCollection"] = json!(false);
                    data.to_string()
                } else {
                    b.data_json.clone()
                },
                schema_version: b.schema_version,
            })
            .collect();
        crate::services::block::apply_batch_in(
            &tx,
            &BlockBatch {
                page_id: result.page_id.clone(),
                upserts,
                delete_ids: vec![],
            },
        )?;
    }
    tx.commit()?;
    Ok(result)
}
pub fn import(conn: &mut Connection, workspace: &str, events: Vec<Save>) -> AppResult<Vec<Event>> {
    if events.len() > 1000 {
        return Err(invalid("import at most 1,000 events at a time"));
    }
    let tx = conn.transaction()?;
    let mut saved = Vec::new();
    for event in events {
        if event.workspace_id != workspace || event.page_id.is_some() || event.split_date.is_some()
        {
            return Err(invalid(
                "calendar imports must create new events in the selected workspace",
            ));
        }
        saved.push(save_in(&tx, event)?);
    }
    tx.commit()?;
    Ok(saved)
}
fn save_in(tx: &Connection, mut input: Save) -> AppResult<Event> {
    let description = input.data.imported_description.take();
    validate(&input.data)?;
    validate_title(&input.title)?;
    if let Some(split) = input.split_date.take() {
        let cutoff = date(&split)?;
        let id = input
            .page_id
            .as_ref()
            .ok_or_else(|| invalid("choose a series to split"))?;
        let p = require_page(tx, id, &input.workspace_id)?;
        let block = repo::block::list(tx, id)?
            .into_iter()
            .find(|b| b.block_type == "calendar_event")
            .ok_or_else(|| invalid("series not found"))?;
        if input.revision != Some(block.revision) {
            return Err(invalid(
                "this series changed elsewhere; reload before saving",
            ));
        }
        let mut old: Schedule =
            serde_json::from_str(&block.data_json).map_err(|_| invalid("invalid series"))?;
        let base = local(&old.start, old.all_day)?.date();
        if cutoff <= base {
            return Err(invalid(
                "edit the entire series when changing its first occurrence",
            ));
        }
        let repeat = old
            .recurrence
            .as_mut()
            .ok_or_else(|| invalid("this event is not recurring"))?;
        let elapsed = (cutoff - base).num_days();
        if elapsed > 36600 {
            return Err(invalid(
                "split recurring series within 100 years of its start",
            ));
        }
        let mut d = base;
        let mut before = 0;
        while d < cutoff {
            if matching(d, base, repeat) {
                before += 1;
            }
            d += Duration::days(1);
        }
        if let (Some(count), Some(new_rule)) = (repeat.count, input.data.recurrence.as_mut()) {
            new_rule.count = Some(count.saturating_sub(before));
        }
        repeat.until = Some((cutoff - Duration::days(1)).to_string());
        old.exceptions.retain(|x| x.date < split);
        save_in(
            tx,
            Save {
                workspace_id: input.workspace_id.clone(),
                page_id: Some(p.id),
                revision: Some(block.revision),
                title: p.title,
                data: old,
                split_date: None,
            },
        )?;
        input.page_id = None;
        input.revision = None;
        input.data.exceptions.retain(|x| x.date >= split);
        validate(&input.data)?;
    }
    let calendar = require_page(tx, &input.data.calendar_id, &input.workspace_id)?;
    if calendar.kind != "page"
        || !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM calendar_collection WHERE page_id=?1 AND workspace_id=?2)",
            params![calendar.id, input.workspace_id],
            |r| r.get::<_, bool>(0),
        )?
    {
        return Err(invalid("choose a calendar collection"));
    }
    for link in &input.data.links {
        if let Some(p) = repo::page::get(tx, &link.page_id)? {
            if p.workspace_id != input.workspace_id {
                return Err(invalid("calendar links must stay in their workspace"));
            }
        }
        if let Some(id) = &link.block_id {
            if let Some(b) = repo::block::get(tx, id)? {
                if b.page_id != link.page_id {
                    return Err(invalid("the linked block belongs to another page"));
                }
            }
        }
    }
    let (mut p, mut b) = if let Some(id) = &input.page_id {
        let p = require_page(tx, id, &input.workspace_id)?;
        let b = repo::block::list(tx, id)?
            .into_iter()
            .find(|b| b.block_type == "calendar_event")
            .ok_or_else(|| invalid("event not found"))?;
        if input.revision != Some(b.revision) {
            return Err(invalid(
                "this event changed elsewhere; reload before saving",
            ));
        }
        (p, b)
    } else {
        let p = insert_page(
            tx,
            &input.workspace_id,
            Some(calendar.id.clone()),
            &input.title,
        )?;
        let b = insert_block(
            tx,
            &p,
            "calendar_event",
            serde_json::to_value(&input.data).unwrap(),
        )?;
        (p, b)
    };
    if input.page_id.is_some() {
        crate::history::snapshot(tx, &p.id, "auto")?;
        b.data_json = serde_json::to_string(&input.data).unwrap();
        b.updated_at = now();
        repo::block::update(tx, &b)?;
        b.revision += 1;
        p.title = input.title.clone();
        p.parent_page_id = Some(calendar.id);
        p.updated_at = now();
        repo::page::update(tx, &p)?;
        search::index::upsert_page(tx, &p)?;
        search::index::upsert_block(
            tx,
            &p.workspace_id,
            &p.id,
            &b.id,
            "calendar_event",
            BLOCK_SCHEMA_VERSION,
            &b.data_json,
        )?;
    }
    if input.page_id.is_none() {
        if let Some(text) = description.filter(|s| !s.is_empty()) {
            if text.chars().count() > 20000 {
                return Err(invalid(
                    "keep imported descriptions under 20,000 characters",
                ));
            }
            let mut note = insert_block(
                tx,
                &p,
                "paragraph",
                json!({"content":[{"type":"text","text":text}]}),
            )?;
            note.position = 1.;
            repo::block::update(tx, &note)?;
        }
    }
    Ok(Event {
        notes: event_notes(tx, &p.id)?,
        page_id: p.id,
        block_id: b.id,
        revision: b.revision,
        title: input.title,
        data: input.data,
    })
}

fn matching(d: NaiveDate, base: NaiveDate, r: &Repeat) -> bool {
    let days = (d - base).num_days();
    match r.frequency.as_str() {
        "daily" => days % i64::from(r.interval) == 0,
        "weekly" => {
            let week = (days + i64::from(base.weekday().num_days_from_monday())) / 7;
            week % i64::from(r.interval) == 0
                && if r.days.is_empty() {
                    d.weekday() == base.weekday()
                } else {
                    r.days.contains(&d.weekday().num_days_from_monday())
                }
        }
        "monthly" => {
            ((d.year() - base.year()) * 12 + d.month() as i32 - base.month() as i32)
                % r.interval as i32
                == 0
                && d.day() == base.day()
        }
        "yearly" => {
            (d.year() - base.year()) % r.interval as i32 == 0
                && d.month() == base.month()
                && d.day() == base.day()
        }
        _ => false,
    }
}
pub fn occurrences(event: &Event, from: NaiveDate, to: NaiveDate) -> AppResult<Vec<Occurrence>> {
    let data = &event.data;
    validate(data)?;
    let base = local(&data.start, data.all_day)?;
    let finish = local(&data.end, data.all_day)?;
    let zone: Tz = data.timezone.parse().unwrap();
    let duration = finish - base;
    let mut out = Vec::new();
    let mut d = base.date();
    let mut count = 0u32;
    // Enumerate only when COUNT needs an ordinal. Otherwise skip directly to the requested window.
    if data.recurrence.as_ref().is_some_and(|r| r.count.is_none()) {
        d = std::cmp::max(d, from - Duration::days(duration.num_days() + 1));
    }
    let until = data
        .recurrence
        .as_ref()
        .and_then(|r| r.until.as_deref())
        .map(date)
        .transpose()?;
    let last = std::cmp::min(to, until.unwrap_or(to));
    let mut iterations = 0;
    while d <= last && iterations < 36600 {
        iterations += 1;
        let valid = data
            .recurrence
            .as_ref()
            .map_or(d == base.date(), |r| matching(d, base.date(), r));
        if valid {
            count += 1;
            if data
                .recurrence
                .as_ref()
                .and_then(|r| r.count)
                .is_some_and(|n| count > n)
            {
                break;
            }
            let key = d.to_string();
            let exception = data.exceptions.iter().find(|e| e.date == key);
            if !exception.is_some_and(|e| e.cancelled) {
                let start = exception
                    .and_then(|e| e.start.as_deref())
                    .map(|s| local(s, data.all_day))
                    .transpose()?
                    .unwrap_or(d.and_time(base.time()));
                let end = exception
                    .and_then(|e| e.end.as_deref())
                    .map(|s| local(s, data.all_day))
                    .transpose()?
                    .unwrap_or(start + duration);
                if start.date() <= to
                    && (if data.all_day {
                        end.date() > from
                    } else {
                        end.date() >= from
                    })
                {
                    if data.all_day {
                        out.push(Occurrence {
                            id: format!("{}:{key}", event.page_id),
                            page_id: event.page_id.clone(),
                            original_date: key,
                            start: start.date().to_string(),
                            end: end.date().to_string(),
                            all_day: true,
                        });
                    } else if let (Ok(a), Ok(b)) = (instant(start, zone), instant(end, zone)) {
                        out.push(Occurrence {
                            id: format!("{}:{key}", event.page_id),
                            page_id: event.page_id.clone(),
                            original_date: key,
                            start: a.to_rfc3339(),
                            end: b.to_rfc3339(),
                            all_day: false,
                        });
                    }
                }
            }
        }
        d += Duration::days(1);
        if data.recurrence.is_none() {
            break;
        }
    }
    if iterations >= 36600 && d <= last {
        return Err(invalid(
            "this finite series is beyond the supported 100-year expansion window",
        ));
    }
    // A moved occurrence may land in this window even when its original date lies outside it.
    for x in &data.exceptions {
        if out.iter().any(|o| o.original_date == x.date) {
            continue;
        }
        let original = date(&x.date)?;
        if original >= std::cmp::max(base.date(), from - Duration::days(duration.num_days() + 1))
            && original <= last
        {
            continue;
        }
        if x.cancelled {
            continue;
        }
        if let (Some(a), Some(b)) = (&x.start, &x.end) {
            let a = local(a, data.all_day)?;
            let b = local(b, data.all_day)?;
            if a.date() <= to
                && (if data.all_day {
                    b.date() > from
                } else {
                    b.date() >= from
                })
            {
                out.push(Occurrence {
                    id: format!("{}:{}", event.page_id, x.date),
                    page_id: event.page_id.clone(),
                    original_date: x.date.clone(),
                    start: if data.all_day {
                        a.date().to_string()
                    } else {
                        instant(a, zone)?.to_rfc3339()
                    },
                    end: if data.all_day {
                        b.date().to_string()
                    } else {
                        instant(b, zone)?.to_rfc3339()
                    },
                    all_day: data.all_day,
                });
            }
        }
    }
    Ok(out)
}
pub fn snapshot(conn: &Connection, workspace: &str, from: &str, to: &str) -> AppResult<Snapshot> {
    snapshot_selected(conn, workspace, from, to, None, false)
}
pub fn snapshot_selected(
    conn: &Connection,
    workspace: &str,
    from: &str,
    to: &str,
    calendar_ids: Option<Vec<String>>,
    reminders_only: bool,
) -> AppResult<Snapshot> {
    validate_id(workspace, "workspace")?;
    if let Some(ids) = &calendar_ids {
        if ids.len() > 32 {
            return Err(invalid("connect at most 32 calendar sources"));
        }
        for id in ids {
            validate_id(id, "calendar source")?;
        }
    }
    let ids = calendar_ids.map(|ids| serde_json::to_string(&ids).unwrap());
    let from = date(from)?;
    let to = date(to)?;
    if to < from || to - from > Duration::days(400) {
        return Err(invalid("query up to one year at a time"));
    }
    let mut stmt=conn.prepare("SELECT b.id,b.page_id,b.revision,b.data_json,p.title FROM block b JOIN page p ON p.id=b.page_id WHERE p.workspace_id=?1 AND p.deleted_at IS NULL AND b.type='calendar_event' AND (?2 IS NULL OR json_extract(b.data_json,'$.calendarId') IN (SELECT value FROM json_each(?2))) AND (?3=0 OR json_array_length(b.data_json,'$.reminders')>0) ORDER BY b.page_id LIMIT 2001")?;
    let rows = stmt
        .query_map(params![workspace, ids, reminders_only], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = Snapshot {
        collections: vec![],
        events: vec![],
        occurrences: vec![],
        truncated: rows.len() > 2000,
        invalid: 0,
    };
    let mut stmt=conn.prepare("SELECT p.id FROM page p JOIN calendar_collection c ON c.page_id=p.id WHERE p.workspace_id=?1 AND p.deleted_at IS NULL")?;
    for id in stmt.query_map([workspace], |r| r.get::<_, String>(0))? {
        if let Some(p) = repo::page::get(conn, &id?)? {
            result.collections.push(p);
        }
    }
    for (block_id, page_id, revision, text, title) in rows.into_iter().take(2000) {
        let Ok(data) = serde_json::from_str::<Schedule>(&text) else {
            result.invalid += 1;
            continue;
        };
        if !result.collections.iter().any(|p| p.id == data.calendar_id) {
            continue;
        }
        let mut event = Event {
            notes: event_notes(conn, &page_id)?,
            page_id,
            block_id,
            revision,
            title,
            data,
        };
        if event.data.follow_source_title {
            if let Some(link) = event.data.links.first() {
                if let Some(page) = repo::page::get(conn, &link.page_id)?
                    .filter(|p| p.workspace_id == workspace && p.deleted_at.is_none())
                {
                    let live = if let Some(id) = &link.block_id {
                        repo::block::get(conn, id)?
                            .filter(|b| b.page_id == page.id)
                            .map(|b| {
                                search::text::plain_text(
                                    &b.block_type,
                                    b.schema_version,
                                    &b.data_json,
                                )
                            })
                            .unwrap_or_default()
                    } else {
                        page.title
                    };
                    if !live.trim().is_empty() {
                        event.title = live.chars().take(500).collect();
                    }
                }
            }
        }
        match occurrences(&event, from, to) {
            Ok(v) => result.occurrences.extend(v),
            Err(_) => {
                result.invalid += 1;
                continue;
            }
        }
        result.events.push(event);
    }
    if result.occurrences.len() > 6000 {
        result.occurrences.truncate(6000);
        result.truncated = true;
    }
    Ok(result)
}
fn event_notes(conn: &Connection, page_id: &str) -> AppResult<String> {
    Ok(repo::block::list(conn, page_id)?
        .iter()
        .filter(|b| b.block_type != "calendar_event")
        .map(|b| search::text::plain_text(&b.block_type, b.schema_version, &b.data_json))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
        .chars()
        .take(20000)
        .collect())
}
pub fn fire_due(conn: &Connection) -> AppResult<Vec<crate::reminders::Reminder>> {
    let now = Utc::now();
    let from = (now - Duration::days(1)).date_naive().to_string();
    let to = (now + Duration::days(31)).date_naive().to_string();
    let mut due = Vec::new();
    for w in repo::workspace::list(conn)? {
        let snap = snapshot_selected(conn, &w.id, &from, &to, None, true)?;
        for o in snap.occurrences {
            let Some(event) = snap.events.iter().find(|e| e.page_id == o.page_id) else {
                continue;
            };
            if event.data.completed {
                continue;
            }
            let start = if o.all_day {
                instant(
                    date(&o.start)?.and_hms_opt(9, 0, 0).unwrap(),
                    event.data.timezone.parse().unwrap(),
                )?
            } else {
                chrono::DateTime::parse_from_rfc3339(&o.start)
                    .map_err(|_| invalid("bad event instant"))?
                    .with_timezone(&Utc)
            };
            for offset in &event.data.reminders {
                let at = start - Duration::minutes(*offset);
                if at > now || at < now - Duration::hours(24) {
                    continue;
                }
                let n=conn.execute("INSERT OR IGNORE INTO calendar_delivery(page_id,occurrence,offset_minutes,fired_at) VALUES (?1,?2,?3,?4)",params![event.page_id,o.original_date,offset,now.to_rfc3339()])?;
                if n > 0 {
                    due.push(crate::reminders::Reminder {
                        id: format!("calendar:{}:{offset}", o.id),
                        page_id: event.page_id.clone(),
                        page_title: event.title.clone(),
                        remind_at: at
                            .with_timezone(&chrono::Local)
                            .format("%Y-%m-%dT%H:%M:%S")
                            .to_string(),
                        note: "Calendar reminder".into(),
                        fired_at: Some(now.to_rfc3339()),
                    });
                }
            }
        }
    }
    Ok(due)
}

#[cfg(test)]
mod color_tests {
    use super::*;

    fn schedule(color: Option<&str>) -> Schedule {
        serde_json::from_value(json!({
            "calendarId": "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", "start": "2026-10-13", "end": "2026-10-16",
            "allDay": true, "timezone": "UTC", "recurrence": null, "color": color
        }))
        .unwrap()
    }

    #[test]
    fn event_color_must_be_a_six_digit_hex() {
        for ok in [None, Some("#355aa4"), Some("#ABCDEF")] {
            assert!(validate(&schedule(ok)).is_ok(), "{ok:?}");
        }
        for bad in ["355aa4", "#fff", "#12345g", "red", "#1234567"] {
            assert!(validate(&schedule(Some(bad))).is_err(), "{bad}");
        }
    }
}

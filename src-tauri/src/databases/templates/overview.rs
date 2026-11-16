//! The page that holds a starter's databases gets a short overview: what it is, a link to each
//! database with a line about it, and live views of the most useful ones. It is ordinary page
//! content, so it can be edited or deleted like any other.

use super::*;
use crate::domain::{Block, BLOCK_SCHEMA_VERSION};

struct Overview {
    intro: &'static str,
    /// One line per database, in the order the starter creates them.
    notes: &'static [&'static str],
    /// Live views to show: (database index, view name, heading).
    embeds: &'static [(usize, &'static str, &'static str)],
}

const PROJECT_NOTES: &[&str] = &[
    "the big goals, with an owner, dates and live progress",
    "checkpoints inside a project, each with a due date",
    "time-boxed batches of tasks",
    "the work itself, with subtasks, dependencies and a Blocked flag",
];

fn overview_of(id: &str) -> Option<Overview> {
    Some(match id {
        "project_manager" => Overview {
            intro: "Plan work from projects down to tasks. Progress rolls up from tasks to milestones, sprints and projects. Every part is a normal database: rename, extend or delete anything.",
            notes: PROJECT_NOTES,
            embeds: &[(0, "Board", "Projects"), (3, "Current sprint", "Current sprint")],
        },
        "software_project" => Overview {
            intro: "The Project Manager setup for software: tasks have a type (feature, bug or chore), and a Bugs view lists everything broken that is not done yet.",
            notes: PROJECT_NOTES,
            embeds: &[(3, "Current sprint", "Current sprint"), (3, "Bugs", "Open bugs")],
        },
        "task_tracker" => Overview {
            intro: "One list of tasks with subtasks and dependencies. Use the board to move work along, the calendar and timeline to see when it is due.",
            notes: &["every task, with status, priority, dates, parent and blockers"],
            embeds: &[(0, "Board", "Board")],
        },
        "reading_list" => Overview {
            intro: "Keep track of what you want to read, what you are reading and what you finished.",
            notes: &["one record per book, with author, genres, pages, rating and the day you finished"],
            embeds: &[(0, "Shelf", "On the shelf")],
        },
        "crm" => Overview {
            intro: "A light contact and deal tracker. Move people along the pipeline and never miss a follow-up.",
            notes: &["people and companies, with deal stage and value, last contact and next follow-up"],
            embeds: &[(0, "Pipeline", "Pipeline"), (0, "Follow-ups", "Follow-ups")],
        },
        "content_calendar" => Overview {
            intro: "Plan what gets published, where and when.",
            notes: &["every post, article or video, with status, channel, author and publish date"],
            embeds: &[(0, "Calendar", "Coming up")],
        },
        "expense_tracker" => Overview {
            intro: "Log what you spend and see where it goes. The table's footer adds up the amounts.",
            notes: &["one record per expense, with amount, category, date and how it was paid"],
            embeds: &[(0, "By category", "Where it goes"), (0, "By month", "Month by month")],
        },
        "job_search" => Overview {
            intro: "Follow every application from wishlist to offer.",
            notes: &["one record per application, with stage, salary, dates and contact"],
            embeds: &[(0, "Pipeline", "Pipeline"), (0, "Follow-ups", "Follow-ups")],
        },
        "inventory" => Overview {
            intro: "Know what you have and what is running low. Stock value and the Low stock flag are calculated for you.",
            notes: &["every item, with quantity, reorder level, price and calculated stock value"],
            embeds: &[(0, "Stock value by category", "Stock value")],
        },
        "recipes" => Overview {
            intro: "Your recipes in one place, with cooking time, rating and favourites.",
            notes: &["one record per recipe, with meal, cuisine, minutes, servings and rating"],
            embeds: &[(0, "Gallery", "Gallery")],
        },
        "meeting_notes" => Overview {
            intro: "Meetings by date and type. Open a meeting to write its notes in the page.",
            notes: &["one record per meeting, with attendees and a follow-up status"],
            embeds: &[(0, "Needs follow-up", "Needs follow-up"), (0, "Calendar", "Calendar")],
        },
        "habit_tracker" => Overview {
            intro: "Add a record for each time you do a habit and tick it off. The footer shows the share you completed.",
            notes: &["the daily log, with habit, done and minutes"],
            embeds: &[(0, "Minutes per week", "Minutes per week")],
        },
        "goals_okrs" => Overview {
            intro: "Set objectives and break them into key results. Each objective's progress is the average of its key results.",
            notes: &[
                "what you want to achieve this quarter, with the rolled-up progress",
                "the measurable results; link each one to its objective",
            ],
            embeds: &[(0, "By status", "Objectives by status")],
        },
        _ => return None,
    })
}

struct Writer<'a> {
    b: &'a Builder<'a>,
    next: f64,
}

impl Writer<'_> {
    fn add(&mut self, kind: &str, data: Value) -> AppResult<()> {
        let stamp = now();
        let block = Block {
            id: new_id(),
            page_id: self.b.root.clone(),
            parent_block_id: None,
            block_type: kind.into(),
            position: self.next,
            data_json: data.to_string(),
            schema_version: BLOCK_SCHEMA_VERSION,
            revision: 1,
            created_at: stamp.clone(),
            updated_at: stamp,
        };
        self.next += 1.0;
        repo::block::insert(self.b.tx, &block)?;
        search::index::upsert_block(
            self.b.tx,
            &self.b.ws,
            &block.page_id,
            &block.id,
            kind,
            BLOCK_SCHEMA_VERSION,
            &block.data_json,
        )?;
        Ok(())
    }
    fn text(&mut self, kind: &str, text: &str) -> AppResult<()> {
        self.add(kind, json!({ "content": [{ "type": "text", "text": text }] }))
    }
}

/// Writes the overview into the starter's page. `database_pages` are the databases' page ids, in
/// the order the starter lists them.
pub fn write(b: &Builder, id: &str, database_pages: &[String]) -> AppResult<()> {
    let Some(o) = overview_of(id) else {
        return Ok(());
    };
    let mut w = Writer { b, next: 1.0 };
    w.text("paragraph", o.intro)?;
    w.text("heading_2", "Databases")?;
    for (page, note) in database_pages.iter().zip(o.notes) {
        w.add(
            "bullet_list",
            json!({ "content": [
                { "type": "pageMention", "attrs": { "pageId": page } },
                { "type": "text", "text": format!(" – {note}") },
            ] }),
        )?;
    }
    for (index, view_name, heading) in o.embeds {
        let Some(page) = database_pages.get(*index) else { continue };
        let detail = super::super::service::database_detail_by_page(b.tx, page)?;
        let Some(view) = detail.views.iter().find(|v| v.name == *view_name) else { continue };
        w.text("heading_2", heading)?;
        w.add(
            "database_view",
            json!({ "pageId": page, "viewId": view.id, "height": null }),
        )?;
    }
    Ok(())
}

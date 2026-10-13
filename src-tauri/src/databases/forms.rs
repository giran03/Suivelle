//! Forms: a view type that asks for a record's fields and creates the record on submit.
//!
//! A form is a view's `FormSpec`: which properties to ask for, in what order, with what label,
//! help text and whether each is required. Submitting runs through the same record creation as
//! every other path, so values are validated and indexed identically. Nothing is hosted.

use super::service::{create_record_in, load_database, load_properties, load_view_by_id};
use super::*;
use crate::errors::{AppError, AppResult};
use rusqlite::Connection;

fn bad<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Validation(msg.into()))
}

/// Properties a person can fill in. Calculated, automatic and relation properties are not asked for.
pub fn fillable(p: &Property) -> bool {
    !matches!(
        p.property_type.as_str(),
        "created_time"
            | "updated_time"
            | "unique_id"
            | "relation"
            | "rollup"
            | "formula"
            | "button"
    )
}

/// Every fillable property, the title first and required.
pub fn default_spec(props: &[Property]) -> FormSpec {
    FormSpec {
        fields: props
            .iter()
            .filter(|p| fillable(p))
            .map(|p| FormField {
                property_id: p.id.clone(),
                label: None,
                help: None,
                required: p.property_type == "title",
            })
            .collect(),
        intro: None,
        submit_label: None,
        success_message: None,
    }
}

fn text(v: Option<String>, max: usize, what: &str) -> AppResult<Option<String>> {
    let Some(v) = v else {
        return Ok(None);
    };
    let v = v.trim();
    if v.chars().count() > max {
        return bad(format!("{what} can be at most {max} characters"));
    }
    Ok((!v.is_empty()).then(|| v.to_string()))
}

/// Keeps the fields that still exist, drops duplicates and ones that cannot be filled in, and
/// makes sure the title is the first, required field.
pub fn normalize(spec: FormSpec, props: &[Property]) -> AppResult<FormSpec> {
    let mut seen = std::collections::HashSet::new();
    let mut fields = Vec::new();
    for f in spec.fields {
        let Some(p) = props.iter().find(|p| p.id == f.property_id) else {
            continue;
        };
        if !fillable(p) || !seen.insert(f.property_id.clone()) {
            continue;
        }
        fields.push(FormField {
            property_id: f.property_id,
            label: text(f.label, 80, "a label")?,
            help: text(f.help, 200, "help text")?,
            required: f.required || p.property_type == "title",
        });
    }
    if let Some(title) = props.iter().find(|p| p.property_type == "title") {
        match fields.iter().position(|f| f.property_id == title.id) {
            Some(0) => {}
            Some(i) => {
                let f = fields.remove(i);
                fields.insert(0, f);
            }
            None => fields.insert(
                0,
                FormField {
                    property_id: title.id.clone(),
                    label: None,
                    help: None,
                    required: true,
                },
            ),
        }
    }
    Ok(FormSpec {
        fields,
        intro: text(spec.intro, MAX_FORM_TEXT, "the introduction")?,
        submit_label: text(spec.submit_label, 40, "the button label")?,
        success_message: text(spec.success_message, 200, "the confirmation message")?,
    })
}

/// Creates a record from a filled-in form.
pub fn submit(conn: &mut Connection, input: FormSubmit) -> AppResult<RecordRow> {
    crate::domain::validate_id(&input.view_id, "view")?;
    let tx = conn.transaction()?;
    let view = load_view_by_id(&tx, &input.view_id)?;
    if view.view_type != "form" {
        return bad("this view is not a form");
    }
    let db = load_database(&tx, &view.database_id)?;
    let props = load_properties(&tx, &db.id)?;
    let spec = normalize(
        view.config.form.unwrap_or_else(|| default_spec(&props)),
        &props,
    )?;

    let title_id = props
        .iter()
        .find(|p| p.property_type == "title")
        .map(|p| p.id.as_str())
        .unwrap_or_default();
    let mut values = Map::new();
    for (pid, v) in &input.values {
        if !spec.fields.iter().any(|f| &f.property_id == pid) || pid == title_id {
            return bad("this form does not ask for that field");
        }
        values.insert(pid.clone(), v.clone());
    }
    for f in spec.fields.iter().filter(|f| f.required) {
        let Some(p) = props.iter().find(|p| p.id == f.property_id) else {
            continue;
        };
        let label = f.label.as_deref().unwrap_or(&p.name);
        let empty = if p.property_type == "title" {
            input.title.as_deref().is_none_or(|t| t.trim().is_empty())
        } else {
            match values.get(&p.id) {
                None => true,
                Some(v) => super::values::normalize_value(p, v)?.is_none(),
            }
        };
        if empty {
            return bad(format!("{label} is required"));
        }
    }
    let row = create_record_in(
        &tx,
        RecordCreate {
            database_id: db.id.clone(),
            title: input.title,
            values,
            template_id: None,
        },
    )?;
    tx.commit()?;
    Ok(row)
}

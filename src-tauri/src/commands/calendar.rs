use crate::{calendar, database::Db, domain::Page, errors::AppResult};
use tauri::Manager;
#[tauri::command]
pub async fn calendar_snapshot(
    app: tauri::AppHandle,
    workspace_id: String,
    from: String,
    to: String,
    calendar_ids: Option<Vec<String>>,
) -> AppResult<calendar::Snapshot> {
    super::worker::blocking("calendar_snapshot", move || {
        let db = app.state::<Db>();
        let conn = super::lock(&db)?;
        calendar::snapshot_selected(&conn, &workspace_id, &from, &to, calendar_ids, false)
    })
    .await
}
#[tauri::command]
pub async fn calendar_create(
    app: tauri::AppHandle,
    workspace_id: String,
    title: String,
) -> AppResult<Page> {
    super::worker::blocking("calendar_create", move || {
        let db = app.state::<Db>();
        let mut conn = super::lock(&db)?;
        calendar::create_collection(&mut conn, &workspace_id, &title)
    })
    .await
}
#[tauri::command]
pub async fn calendar_save(
    app: tauri::AppHandle,
    input: calendar::Save,
    template_id: Option<String>,
) -> AppResult<calendar::Event> {
    super::worker::blocking("calendar_save", move || {
        let db = app.state::<Db>();
        let mut conn = super::lock(&db)?;
        calendar::save_with_template(&mut conn, input, template_id)
    })
    .await
}
#[tauri::command]
pub async fn calendar_import(
    app: tauri::AppHandle,
    workspace_id: String,
    events: Vec<calendar::Save>,
) -> AppResult<Vec<calendar::Event>> {
    super::worker::blocking("calendar_import", move || {
        let db = app.state::<Db>();
        let mut conn = super::lock(&db)?;
        calendar::import(&mut conn, &workspace_id, events)
    })
    .await
}

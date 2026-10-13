use super::lock;
use crate::{
    database::Db,
    domain::{validate_id, Attachment},
    errors::{AppError, AppResult},
    files::{self, AttachmentStore},
};
use tauri::Manager;

#[tauri::command]
pub async fn media_url_info(url: String) -> AppResult<Option<files::remote::MediaUrlInfo>> {
    tauri::async_runtime::spawn_blocking(move || files::remote::inspect(&url))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

#[tauri::command]
pub async fn attachment_import_url(
    app: tauri::AppHandle,
    workspace_id: String,
    url: String,
) -> AppResult<Attachment> {
    validate_id(&workspace_id, "workspace")?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<AttachmentStore>();
        let (info, hash, size) = files::remote::download(&store.root, &url)?;
        let db = app.state::<Db>();
        let mut conn = lock(&db)?;
        let tx = conn.transaction()?;
        let attachment =
            files::insert_attachment_in(&tx, &workspace_id, &hash, &info.name, &info.mime, size)?;
        tx.commit()?;
        Ok(attachment)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}

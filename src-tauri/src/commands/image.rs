use super::{lock, worker};
use crate::{
    database::Db,
    domain::{image::Crop, validate_id},
    errors::{AppError, AppResult},
    files::{self, AttachmentStore},
};
use tauri::Manager;

fn source(app: &tauri::AppHandle, id: &str) -> AppResult<std::path::PathBuf> {
    validate_id(id, "attachment")?;
    let db = app.state::<Db>();
    let conn = lock(&db)?;
    let att = files::get(&conn, id)?.ok_or_else(|| AppError::NotFound("attachment".into()))?;
    Ok(files::blob_path(
        &app.state::<AttachmentStore>().root,
        &att.hash,
    ))
}
#[tauri::command]
pub async fn image_info(app: tauri::AppHandle, id: String) -> AppResult<serde_json::Value> {
    worker::blocking("image_info", move || { let path = source(&app, &id)?; let (width, height) = image::ImageReader::open(&path)?.with_guessed_format()?.into_dimensions().map_err(|e| AppError::Validation(e.to_string()))?; Ok(serde_json::json!({"width":width,"height":height,"animated":files::image_edit::animated(&path)?})) }).await
}
#[tauri::command]
pub async fn image_save_crop(app: tauri::AppHandle, id: String, crop: Crop) -> AppResult<bool> {
    worker::dialog("image_save_crop", move || {
        use tauri_plugin_dialog::DialogExt;
        let path = source(&app, &id)?;
        let image = files::image_edit::render(&path, Some(crop))?;
        let Some(dest) = app
            .dialog()
            .file()
            .set_file_name("image-crop.png")
            .add_filter("PNG image", &["png"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let dest = dest
            .into_path()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        image
            .save_with_format(dest, image::ImageFormat::Png)
            .map_err(|e| AppError::Internal(e.to_string()))?;
        Ok(true)
    })
    .await
}
#[tauri::command]
pub async fn image_copy(
    app: tauri::AppHandle,
    id: String,
    crop: Option<Crop>,
    still_frame: bool,
) -> AppResult<()> {
    worker::blocking("image_copy", move || {
        let path = source(&app, &id)?;
        if files::image_edit::animated(&path)? && !still_frame {
            return Err(AppError::Validation(
                "Use Copy still frame for animated images.".into(),
            ));
        }
        let image = files::image_edit::render(&path, crop)?.to_rgba8();
        let data = arboard::ImageData {
            width: image.width() as usize,
            height: image.height() as usize,
            bytes: std::borrow::Cow::Owned(image.into_raw()),
        };
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_image(data))
            .map_err(|e| AppError::Internal(format!("Could not copy image: {e}")))
    })
    .await
}
#[tauri::command]
pub fn image_open_link(url: String) -> AppResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:"))
        || url.chars().any(char::is_control)
    {
        return Err(AppError::Validation("Unsupported image link".into()));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err(AppError::Validation(
            "External image links are supported on Windows.".into(),
        ))
    }
}

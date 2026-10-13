//! Commands for what people bring into a page: pasted and dropped files, Markdown text, and the
//! attachment manager. The webview never supplies or receives a filesystem path.

use super::{lock, logged, worker::blocking};
use crate::database::Db;
use crate::databases::{self, service as dbs};
use crate::domain::Attachment;
use crate::errors::{AppError, AppResult};
use crate::files::manage::{self, AttachmentInfo, Deleted};
use crate::files::AttachmentStore;
use crate::services::duplicate::{self, Duplicated, PageDuplicate};
use crate::transfer::blocks::{flatten, plain, Blk};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

const MAX_MARKDOWN_BYTES: usize = 2 * 1024 * 1024;

/// Decodes the `%XX` escapes JavaScript's `encodeURIComponent` produces for a header value.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 3 <= b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(v) = hex {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Stores a file that was pasted or dropped. The bytes are the raw request body; the workspace id
/// and (percent-encoded) file name travel in headers so large files avoid a JSON round trip.
#[tauri::command(async)]
pub fn attachment_import_bytes(
    db: State<'_, Db>,
    store: State<'_, AttachmentStore>,
    request: Request<'_>,
) -> AppResult<Attachment> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Validation("expected the file's bytes".into()));
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(percent_decode)
            .unwrap_or_default()
    };
    let workspace_id = header("x-workspace-id");
    let name = header("x-file-name");
    let t = std::time::Instant::now();
    let res = lock(&db)
        .and_then(|mut c| manage::import_bytes(&mut c, &store.root, &workspace_id, &name, bytes));
    logged("attachment_import_bytes", t, res)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkSet {
    pub property_id: String,
    pub record_ids: Vec<String>,
    #[serde(default)]
    pub value: Value,
}

/// Sets one property on many records at once, all or nothing, then lets automations react to each change.
#[tauri::command]
pub async fn record_bulk_set(
    app: AppHandle,
    input: BulkSet,
) -> AppResult<Vec<databases::RecordRow>> {
    blocking("record_bulk_set", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| {
            let before: std::collections::HashMap<String, Option<Value>> =
                dbs::load_rows(&c, &input.record_ids)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|r| (r.id.clone(), r.values.get(&input.property_id).cloned()))
                    .collect();
            let rows =
                dbs::bulk_set_value(&mut c, &input.property_id, &input.record_ids, &input.value)?;
            let mut events = Vec::new();
            for row in &rows {
                let old = before.get(&row.id).and_then(|v| v.as_ref());
                events.extend(crate::automation::engine::change_events(
                    old,
                    row,
                    &input.property_id,
                ));
            }
            super::react(&app, &mut c, events);
            Ok(rows.into_iter().map(|r| super::fresh(&c, r)).collect())
        });
        logged("record_bulk_set", t, res)
    })
    .await
}

/// Copies a page (and, if asked, the pages inside it): "Duplicate" and "New page from template".
#[tauri::command]
pub async fn page_duplicate(app: tauri::AppHandle, input: PageDuplicate) -> AppResult<Duplicated> {
    blocking("page_duplicate", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| duplicate::duplicate(&mut c, input));
        logged("page_duplicate", t, res)
    })
    .await
}

#[tauri::command]
pub async fn attachment_list(
    app: tauri::AppHandle,
    workspace_id: String,
) -> AppResult<Vec<AttachmentInfo>> {
    blocking("attachment_list", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|c| manage::list_usage(&c, &workspace_id));
        logged("attachment_list", t, res)
    })
    .await
}

#[tauri::command]
pub async fn attachment_delete_unused(
    app: tauri::AppHandle,
    workspace_id: String,
    ids: Vec<String>,
    include_history: bool,
) -> AppResult<Deleted> {
    blocking("attachment_delete_unused", move || {
        let db = app.state::<Db>();
        let store = app.state::<AttachmentStore>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| {
            manage::delete_unused(&mut c, &store.root, &workspace_id, &ids, include_history)
        });
        logged("attachment_delete_unused", t, res)
    })
    .await
}

/// A block row in the shape the editor stores, so the page can turn it into editor content.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRowOut {
    pub id: String,
    pub parent_block_id: Option<String>,
    #[serde(rename = "type")]
    pub block_type: String,
    pub position: f64,
    pub data_json: String,
    pub schema_version: i64,
}

/// Parses Markdown text (pasted into a page) into block rows with fresh ids.
pub fn markdown_rows(text: &str) -> Vec<BlockRowOut> {
    let mut parsed = crate::transfer::markdown::parse(text);
    // Import treats a leading "# Heading" as the page title; pasted into a page it is just a heading.
    let had_front_matter = text
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("---");
    if let (Some(title), false) = (parsed.title.take(), had_front_matter) {
        parsed
            .blocks
            .insert(0, Blk::with_inline("heading_1", vec![plain(title)]));
    }
    flatten(&parsed.blocks)
        .into_iter()
        .map(|u| BlockRowOut {
            id: u.id,
            parent_block_id: u.parent_block_id,
            block_type: u.block_type,
            position: u.position,
            data_json: u.data_json,
            schema_version: u.schema_version,
        })
        .collect()
}

#[tauri::command]
pub async fn markdown_to_blocks(text: String) -> AppResult<Vec<BlockRowOut>> {
    blocking("markdown_to_blocks", move || {
        if text.len() > MAX_MARKDOWN_BYTES {
            return Err(AppError::Validation(
                "that is too much text to paste as Markdown at once".into(),
            ));
        }
        Ok(markdown_rows(&text))
    })
    .await
}

/// The system-wide shortcut for quick capture. Off until the user turns it on in Settings, because a
/// global shortcut takes a key away from every other app.
pub fn capture_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN)
}

/// Opens only the jot window, leaving the main window's visibility and focus alone.
pub fn open_quick_capture(app: &AppHandle) {
    // WebView2 window creation must run outside the shortcut event handler on Windows.
    // Serialize repeated presses so they reuse the same window even while it is loading.
    static OPENING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let app = app.clone();
    std::thread::spawn(move || {
        let _opening = OPENING.lock().unwrap_or_else(|e| e.into_inner());
        if crate::updates::preparing() {
            return;
        }
        if let Some(window) = app.get_webview_window("quick-capture") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            return;
        }
        if let Err(error) = WebviewWindowBuilder::new(
            &app,
            "quick-capture",
            WebviewUrl::App("index.html?quick-capture".into()),
        )
        .title("Quick capture — Suivelle")
        .inner_size(560.0, 340.0)
        .min_inner_size(400.0, 300.0)
        .center()
        .always_on_top(true)
        .focused(true)
        .drag_and_drop(false)
        .build()
        {
            tracing::warn!(%error, "could not open quick capture window");
        }
    });
}

/// Turns the global quick-capture shortcut on or off. Fails with a readable message when another
/// program already owns the key combination.
#[tauri::command]
pub fn quick_capture_shortcut(app: AppHandle, enabled: bool) -> AppResult<bool> {
    let shortcuts = app.global_shortcut();
    let shortcut = capture_shortcut();
    if enabled {
        if !shortcuts.is_registered(shortcut) {
            shortcuts
                .register(shortcut)
                .map_err(|_| AppError::Validation("Ctrl+Alt+N is already used by another program, so it cannot be set as the quick capture shortcut.".into()))?;
        }
    } else if shortcuts.is_registered(shortcut) {
        shortcuts
            .unregister(shortcut)
            .map_err(|e| AppError::Internal(e.to_string()))?;
    }
    Ok(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_decode() {
        assert_eq!(
            percent_decode("My%20photo%20%28final%29.png"),
            "My photo (final).png"
        );
        assert_eq!(percent_decode("caf%C3%A9.png"), "café.png");
        assert_eq!(percent_decode("100%.png"), "100%.png");
        assert_eq!(percent_decode("%"), "%");
    }

    #[test]
    fn markdown_becomes_rows_and_keeps_a_leading_heading() {
        let rows = markdown_rows("# Title\n\nSome **bold** text\n\n- one\n- two\n");
        let kinds: Vec<&str> = rows.iter().map(|r| r.block_type.as_str()).collect();
        assert_eq!(
            kinds,
            ["heading_1", "paragraph", "bullet_list", "bullet_list"]
        );
        assert!(rows[1].data_json.contains("bold"));
        assert!(rows.iter().all(|r| r.parent_block_id.is_none()));
    }

    #[test]
    fn nested_lists_keep_their_parent() {
        let rows = markdown_rows("- outer\n    - inner\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[1].parent_block_id.as_deref(),
            Some(rows[0].id.as_str())
        );
    }

    #[test]
    fn front_matter_is_not_pasted_as_text() {
        let rows = markdown_rows("---\ntitle: Note\n---\n\nBody\n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].block_type, "paragraph");
    }
}

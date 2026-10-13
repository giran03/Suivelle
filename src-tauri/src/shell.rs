//! How the app behaves around its window: the tray icon, closing and minimizing to it, and
//! starting with the computer. These are per-device choices. They live in a small file beside
//! the data so they apply before the page has loaded (a hidden start has no page to ask).

use crate::errors::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

/// Passed by the system when it starts the app at sign-in, so a manual launch always shows the window.
pub const AUTOSTART_ARG: &str = "--autostart";
const TRAY_ID: &str = "main";
const FILE: &str = "shell.json";

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Behavior {
    pub launch_at_startup: bool,
    /// When started by the system, stay in the tray instead of opening the window.
    pub start_minimized: bool,
    pub show_tray: bool,
    pub close_to_tray: bool,
    pub minimize_to_tray: bool,
}

impl Behavior {
    /// The tray icon is the only way back to a hidden window, so it is on whenever one can hide.
    pub fn tray_visible(&self) -> bool {
        self.show_tray
            || self.close_to_tray
            || self.minimize_to_tray
            || (self.launch_at_startup && self.start_minimized)
    }
}

#[derive(Default)]
pub struct ShellState(Mutex<Behavior>);

impl ShellState {
    fn get(&self) -> Behavior {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("data").join(FILE))
}

fn load(app: &AppHandle) -> Behavior {
    file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, b: &Behavior) {
    if let Some(p) = file(app) {
        if let Ok(s) = serde_json::to_string(b) {
            let _ = std::fs::write(p, s);
        }
    }
}

pub fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Suivelle", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Suivelle")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn apply_tray(app: &AppHandle, b: &Behavior) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(b.tray_visible());
    }
}

/// Loads the saved choices, builds the tray, and honours a hidden start. Called once from setup.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let b = load(app);
    *app.state::<ShellState>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = b;
    build_tray(app)?;
    apply_tray(app, &b);
    let started_by_system = std::env::args().any(|a| a == AUTOSTART_ARG);
    if started_by_system && b.launch_at_startup && b.start_minimized {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    }
    Ok(())
}

/// Window events: close and minimize go to the tray when asked to.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let b = window.app_handle().state::<ShellState>().get();
    match event {
        WindowEvent::CloseRequested { api, .. }
            if b.close_to_tray && !crate::updates::preparing() =>
        {
            api.prevent_close();
            let _ = window.hide();
        }
        WindowEvent::Resized(_) if b.minimize_to_tray && window.is_minimized().unwrap_or(false) => {
            let _ = window.hide();
        }
        _ => {}
    }
}

/// Applies and remembers the window behaviour. Registering with the system can fail, in which
/// case nothing is saved and the page shows the reason.
#[tauri::command]
pub fn shell_set_behavior(app: AppHandle, behavior: Behavior) -> AppResult<Behavior> {
    let launcher = app.autolaunch();
    let enabled = launcher.is_enabled().unwrap_or(false);
    if behavior.launch_at_startup && !enabled {
        launcher.enable().map_err(|e| {
            AppError::Validation(format!(
                "Could not set Suivelle to start with your computer: {e}"
            ))
        })?;
    } else if !behavior.launch_at_startup && enabled {
        launcher.disable().map_err(|e| {
            AppError::Validation(format!(
                "Could not stop Suivelle starting with your computer: {e}"
            ))
        })?;
    }
    *app.state::<ShellState>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = behavior;
    save(&app, &behavior);
    apply_tray(&app, &behavior);
    Ok(behavior)
}

/// What is currently saved, so the settings page shows the truth rather than a stale copy.
#[tauri::command]
pub fn shell_get_behavior(app: AppHandle) -> Behavior {
    let mut b = app.state::<ShellState>().get();
    b.launch_at_startup = app.autolaunch().is_enabled().unwrap_or(b.launch_at_startup);
    b
}

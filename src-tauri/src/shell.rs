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
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

/// Passed by the system when it starts the app at sign-in, so a manual launch always shows the window.
pub const AUTOSTART_ARG: &str = "--autostart";
const TRAY_ID: &str = "main";
const FILE: &str = "shell.json";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Behavior {
    pub launch_at_startup: bool,
    /// When started by the system, stay in the tray instead of opening the window.
    pub start_minimized: bool,
    pub show_tray: bool,
    pub close_to_tray: bool,
    pub minimize_to_tray: bool,
    pub focus_shortcut: bool,
}

impl Default for Behavior {
    fn default() -> Self {
        Self {
            launch_at_startup: false,
            start_minimized: false,
            show_tray: false,
            close_to_tray: false,
            minimize_to_tray: false,
            focus_shortcut: true,
        }
    }
}

pub fn focus_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyS)
}

fn apply_focus_shortcut(app: &AppHandle, enabled: bool) -> AppResult<()> {
    crate::shortcuts::set_enabled(app, "focus", enabled)
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
        // Restore before showing so minimize-to-tray cannot immediately hide it again.
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        set_background(app, false);
    }
}

/// While the window is minimized or in the tray, asks WebView2 to trim the memory it keeps for
/// fast redraws; the normal target returns as soon as the window is back. Background work such
/// as automations and backups runs in Rust and is unaffected.
fn set_background(app: &AppHandle, background: bool) {
    static BACKGROUND: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if BACKGROUND.swap(background, std::sync::atomic::Ordering::SeqCst) == background {
        return;
    }
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.with_webview(move |wv| {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
            };
            use windows_core::Interface;
            let level = if background {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            };
            // SAFETY: `with_webview` runs this on the thread that owns the WebView2 objects.
            let result = unsafe {
                wv.controller()
                    .CoreWebView2()
                    .and_then(|core| core.cast::<ICoreWebView2_19>())
                    .and_then(|core| core.SetMemoryUsageTargetLevel(level))
            };
            if let Err(error) = result {
                tracing::debug!(%error, "could not change the webview memory target");
            }
        });
    }
    #[cfg(not(windows))]
    let _ = app;
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
    crate::shortcuts::init(app, b.focus_shortcut);
    let started_by_system = std::env::args().any(|a| a == AUTOSTART_ARG);
    if started_by_system && b.launch_at_startup && b.start_minimized {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
            set_background(app, true);
        }
    }
    Ok(())
}

/// Window events: close and minimize go to the tray when asked to.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if matches!(event, WindowEvent::Focused(false) | WindowEvent::Destroyed) {
        let _ = crate::shortcuts::recording(window.app_handle(), window.label(), false);
    }
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    let b = app.state::<ShellState>().get();
    match event {
        WindowEvent::CloseRequested { api, .. }
            if b.close_to_tray && !crate::updates::preparing() =>
        {
            api.prevent_close();
            let _ = window.hide();
            set_background(app, true);
        }
        WindowEvent::Resized(_) => {
            let minimized = window.is_minimized().unwrap_or(false);
            if minimized && b.minimize_to_tray {
                let _ = window.hide();
            }
            set_background(app, minimized || !window.is_visible().unwrap_or(true));
        }
        WindowEvent::Focused(true) => set_background(app, false),
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
    apply_focus_shortcut(&app, behavior.focus_shortcut)?;
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
    b.focus_shortcut = crate::shortcuts::enabled(&app, "focus");
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn focus_key_is_distinct_and_old_settings_enable_it_by_default() {
        assert_ne!(
            focus_shortcut(),
            crate::commands::content::capture_shortcut()
        );
        let old: Behavior = serde_json::from_str(r#"{"closeToTray":true}"#).unwrap();
        assert!(old.focus_shortcut);
        assert!(old.close_to_tray);
        let disabled: Behavior = serde_json::from_str(r#"{"focusShortcut":false}"#).unwrap();
        assert!(!disabled.focus_shortcut);
        assert!(Behavior::default().focus_shortcut);
    }
}

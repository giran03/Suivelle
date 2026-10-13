//! Device-level global keyboard bindings. Local inputs remain in the webview.
use crate::errors::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, str::FromStr, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Binding {
    kind: String,
    key: String,
    modifiers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    location: Option<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    capture: Vec<Binding>,
    focus: Vec<Binding>,
    capture_enabled: bool,
    focus_enabled: bool,
}
impl Default for Config {
    fn default() -> Self {
        let binding = |key: &str| Binding {
            kind: "key".into(),
            key: key.into(),
            modifiers: vec!["Control".into(), "Alt".into()],
            mode: None,
            location: None,
        };
        Self {
            capture: vec![binding("n")],
            focus: vec![binding("s")],
            capture_enabled: false,
            focus_enabled: true,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Status {
    config: Config,
    active: BTreeMap<String, bool>,
    errors: BTreeMap<String, String>,
}
#[derive(Default)]
struct Inner {
    config: Config,
    registered: Vec<(Shortcut, String)>,
    errors: BTreeMap<String, String>,
    recorder: Option<String>,
}
#[derive(Default)]
pub struct ShortcutState(Mutex<Inner>);

fn shortcut(b: &Binding) -> AppResult<Shortcut> {
    if b.kind != "key"
        || b.mode.as_deref() == Some("physical")
        || b.location.is_some()
        || b.modifiers.is_empty()
        || b.modifiers.len() > 4
        || b.key.len() > 32
    {
        return Err(AppError::Validation(
            "Global shortcuts require a keyboard key with modifiers.".into(),
        ));
    }
    let mut parts = Vec::new();
    for m in &b.modifiers {
        let m = match m.as_str() {
            "Control" => "Control",
            "Shift" => "Shift",
            "Alt" => "Alt",
            "Meta" => "Super",
            "Primary" => {
                if cfg!(target_os = "macos") {
                    "Super"
                } else {
                    "Control"
                }
            }
            _ => return Err(AppError::Validation("Unknown shortcut modifier.".into())),
        };
        if parts.contains(&m) {
            return Err(AppError::Validation("Duplicate shortcut modifier.".into()));
        }
        parts.push(m);
    }
    let key = match b.key.as_str() {
        " " => "Space",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "ArrowUp" => "Up",
        "ArrowDown" => "Down",
        "\\" => "Backslash",
        "/" => "Slash",
        "," => "Comma",
        "." => "Period",
        ";" => "Semicolon",
        "'" => "Quote",
        "[" => "BracketLeft",
        "]" => "BracketRight",
        "-" => "Minus",
        "=" => "Equal",
        "`" => "Backquote",
        "Control" | "Shift" | "Alt" | "Meta" | "Dead" | "Unidentified" => {
            return Err(AppError::Validation("Choose a non-modifier key.".into()))
        }
        other => other,
    };
    parts.push(key);
    Shortcut::from_str(&parts.join("+"))
        .map_err(|e| AppError::Validation(format!("Unsupported global shortcut: {e}")))
}
fn desired(config: &Config) -> AppResult<Vec<(Shortcut, String)>> {
    let mut all: Vec<(Shortcut, String)> = Vec::new();
    for (id, bindings, enabled) in [
        ("capture", &config.capture, config.capture_enabled),
        ("focus", &config.focus, config.focus_enabled),
    ] {
        if bindings.len() > 12 {
            return Err(AppError::Validation(
                "At most 12 bindings per action are supported.".into(),
            ));
        }
        for b in bindings {
            let value = shortcut(b)?;
            if all.iter().any(|(key, _)| key == &value) {
                return Err(AppError::Validation(
                    "Two global actions cannot share a shortcut.".into(),
                ));
            }
            all.push((value, if enabled { id.into() } else { String::new() }));
        }
    }
    Ok(all.into_iter().filter(|(_, id)| !id.is_empty()).collect())
}

trait Platform {
    fn register(&mut self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String>;
    fn persist(&mut self, config: &Config) -> Result<(), String>;
}
struct Desktop<'a>(&'a AppHandle);
impl Platform for Desktop<'_> {
    fn register(&mut self, value: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .register(value)
            .map_err(|e| e.to_string())
    }
    fn unregister(&mut self, value: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(value)
            .map_err(|e| e.to_string())
    }
    fn persist(&mut self, config: &Config) -> Result<(), String> {
        use std::io::Write;
        let path = file(self.0).map_err(|e| e.to_string())?;
        let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::now_v7()));
        let result = (|| -> Result<(), String> {
            std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            let bytes = serde_json::to_vec(config).map_err(|e| e.to_string())?;
            let mut output = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
            output.write_all(&bytes).map_err(|e| e.to_string())?;
            output.sync_all().map_err(|e| e.to_string())?;
            drop(output);
            std::fs::rename(&temp, path).map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result
    }
}
fn file(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(e.to_string()))?
        .join("data")
        .join("global-shortcuts.json"))
}
/// Reuse unchanged registrations, including swaps between actions. Roll back both OS and persistence failures.
fn transition(
    platform: &mut impl Platform,
    old: &[(Shortcut, String)],
    next: &[(Shortcut, String)],
    config: Option<&Config>,
) -> Result<(), String> {
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let result: Result<(), String> = (|| {
        for (key, _) in next {
            if !old.iter().any(|(k, _)| k == key) {
                platform.register(*key)?;
                added.push(*key);
            }
        }
        for (key, _) in old {
            if !next.iter().any(|(k, _)| k == key) {
                platform.unregister(*key)?;
                removed.push(*key);
            }
        }
        if let Some(config) = config {
            platform.persist(config)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut rollback = Vec::new();
        for key in added {
            if let Err(e) = platform.unregister(key) {
                rollback.push(e);
            }
        }
        for key in removed {
            if let Err(e) = platform.register(key) {
                rollback.push(e);
            }
        }
        return Err(if rollback.is_empty() {
            format!("Could not apply global shortcuts: {error}. Previous bindings restored.")
        } else {
            format!("Could not apply global shortcuts: {error}. Restoration also failed: {}. Reopen shortcut settings to check active bindings.", rollback.join("; "))
        });
    }
    Ok(())
}
fn status(inner: &Inner) -> Status {
    Status {
        config: inner.config.clone(),
        active: ["capture", "focus"]
            .into_iter()
            .map(|id| {
                (
                    id.to_string(),
                    inner
                        .registered
                        .iter()
                        .filter(|(_, owner)| owner == id)
                        .count()
                        == (if id == "capture" {
                            inner.config.capture.len()
                        } else {
                            inner.config.focus.len()
                        })
                        && inner.registered.iter().any(|(_, owner)| owner == id),
                )
            })
            .collect(),
        errors: inner.errors.clone(),
    }
}
pub fn init(app: &AppHandle, legacy_focus: bool) {
    let saved = file(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Config>(&b).ok());
    let config = saved.unwrap_or(Config {
        focus_enabled: legacy_focus,
        ..Config::default()
    });
    let state = app.state::<ShortcutState>();
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    inner.config = config.clone();
    match desired(&config) {
        Ok(keys) => {
            for (key, id) in keys {
                match Desktop(app).register(key) {
                    Ok(()) => inner.registered.push((key, id)),
                    Err(e) => {
                        inner.errors.insert(id, e);
                    }
                }
            }
        }
        Err(e) => {
            inner.errors.insert("configuration".into(), e.to_string());
        }
    }
}
pub fn dispatch(app: &AppHandle, shortcut: &Shortcut) {
    let owner = app
        .state::<ShortcutState>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .registered
        .iter()
        .find(|(key, _)| key == shortcut)
        .map(|(_, id)| id.clone());
    match owner.as_deref() {
        Some("capture") => crate::commands::content::open_quick_capture(app),
        Some("focus") => crate::shell::show_window(app),
        _ => {}
    }
}
#[tauri::command]
pub fn shortcuts_get(app: AppHandle) -> Status {
    let state = app.state::<ShortcutState>();
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    inner
        .registered
        .retain(|(key, _)| app.global_shortcut().is_registered(*key));
    status(&inner)
}
#[tauri::command]
pub fn shortcuts_migrate(app: AppHandle, capture_enabled: bool) -> AppResult<Status> {
    if file(&app)?.exists() {
        return Ok(shortcuts_get(app));
    }
    let mut config = shortcuts_get(app.clone()).config;
    config.capture_enabled = capture_enabled;
    shortcuts_set(app, config)
}
#[tauri::command]
pub fn shortcuts_set(app: AppHandle, config: Config) -> AppResult<Status> {
    let next = desired(&config)?;
    let state = app.state::<ShortcutState>();
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if inner.recorder.is_some() {
        return Err(AppError::Validation(
            "Finish input recording before applying global bindings.".into(),
        ));
    }
    let actual = next;
    if let Err(e) = transition(
        &mut Desktop(&app),
        &inner.registered,
        &actual,
        Some(&config),
    ) {
        inner
            .registered
            .retain(|(key, _)| app.global_shortcut().is_registered(*key));
        inner.errors.insert("configuration".into(), e.clone());
        return Err(AppError::Validation(e));
    }
    inner.config = config;
    inner.registered = actual;
    inner.errors.clear();
    let result = status(&inner);
    drop(inner);
    let _ = app.emit("shortcuts-changed", &result);
    Ok(result)
}
pub fn set_enabled(app: &AppHandle, id: &str, enabled: bool) -> AppResult<()> {
    let mut config = shortcuts_get(app.clone()).config;
    if id == "capture" {
        config.capture_enabled = enabled;
    } else {
        config.focus_enabled = enabled;
    }
    shortcuts_set(app.clone(), config)?;
    Ok(())
}
pub fn enabled(app: &AppHandle, id: &str) -> bool {
    let config = shortcuts_get(app.clone()).config;
    if id == "capture" {
        config.capture_enabled
    } else {
        config.focus_enabled
    }
}
#[tauri::command]
pub fn shortcuts_recording(window: tauri::WebviewWindow, active: bool) -> AppResult<()> {
    recording(window.app_handle(), window.label(), active)
}
pub fn recording(app: &AppHandle, owner: &str, active: bool) -> AppResult<()> {
    let state = app.state::<ShortcutState>();
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if !active && inner.recorder.as_deref() != Some(owner) {
        return Ok(());
    }
    if active && inner.recorder.as_deref().is_some_and(|id| id != owner) {
        return Err(AppError::Validation(
            "Another window is recording a shortcut.".into(),
        ));
    }
    let next = if active {
        vec![]
    } else {
        desired(&inner.config)?
    };
    transition(&mut Desktop(app), &inner.registered, &next, None).map_err(AppError::Validation)?;
    inner.registered = next;
    inner.recorder = active.then(|| owner.into());
    let result = status(&inner);
    drop(inner);
    let _ = app.emit("shortcuts-changed", result);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        keys: Vec<Shortcut>,
        reject: Option<Shortcut>,
        fail_save: bool,
    }
    impl Platform for Fake {
        fn register(&mut self, key: Shortcut) -> Result<(), String> {
            if self.reject == Some(key) {
                return Err("occupied".into());
            }
            self.keys.push(key);
            Ok(())
        }
        fn unregister(&mut self, key: Shortcut) -> Result<(), String> {
            self.keys.retain(|k| k != &key);
            Ok(())
        }
        fn persist(&mut self, _: &Config) -> Result<(), String> {
            if self.fail_save {
                Err("disk full".into())
            } else {
                Ok(())
            }
        }
    }
    #[test]
    fn defaults_are_distinct_and_invalid_inputs_are_rejected() {
        let config = Config::default();
        assert_ne!(
            shortcut(&config.capture[0]).unwrap(),
            shortcut(&config.focus[0]).unwrap()
        );
        let mut bad = config.clone();
        bad.focus = bad.capture.clone();
        assert!(desired(&bad).is_err());
        bad.focus[0].kind = "mouse".into();
        assert!(desired(&bad).is_err());
    }
    #[test]
    fn occupied_binding_leaves_previous_registration() {
        let config = Config::default();
        let old = shortcut(&config.focus[0]).unwrap();
        let next = shortcut(&config.capture[0]).unwrap();
        let mut fake = Fake {
            keys: vec![old],
            reject: Some(next),
            ..Fake::default()
        };
        assert!(transition(
            &mut fake,
            &[(old, "focus".into())],
            &[(next, "focus".into())],
            Some(&config)
        )
        .is_err());
        assert_eq!(fake.keys, vec![old]);
    }
    #[test]
    fn persistence_failure_rolls_back_and_swaps_reuse_registrations() {
        let config = Config::default();
        let a = shortcut(&config.focus[0]).unwrap();
        let b = shortcut(&config.capture[0]).unwrap();
        let mut fake = Fake {
            keys: vec![a],
            fail_save: true,
            ..Fake::default()
        };
        assert!(transition(
            &mut fake,
            &[(a, "focus".into())],
            &[(b, "focus".into())],
            Some(&config)
        )
        .is_err());
        assert_eq!(fake.keys, vec![a]);
        fake.keys = vec![a, b];
        fake.fail_save = false;
        transition(
            &mut fake,
            &[(a, "focus".into()), (b, "capture".into())],
            &[(b, "focus".into()), (a, "capture".into())],
            Some(&config),
        )
        .unwrap();
        assert_eq!(fake.keys, vec![a, b]);
    }
}

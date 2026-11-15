//! The tray icon's right-click menu. On Windows it is rendered as a Native Win32 Layered
//! Window (`tray_win32`) so it opens in < 2 ms without waking WebView2, while staying 1:1
//! synced with the main application's theme, design tokens, and appearance customizations.

use crate::errors::AppResult;
use crate::shell::RecentPage;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const CARD_WIDTH: f64 = 232.0;
pub const CARD_PADDING: f64 = 6.0;
pub const CARD_BORDER: f64 = 1.0;
pub const ROW_HEIGHT: f64 = 32.0;
pub const SEPARATOR_HEIGHT: f64 = 9.0;
pub const GAP: f64 = 6.0;
pub const SCREEN_MARGIN: f64 = 8.0;
pub const MAX_RECENT: usize = 5;

const APPEARANCE_FILE: &str = "tray-appearance.json";

#[derive(Default)]
pub struct TrayRecent(Mutex<Vec<RecentPage>>);

impl TrayRecent {
    pub fn get(&self) -> Vec<RecentPage> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set(&self, pages: Vec<RecentPage>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) =
            pages.into_iter().take(MAX_RECENT).collect();
        #[cfg(windows)]
        crate::tray_win32::notify_refresh();
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    #[default]
    Dark,
    System,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayPalette {
    pub surface_1: String,
    pub text_primary: String,
    pub text_secondary: String,
    pub border_strong: String,
    pub accent_ui: String,
    pub danger: String,
}

impl TrayPalette {
    pub fn default_light() -> Self {
        Self {
            surface_1: "#F1F3F6".into(),
            text_primary: "#1B1F27".into(),
            text_secondary: "#5F6878".into(),
            border_strong: "#CFD4DD".into(),
            accent_ui: "#385BDD".into(),
            danger: "#B43A3A".into(),
        }
    }

    pub fn default_dark() -> Self {
        Self {
            surface_1: "#1C2029".into(),
            text_primary: "#E3E6ED".into(),
            text_secondary: "#949CAC".into(),
            border_strong: "#343A48".into(),
            accent_ui: "#7995FF".into(),
            danger: "#F17171".into(),
        }
    }
}

impl Default for TrayPalette {
    fn default() -> Self {
        Self::default_dark()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayAppearance {
    pub theme: ThemeMode,
    pub light: TrayPalette,
    pub dark: TrayPalette,
    pub density: f64,
    pub radius_card: f64,
    pub radius_item: f64,
    pub ui_scale: f64,
    pub reduced_motion: bool,
    pub subtle_motion: bool,
}

impl Default for TrayAppearance {
    fn default() -> Self {
        Self {
            theme: ThemeMode::Dark,
            light: TrayPalette::default_light(),
            dark: TrayPalette::default_dark(),
            density: 1.0,
            radius_card: 10.0,
            radius_item: 6.0,
            ui_scale: 1.0,
            reduced_motion: false,
            subtle_motion: false,
        }
    }
}

pub struct TrayAppearanceState(Mutex<TrayAppearance>);

impl Default for TrayAppearanceState {
    fn default() -> Self {
        Self(Mutex::new(TrayAppearance::default()))
    }
}

impl TrayAppearanceState {
    pub fn get(&self) -> TrayAppearance {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set(&self, appearance: TrayAppearance) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = appearance;
    }
}

fn appearance_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("data").join(APPEARANCE_FILE))
}

pub fn init_appearance(app: &AppHandle) {
    if let Some(appearance) = appearance_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<TrayAppearance>(&s).ok())
    {
        app.state::<TrayAppearanceState>().set(appearance);
    }
}

#[tauri::command]
pub fn tray_set_appearance(app: AppHandle, appearance: TrayAppearance) -> AppResult<()> {
    let clamped = TrayAppearance {
        density: appearance.density.clamp(0.65, 1.5),
        radius_card: appearance.radius_card.clamp(2.0, 22.0),
        radius_item: appearance.radius_item.clamp(2.0, 16.0),
        ui_scale: appearance.ui_scale.clamp(0.5, 2.0),
        ..appearance
    };
    app.state::<TrayAppearanceState>().set(clamped.clone());
    if let Some(path) = appearance_file(&app) {
        if let Ok(json) = serde_json::to_string(&clamped) {
            let _ = std::fs::write(path, json);
        }
    }
    #[cfg(windows)]
    crate::tray_win32::notify_refresh();
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn right(&self) -> f64 {
        self.x + self.w
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
}

/// Logical row height scaled by interface density, matching `src/styles.css` (`--ctl-h`).
pub fn row_height(density: f64) -> f64 {
    (ROW_HEIGHT * density.clamp(0.65, 1.5)).max(24.0)
}

/// Logical height of the card for this many recent pages.
pub fn card_height(recent: usize, density: f64) -> f64 {
    let rows = 2 + recent;
    let separators = if recent > 0 { 2 } else { 1 };
    2.0 * (CARD_BORDER + CARD_PADDING)
        + row_height(density) * rows as f64
        + SEPARATOR_HEIGHT * separators as f64
}

fn clamp(value: f64, low: f64, high: f64) -> f64 {
    if high < low {
        low
    } else {
        value.max(low).min(high)
    }
}

/// Where the card's top-left corner goes (physical pixels). The card sits against the side of
/// the icon that faces into the screen, lined up with the icon's nearer corner, and is kept
/// inside the work area.
pub fn place_card(icon: Rect, card: (f64, f64), area: Rect, gap: f64, margin: f64) -> (f64, f64) {
    let (icon_cx, icon_cy) = icon.center();
    let (area_cx, area_cy) = area.center();
    let (cw, ch) = card;
    // The work area stops at the taskbar, so the icon lies outside it on the taskbar's side.
    let (x, y) = if icon.y >= area.bottom() - 1.0 {
        (corner_x(icon, cw, icon_cx, area_cx), icon.y - ch - gap)
    } else if icon.bottom() <= area.y + 1.0 {
        (corner_x(icon, cw, icon_cx, area_cx), icon.bottom() + gap)
    } else if icon.x >= area.right() - 1.0 {
        (icon.x - cw - gap, corner_y(icon, ch, icon_cy, area_cy))
    } else if icon.right() <= area.x + 1.0 {
        (icon.right() + gap, corner_y(icon, ch, icon_cy, area_cy))
    } else if icon_cy > area_cy {
        // An icon inside the work area (the hidden-icons flyout or auto-hide taskbar): open on the roomier side.
        (corner_x(icon, cw, icon_cx, area_cx), icon.y - ch - gap)
    } else {
        (corner_x(icon, cw, icon_cx, area_cx), icon.bottom() + gap)
    };
    (
        clamp(x, area.x + margin, area.right() - cw - margin),
        clamp(y, area.y + margin, area.bottom() - ch - margin),
    )
}

/// Right edges line up when the icon is in the right half of the screen, left edges otherwise.
fn corner_x(icon: Rect, card_w: f64, icon_cx: f64, area_cx: f64) -> f64 {
    if icon_cx >= area_cx {
        icon.right() - card_w
    } else {
        icon.x
    }
}

fn corner_y(icon: Rect, card_h: f64, icon_cy: f64, area_cy: f64) -> f64 {
    if icon_cy >= area_cy {
        icon.bottom() - card_h
    } else {
        icon.y
    }
}

/// Opens (or closes) the native tray menu next to the tray icon.
pub fn toggle_at(app: &AppHandle, icon: Rect) {
    #[cfg(windows)]
    crate::tray_win32::toggle_at(app, icon);
    #[cfg(not(windows))]
    {
        let _ = icon;
        crate::shell::show_window(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 1920.0,
        h: 1040.0,
    };
    const CARD: (f64, f64) = (232.0, 200.0);

    fn overlaps(a: Rect, b: Rect) -> bool {
        a.x < b.right() && b.x < a.right() && a.y < b.bottom() && b.y < a.bottom()
    }

    fn card_rect(at: (f64, f64)) -> Rect {
        Rect {
            x: at.0,
            y: at.1,
            w: CARD.0,
            h: CARD.1,
        }
    }

    #[test]
    fn bottom_taskbar_opens_above_with_the_right_edges_aligned() {
        let icon = Rect {
            x: 1700.0,
            y: 1040.0,
            w: 24.0,
            h: 24.0,
        };
        let at = place_card(icon, CARD, AREA, 6.0, 0.0);
        assert_eq!(at.1, 1040.0 - 200.0 - 6.0);
        assert_eq!(at.0 + CARD.0, icon.right());
        assert!(!overlaps(card_rect(at), icon));
    }

    #[test]
    fn top_taskbar_opens_below() {
        let area = Rect {
            x: 0.0,
            y: 40.0,
            w: 1920.0,
            h: 1040.0,
        };
        let icon = Rect {
            x: 1700.0,
            y: 16.0,
            w: 24.0,
            h: 24.0,
        };
        let at = place_card(icon, CARD, area, 6.0, 0.0);
        assert_eq!(at.1, icon.bottom() + 6.0);
        assert!(!overlaps(card_rect(at), icon));
    }

    #[test]
    fn side_taskbars_open_beside_the_icon() {
        let right = Rect {
            x: 0.0,
            y: 0.0,
            w: 1880.0,
            h: 1080.0,
        };
        let icon = Rect {
            x: 1880.0,
            y: 1000.0,
            w: 24.0,
            h: 24.0,
        };
        let at = place_card(icon, CARD, right, 6.0, 0.0);
        assert_eq!(at.0, icon.x - CARD.0 - 6.0);
        assert!(!overlaps(card_rect(at), icon));
        let left = Rect {
            x: 40.0,
            y: 0.0,
            w: 1880.0,
            h: 1080.0,
        };
        let icon = Rect {
            x: 8.0,
            y: 1000.0,
            w: 32.0,
            h: 24.0,
        };
        let at = place_card(icon, CARD, left, 6.0, 0.0);
        assert_eq!(at.0, icon.right() + 6.0);
        assert!(!overlaps(card_rect(at), icon));
    }

    #[test]
    fn stays_on_screen_near_the_edges_and_negative_monitors() {
        let icon = Rect {
            x: 1900.0,
            y: 1050.0,
            w: 24.0,
            h: 24.0,
        };
        let at = place_card(icon, CARD, AREA, 6.0, 8.0);
        assert!(at.0 + CARD.0 <= AREA.right() - 8.0);
        let neg_area = Rect {
            x: -1920.0,
            y: 0.0,
            w: 1920.0,
            h: 1040.0,
        };
        let neg_icon = Rect {
            x: -200.0,
            y: 1040.0,
            w: 24.0,
            h: 24.0,
        };
        let neg_at = place_card(neg_icon, CARD, neg_area, 6.0, 8.0);
        assert!(neg_at.0 >= neg_area.x + 8.0);
        assert!(neg_at.0 + CARD.0 <= neg_area.right() - 8.0);
    }

    #[test]
    fn height_grows_with_the_recent_pages_and_density() {
        assert!(card_height(3, 1.0) > card_height(0, 1.0));
        assert_eq!(card_height(0, 1.0), 2.0 * 7.0 + 64.0 + 9.0);
        assert!(card_height(2, 1.35) > card_height(2, 1.0));
        assert!(card_height(2, 0.72) < card_height(2, 1.0));
    }
}

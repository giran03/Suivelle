//! Native Win32 Layered Window implementation for the Suivelle system tray menu.
//! Renders a solid opaque, anti-aliased rounded card directly into a 32-bit premultiplied
//! BGRA DIB section with ClearType text, presented via `UpdateLayeredWindow` (`ULW_ALPHA`).

use crate::shell::{self, RecentPage, TrayIcon};
use crate::tray_popup::{
    card_height, place_card, row_height, Rect, ThemeMode, TrayAppearance, TrayAppearanceState,
    TrayRecent, CARD_BORDER, CARD_PADDING, CARD_WIDTH, GAP, SCREEN_MARGIN, SEPARATOR_HEIGHT,
};
use std::sync::atomic::{AtomicIsize, AtomicU64, Ordering};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, DrawTextW, GdiFlush,
    GetMonitorInfoW, MonitorFromPoint, SelectObject, SetBkMode, SetTextColor, AC_SRC_ALPHA,
    AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, CLEARTYPE_QUALITY,
    CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS, DT_END_ELLIPSIS, DT_LEFT,
    DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, FF_SWISS, HBITMAP, HDC, HFONT, MONITORINFO,
    MONITOR_DEFAULTTONEAREST, OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SetFocus, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT, VK_DOWN, VK_END,
    VK_ESCAPE, VK_HOME, VK_LBUTTON, VK_RBUTTON, VK_RETURN, VK_SPACE, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
    GetForegroundWindow, GetMessageW, GetWindowLongPtrW, LoadCursorW, PostMessageW,
    PostQuitMessage, RegisterClassExW, SetForegroundWindow, SetTimer, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, SystemParametersInfoW, TranslateMessage, UpdateLayeredWindow,
    CREATESTRUCTW, GWLP_USERDATA, HWND_TOPMOST, IDC_ARROW, MSG, SPI_GETCLIENTAREAANIMATION,
    SWP_NOACTIVATE, SW_SHOW, ULW_ALPHA, WA_INACTIVE, WM_ACTIVATE, WM_APP, WM_CLOSE, WM_DESTROY,
    WM_KEYDOWN, WM_KILLFOCUS, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCCREATE,
    WM_SETTINGCHANGE, WM_TIMER, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_POPUP,
};

const WM_TRAY_REFRESH: u32 = WM_APP + 1;
const WM_MOUSELEAVE: u32 = 0x02A3;
const TIMER_FADE: usize = 1;
const TIMER_OUTSIDE: usize = 2;
const REOPEN_GUARD_MS: u64 = 250;
const OUTSIDE_GRACE_MS: u128 = 150;

static OPEN_HWND: AtomicIsize = AtomicIsize::new(0);
static LAST_HIDDEN: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Notifies an open tray menu to re-read recent pages and appearance and repaint in-place.
pub fn notify_refresh() {
    let raw = OPEN_HWND.load(Ordering::SeqCst);
    if raw != 0 {
        unsafe {
            let _ = PostMessageW(
                Some(HWND(raw as *mut _)),
                WM_TRAY_REFRESH,
                WPARAM(0),
                LPARAM(0),
            );
        }
    }
}

/// Opens or closes the native tray menu anchored beside `icon`.
pub fn toggle_at(app: &AppHandle, icon: Rect) {
    let raw = OPEN_HWND.load(Ordering::SeqCst);
    if raw != 0 {
        LAST_HIDDEN.store(now_ms(), Ordering::SeqCst);
        unsafe {
            let _ = PostMessageW(Some(HWND(raw as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
        return;
    }
    if now_ms().saturating_sub(LAST_HIDDEN.load(Ordering::SeqCst)) < REOPEN_GUARD_MS {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("tray-menu".into())
        .spawn(move || {
            if let Err(err) = run_menu_window(app, icon) {
                tracing::warn!(%err, "native tray menu failed");
            }
        });
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IconKind {
    Open,
    Page,
    Quit,
}

#[derive(Clone)]
enum MenuAction {
    Open,
    Page(String),
    Quit,
}

#[derive(Clone)]
struct MenuItem {
    label: String,
    icon: IconKind,
    /// The page's own icon, when it has one; drawn instead of `icon`.
    picture: Option<TrayIcon>,
    primary: bool,
    danger: bool,
    disabled: bool,
    action: MenuAction,
    rect_y: i32,
    rect_h: i32,
}

struct SeparatorRect {
    y: i32,
    h: i32,
}

#[derive(Clone, Copy)]
struct Rgb {
    r: u8,
    g: u8,
    b: u8,
}

impl Rgb {
    fn parse(hex: &str, fallback: Self) -> Self {
        let s = hex.trim().trim_start_matches('#');
        if s.len() >= 6 {
            if let (Ok(r), Ok(g), Ok(b)) = (
                u8::from_str_radix(&s[0..2], 16),
                u8::from_str_radix(&s[2..4], 16),
                u8::from_str_radix(&s[4..6], 16),
            ) {
                return Self { r, g, b };
            }
        }
        fallback
    }

    fn blend(self, other: Self, t: f32) -> Self {
        let inv = 1.0 - t;
        Self {
            r: (self.r as f32 * inv + other.r as f32 * t)
                .round()
                .clamp(0.0, 255.0) as u8,
            g: (self.g as f32 * inv + other.g as f32 * t)
                .round()
                .clamp(0.0, 255.0) as u8,
            b: (self.b as f32 * inv + other.b as f32 * t)
                .round()
                .clamp(0.0, 255.0) as u8,
        }
    }

    fn colorref(self) -> COLORREF {
        COLORREF((self.r as u32) | ((self.g as u32) << 8) | ((self.b as u32) << 16))
    }

    fn bgra(self, a: u8) -> u32 {
        ((a as u32) << 24) | ((self.r as u32) << 16) | ((self.g as u32) << 8) | (self.b as u32)
    }
}

struct ResolvedColors {
    surface: Rgb,
    text_primary: Rgb,
    text_secondary: Rgb,
    border: Rgb,
    accent_ui: Rgb,
    danger: Rgb,
    hover_bg: Rgb,
    pressed_bg: Rgb,
    danger_hover_bg: Rgb,
    danger_pressed_bg: Rgb,
    hairline: Rgb,
}

fn system_uses_light_theme() -> bool {
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    hkcu.open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|k| k.get_value::<u32, _>("AppsUseLightTheme"))
        .map(|v| v != 0)
        .unwrap_or(false)
}

fn resolve_colors(app: &TrayAppearance) -> ResolvedColors {
    let is_light = match app.theme {
        ThemeMode::Light => true,
        ThemeMode::Dark => false,
        ThemeMode::System => system_uses_light_theme(),
    };
    let pal = if is_light { &app.light } else { &app.dark };
    let def_s = if is_light {
        Rgb {
            r: 241,
            g: 243,
            b: 246,
        }
    } else {
        Rgb {
            r: 28,
            g: 32,
            b: 41,
        }
    };
    let def_tp = if is_light {
        Rgb {
            r: 27,
            g: 31,
            b: 39,
        }
    } else {
        Rgb {
            r: 227,
            g: 230,
            b: 237,
        }
    };
    let def_ts = if is_light {
        Rgb {
            r: 95,
            g: 104,
            b: 120,
        }
    } else {
        Rgb {
            r: 148,
            g: 156,
            b: 172,
        }
    };
    let def_bd = if is_light {
        Rgb {
            r: 207,
            g: 212,
            b: 221,
        }
    } else {
        Rgb {
            r: 52,
            g: 58,
            b: 72,
        }
    };
    let def_ac = if is_light {
        Rgb {
            r: 56,
            g: 91,
            b: 221,
        }
    } else {
        Rgb {
            r: 121,
            g: 149,
            b: 255,
        }
    };
    let def_dg = if is_light {
        Rgb {
            r: 180,
            g: 58,
            b: 58,
        }
    } else {
        Rgb {
            r: 241,
            g: 113,
            b: 113,
        }
    };

    let surface = Rgb::parse(&pal.surface_1, def_s);
    let text_primary = Rgb::parse(&pal.text_primary, def_tp);
    let text_secondary = Rgb::parse(&pal.text_secondary, def_ts);
    let border = Rgb::parse(&pal.border_strong, def_bd);
    let accent_ui = Rgb::parse(&pal.accent_ui, def_ac);
    let danger = Rgb::parse(&pal.danger, def_dg);

    ResolvedColors {
        surface,
        text_primary,
        text_secondary,
        border,
        accent_ui,
        danger,
        hover_bg: surface.blend(accent_ui, 0.12),
        pressed_bg: surface.blend(accent_ui, 0.20),
        danger_hover_bg: surface.blend(danger, 0.14),
        danger_pressed_bg: surface.blend(danger, 0.22),
        hairline: surface.blend(text_primary, 0.12),
    }
}

struct DibSurface {
    hdc: HDC,
    bitmap: HBITMAP,
    old_obj: windows::Win32::Graphics::Gdi::HGDIOBJ,
    bits: *mut u32,
    width: i32,
    height: i32,
}

impl DibSurface {
    fn new(width: i32, height: i32) -> windows::core::Result<Self> {
        unsafe {
            let hdc = CreateCompatibleDC(None);
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // Top-down DIB
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut raw_bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let bitmap = CreateDIBSection(Some(hdc), &bmi, DIB_RGB_COLORS, &mut raw_bits, None, 0)?;
            let old_obj = SelectObject(hdc, bitmap.into());
            Ok(Self {
                hdc,
                bitmap,
                old_obj,
                bits: raw_bits as *mut u32,
                width,
                height,
            })
        }
    }

    fn pixels_mut(&mut self) -> &mut [u32] {
        unsafe { std::slice::from_raw_parts_mut(self.bits, (self.width * self.height) as usize) }
    }
}

impl Drop for DibSurface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.hdc, self.old_obj);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.hdc);
        }
    }
}

struct MenuWindowState {
    app: AppHandle,
    icon_rect: Rect,
    dpi_scale: f64,
    work_area: Rect,
    win_x: i32,
    win_y: i32,
    win_w: i32,
    win_h: i32,
    items: Vec<MenuItem>,
    separators: Vec<SeparatorRect>,
    appearance: TrayAppearance,
    hovered: Option<usize>,
    pressed: Option<usize>,
    kbd_focus: Option<usize>,
    tracking_leave: bool,
    activated: bool,
    opened_at: Instant,
    alpha: u8,
    fade_duration_ms: u64,
    chosen: Option<MenuAction>,
    dib: Option<DibSurface>,
}

impl MenuWindowState {
    fn effective_scale(&self) -> f64 {
        self.dpi_scale * self.appearance.ui_scale
    }

    fn rebuild_layout(&mut self) {
        let recent: Vec<RecentPage> = self.app.state::<TrayRecent>().get();
        self.appearance = self.app.state::<TrayAppearanceState>().get();
        let scale = self.effective_scale();
        let row_h = (row_height(self.appearance.density) * scale).round() as i32;
        let sep_h = (SEPARATOR_HEIGHT * scale).round().max(5.0) as i32;
        let pad = ((CARD_BORDER + CARD_PADDING) * scale).round() as i32;

        let mut items = Vec::new();
        let mut separators = Vec::new();
        let mut y = pad;

        items.push(MenuItem {
            label: "Open Suivelle".into(),
            icon: IconKind::Open,
            picture: None,
            primary: true,
            danger: false,
            disabled: false,
            action: MenuAction::Open,
            rect_y: y,
            rect_h: row_h,
        });
        y += row_h;

        if !recent.is_empty() {
            separators.push(SeparatorRect { y, h: sep_h });
            y += sep_h;
            for page in recent {
                let title = page.title.trim();
                items.push(MenuItem {
                    label: if title.is_empty() {
                        "Untitled".into()
                    } else {
                        title.into()
                    },
                    icon: IconKind::Page,
                    picture: page.icon,
                    primary: false,
                    danger: false,
                    disabled: false,
                    action: MenuAction::Page(page.id),
                    rect_y: y,
                    rect_h: row_h,
                });
                y += row_h;
            }
        }

        separators.push(SeparatorRect { y, h: sep_h });
        y += sep_h;

        items.push(MenuItem {
            label: "Quit".into(),
            icon: IconKind::Quit,
            picture: None,
            primary: false,
            danger: true,
            disabled: false,
            action: MenuAction::Quit,
            rect_y: y,
            rect_h: row_h,
        });

        let logical_w = CARD_WIDTH;
        let logical_h = card_height(items.len().saturating_sub(2), self.appearance.density);
        let cw = (logical_w * scale).round() as i32;
        let ch = (logical_h * scale).round() as i32;

        let (px, py) = place_card(
            self.icon_rect,
            (cw as f64, ch as f64),
            self.work_area,
            GAP * self.dpi_scale,
            SCREEN_MARGIN * self.dpi_scale,
        );

        self.win_x = px.round() as i32;
        self.win_y = py.round() as i32;
        self.win_w = cw;
        self.win_h = ch;
        self.items = items;
        self.separators = separators;
        if self.hovered.is_some_and(|i| i >= self.items.len()) {
            self.hovered = None;
        }
        if self.pressed.is_some_and(|i| i >= self.items.len()) {
            self.pressed = None;
        }
        if self.kbd_focus.is_some_and(|i| i >= self.items.len()) {
            self.kbd_focus = None;
        }
    }

    fn hit_test(&self, x: i32, y: i32) -> Option<usize> {
        let pad_x = ((CARD_BORDER + CARD_PADDING) * self.effective_scale()).round() as i32;
        if x < pad_x || x >= self.win_w - pad_x {
            return None;
        }
        self.items
            .iter()
            .position(|item| !item.disabled && y >= item.rect_y && y < item.rect_y + item.rect_h)
    }

    fn render_and_present(&mut self, hwnd: HWND) {
        let w = self.win_w;
        let h = self.win_h;
        if w <= 0 || h <= 0 {
            return;
        }
        let need_new_dib = self
            .dib
            .as_ref()
            .is_none_or(|d| d.width != w || d.height != h);
        if need_new_dib {
            match DibSurface::new(w, h) {
                Ok(d) => self.dib = Some(d),
                Err(_) => return,
            }
        }

        let colors = resolve_colors(&self.appearance);
        let scale = self.effective_scale() as f32;
        let border_px = (CARD_BORDER as f32 * scale).max(1.0);
        let card_r = (self.appearance.radius_card as f32 * scale).max(2.0);
        let item_r = (self.appearance.radius_item as f32 * scale).max(2.0);
        let pad_x = ((CARD_BORDER + CARD_PADDING) as f32 * scale).round() as i32;

        let dib = self.dib.as_mut().unwrap();
        let pixels = dib.pixels_mut();
        let fw = w as f32;
        let fh = h as f32;

        // 1. Solid opaque card interior + anti-aliased 1px border + transparent outer corners.
        for py in 0..h {
            let cy = py as f32 + 0.5;
            for px in 0..w {
                let cx = px as f32 + 0.5;
                let d = sd_rounded_rect(cx, cy, 0.0, 0.0, fw, fh, card_r);
                let idx = (py * w + px) as usize;
                if d >= 0.5 {
                    pixels[idx] = 0;
                } else {
                    let outer_cov = (0.5 - d).clamp(0.0, 1.0);
                    let border_cov = ((d + border_px + 0.5).clamp(0.0, 1.0)) * outer_cov;
                    let col = if border_cov > 0.0 {
                        colors.surface.blend(colors.border, border_cov)
                    } else {
                        colors.surface
                    };
                    let a = (outer_cov * 255.0).round() as u8;
                    pixels[idx] = premul_bgra(col, a);
                }
            }
        }

        // 2. Separators.
        let sep_inset = (6.0 * scale).round() as i32;
        let sep_x0 = (pad_x + sep_inset).max(0);
        let sep_x1 = (w - pad_x - sep_inset).min(w);
        let sep_thick = (1.0 * scale).round().max(1.0) as i32;
        for sep in &self.separators {
            let sy0 = sep.y + (sep.h - sep_thick) / 2;
            let sy1 = (sy0 + sep_thick).min(h);
            for py in sy0.max(0)..sy1 {
                for px in sep_x0..sep_x1 {
                    pixels[(py * w + px) as usize] = colors.hairline.bgra(255);
                }
            }
        }

        // 3. Item pills (hover / keyboard focus / pressed) and vector icons.
        let item_x0 = pad_x as f32;
        let item_x1 = (w - pad_x) as f32;
        let icon_size = 16.0 * scale;
        let icon_left = item_x0 + 10.0 * scale;
        let stroke = 1.6 * scale;

        for (i, item) in self.items.iter().enumerate() {
            let is_pressed = self.pressed == Some(i);
            let is_hovered = self.hovered == Some(i);
            let is_focused = self.kbd_focus == Some(i);
            let iy0 = item.rect_y as f32;
            let iy1 = (item.rect_y + item.rect_h) as f32;

            if is_pressed || is_hovered || is_focused {
                let fill = if item.danger {
                    if is_pressed {
                        colors.danger_pressed_bg
                    } else {
                        colors.danger_hover_bg
                    }
                } else if is_pressed {
                    colors.pressed_bg
                } else {
                    colors.hover_bg
                };
                let ring_col = if item.danger {
                    colors.danger
                } else {
                    colors.accent_ui
                };
                let y_start = (item.rect_y - 1).max(0);
                let y_end = (item.rect_y + item.rect_h + 1).min(h);
                let x_start = (pad_x - 1).max(0);
                let x_end = (w - pad_x + 1).min(w);

                for py in y_start..y_end {
                    let cy = py as f32 + 0.5;
                    for px in x_start..x_end {
                        let cx = px as f32 + 0.5;
                        let d = sd_rounded_rect(cx, cy, item_x0, iy0, item_x1, iy1, item_r);
                        if d < 0.5 {
                            let cov = (0.5 - d).clamp(0.0, 1.0);
                            let idx = (py * w + px) as usize;
                            let base = unpack_rgb(pixels[idx]);
                            let mut blended = base.blend(fill, cov);
                            if is_focused && d > -1.5 && d < 0.5 {
                                let ring_cov = ((d + 1.5).clamp(0.0, 1.0)) * cov;
                                blended = blended.blend(ring_col, ring_cov);
                            }
                            pixels[idx] = blended.bgra(255);
                        }
                    }
                }
            }

            let icon_col = if item.danger && (is_hovered || is_focused || is_pressed) {
                colors.danger
            } else if item.primary || (!item.danger && (is_hovered || is_focused || is_pressed)) {
                colors.accent_ui
            } else {
                colors.text_secondary
            };
            let icon_top = iy0 + (item.rect_h as f32 - icon_size) * 0.5;
            let drawn = item.picture.as_ref().is_some_and(|p| {
                draw_picture(pixels, w, h, p, icon_left, icon_top, icon_size, icon_col)
            });
            if !drawn {
                draw_icon(
                    pixels, w, h, item.icon, icon_left, icon_top, icon_size, stroke, icon_col,
                );
            }
        }

        // 4. ClearType text via GDI DrawTextW, then restore alpha=255 on interior pixels.
        unsafe {
            let font_px = -((14.0 * scale).round() as i32);
            let font_normal = create_ui_font(font_px, 400);
            let font_semi = create_ui_font(font_px, 600);
            SetBkMode(dib.hdc, TRANSPARENT);

            let text_left = (icon_left + icon_size + 10.0 * scale).round() as i32;
            let text_right = (item_x1 - 10.0 * scale).round() as i32;

            for item in &self.items {
                let font = if item.primary { font_semi } else { font_normal };
                let prev_font = SelectObject(dib.hdc, font.into());
                SetTextColor(dib.hdc, colors.text_primary.colorref());
                let mut rect = RECT {
                    left: text_left,
                    top: item.rect_y,
                    right: text_right,
                    bottom: item.rect_y + item.rect_h,
                };
                let mut wide: Vec<u16> = item.label.encode_utf16().collect();
                DrawTextW(
                    dib.hdc,
                    &mut wide,
                    &mut rect,
                    DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX,
                );
                SelectObject(dib.hdc, prev_font);
            }

            let _ = DeleteObject(font_normal.into());
            let _ = DeleteObject(font_semi.into());
            let _ = GdiFlush();
        }

        // Restore opaque alpha=255 on interior pixels touched by GDI ClearType.
        let pixels = self.dib.as_mut().unwrap().pixels_mut();
        for py in 0..h {
            let cy = py as f32 + 0.5;
            for px in 0..w {
                let cx = px as f32 + 0.5;
                let d = sd_rounded_rect(cx, cy, 0.0, 0.0, fw, fh, card_r);
                if d <= -0.5 {
                    pixels[(py * w + px) as usize] |= 0xFF00_0000;
                }
            }
        }

        // 5. Present via UpdateLayeredWindow.
        let dib = self.dib.as_ref().unwrap();
        let pt_dst = POINT {
            x: self.win_x,
            y: self.win_y,
        };
        let pt_src = POINT { x: 0, y: 0 };
        let size = SIZE { cx: w, cy: h };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: self.alpha,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        unsafe {
            let _ = UpdateLayeredWindow(
                hwnd,
                None,
                Some(&pt_dst),
                Some(&size),
                Some(dib.hdc),
                Some(&pt_src),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            );
        }
    }
}

unsafe fn create_ui_font(height: i32, weight: i32) -> HFONT {
    CreateFontW(
        height,
        0,
        0,
        0,
        weight,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        CLEARTYPE_QUALITY,
        (DEFAULT_PITCH.0 | FF_SWISS.0) as u32,
        w!("Segoe UI Variable Text"),
    )
}

fn sd_rounded_rect(px: f32, py: f32, x0: f32, y0: f32, x1: f32, y1: f32, r: f32) -> f32 {
    let cx = (x0 + x1) * 0.5;
    let cy = (y0 + y1) * 0.5;
    let hx = ((x1 - x0) * 0.5 - r).max(0.0);
    let hy = ((y1 - y0) * 0.5 - r).max(0.0);
    let qx = (px - cx).abs() - hx;
    let qy = (py - cy).abs() - hy;
    let out_dist = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    let in_dist = qx.max(qy).min(0.0);
    out_dist + in_dist - r
}

fn premul_bgra(c: Rgb, a: u8) -> u32 {
    let af = a as f32 / 255.0;
    let r = (c.r as f32 * af).round() as u32;
    let g = (c.g as f32 * af).round() as u32;
    let b = (c.b as f32 * af).round() as u32;
    ((a as u32) << 24) | (r << 16) | (g << 8) | b
}

fn unpack_rgb(bgra: u32) -> Rgb {
    Rgb {
        r: ((bgra >> 16) & 0xFF) as u8,
        g: ((bgra >> 8) & 0xFF) as u8,
        b: (bgra & 0xFF) as u8,
    }
}

fn blend_pixel(pixels: &mut [u32], w: i32, h: i32, x: i32, y: i32, col: Rgb, cov: f32) {
    if x < 0 || y < 0 || x >= w || y >= h || cov <= 0.0 {
        return;
    }
    let idx = (y * w + x) as usize;
    let base = unpack_rgb(pixels[idx]);
    pixels[idx] = base.blend(col, cov.clamp(0.0, 1.0)).bgra(255);
}

/// Draws a page's own icon (box-filtered down from the frontend's raster) into the icon square.
/// Returns false when the data is malformed so the caller can fall back to the default glyph.
#[allow(clippy::too_many_arguments)]
fn draw_picture(
    pixels: &mut [u32],
    w: i32,
    h: i32,
    pic: &TrayIcon,
    left: f32,
    top: f32,
    size: f32,
    tint: Rgb,
) -> bool {
    let n = pic.size as usize;
    if n == 0 || pic.rgba.len() != n * n * 4 {
        return false;
    }
    let side = size.round().max(1.0) as i32;
    let (x0, y0) = (left.round() as i32, top.round() as i32);
    let ratio = n as f32 / side as f32;
    for dy in 0..side {
        for dx in 0..side {
            let sx0 = ((dx as f32 * ratio).floor() as usize).min(n - 1);
            let sx1 = (((dx + 1) as f32 * ratio).ceil() as usize).clamp(sx0 + 1, n);
            let sy0 = ((dy as f32 * ratio).floor() as usize).min(n - 1);
            let sy1 = (((dy + 1) as f32 * ratio).ceil() as usize).clamp(sy0 + 1, n);
            let (mut a, mut r, mut g, mut b, mut count) = (0.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32);
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let i = (sy * n + sx) * 4;
                    let pa = pic.rgba[i + 3] as f32 / 255.0;
                    r += pic.rgba[i] as f32 * pa;
                    g += pic.rgba[i + 1] as f32 * pa;
                    b += pic.rgba[i + 2] as f32 * pa;
                    a += pa;
                    count += 1.0;
                }
            }
            if a <= 0.0 || count <= 0.0 {
                continue;
            }
            let col = if pic.tint {
                tint
            } else {
                Rgb {
                    r: (r / a).round() as u8,
                    g: (g / a).round() as u8,
                    b: (b / a).round() as u8,
                }
            };
            blend_pixel(pixels, w, h, x0 + dx, y0 + dy, col, a / count);
        }
    }
    true
}

#[allow(clippy::too_many_arguments)]
fn draw_segment(
    pixels: &mut [u32],
    w: i32,
    h: i32,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    half_stroke: f32,
    col: Rgb,
) {
    let min_x = (x0.min(x1) - half_stroke - 1.5).floor() as i32;
    let max_x = (x0.max(x1) + half_stroke + 1.5).ceil() as i32;
    let min_y = (y0.min(y1) - half_stroke - 1.5).floor() as i32;
    let max_y = (y0.max(y1) + half_stroke + 1.5).ceil() as i32;
    let dx = x1 - x0;
    let dy = y1 - y0;
    let len_sq = dx * dx + dy * dy;

    for py in min_y..=max_y {
        let p_y = py as f32 + 0.5;
        for px in min_x..=max_x {
            let p_x = px as f32 + 0.5;
            let t = if len_sq > 0.0 {
                (((p_x - x0) * dx + (p_y - y0) * dy) / len_sq).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let dist = ((p_x - (x0 + t * dx)).powi(2) + (p_y - (y0 + t * dy)).powi(2)).sqrt();
            let cov = (half_stroke + 0.5 - dist).clamp(0.0, 1.0);
            if cov > 0.0 {
                blend_pixel(pixels, w, h, px, py, col, cov);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_icon(
    pixels: &mut [u32],
    w: i32,
    h: i32,
    kind: IconKind,
    ox: f32,
    oy: f32,
    size: f32,
    stroke: f32,
    col: Rgb,
) {
    let s = size / 24.0;
    let hs = stroke * 0.5;
    let seg = |pixels: &mut [u32], x0: f32, y0: f32, x1: f32, y1: f32| {
        draw_segment(
            pixels,
            w,
            h,
            ox + x0 * s,
            oy + y0 * s,
            ox + x1 * s,
            oy + y1 * s,
            hs,
            col,
        );
    };
    match kind {
        IconKind::Open => {
            seg(pixels, 4.0, 5.0, 20.0, 5.0);
            seg(pixels, 20.0, 5.0, 20.0, 19.0);
            seg(pixels, 20.0, 19.0, 4.0, 19.0);
            seg(pixels, 4.0, 19.0, 4.0, 5.0);
            seg(pixels, 4.0, 9.0, 20.0, 9.0);
        }
        IconKind::Page => {
            seg(pixels, 7.0, 3.0, 14.0, 3.0);
            seg(pixels, 14.0, 3.0, 18.0, 7.0);
            seg(pixels, 18.0, 7.0, 18.0, 21.0);
            seg(pixels, 18.0, 21.0, 7.0, 21.0);
            seg(pixels, 7.0, 21.0, 7.0, 3.0);
            seg(pixels, 14.0, 3.0, 14.0, 7.0);
            seg(pixels, 14.0, 7.0, 18.0, 7.0);
        }
        IconKind::Quit => {
            seg(pixels, 12.0, 3.0, 12.0, 11.0);
            let cx = ox + 12.0 * s;
            let cy = oy + 13.0 * s;
            let radius = 7.0 * s;
            let min_x = (cx - radius - hs - 1.5).floor() as i32;
            let max_x = (cx + radius + hs + 1.5).ceil() as i32;
            let min_y = (cy - radius - hs - 1.5).floor() as i32;
            let max_y = (cy + radius + hs + 1.5).ceil() as i32;
            for py in min_y..=max_y {
                let p_y = py as f32 + 0.5;
                for px in min_x..=max_x {
                    let p_x = px as f32 + 0.5;
                    let dx = p_x - cx;
                    let dy = p_y - cy;
                    // Open gap at top (~40 degrees each side of -90 deg).
                    let angle = dy.atan2(dx);
                    let top_gap = (angle + std::f32::consts::FRAC_PI_2).abs();
                    if top_gap < 0.72 {
                        continue;
                    }
                    let dist = ((dx * dx + dy * dy).sqrt() - radius).abs();
                    let cov = (hs + 0.5 - dist).clamp(0.0, 1.0);
                    if cov > 0.0 {
                        blend_pixel(pixels, w, h, px, py, col, cov);
                    }
                }
            }
        }
    }
}

fn client_animations_enabled() -> bool {
    let mut enabled: i32 = 1;
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut enabled as *mut _ as *mut _),
            Default::default(),
        );
    }
    enabled != 0
}

fn resolve_monitor_info(icon: Rect) -> (Rect, f64, Rect) {
    let mut effective_icon = icon;
    if effective_icon.w <= 0.0 || effective_icon.h <= 0.0 {
        let mut pt = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut pt);
        }
        effective_icon = Rect {
            x: pt.x as f64,
            y: pt.y as f64,
            w: 1.0,
            h: 1.0,
        };
    }
    let (cx, cy) = effective_icon.center();
    let monitor = unsafe {
        MonitorFromPoint(
            POINT {
                x: cx.round() as i32,
                y: cy.round() as i32,
            },
            MONITOR_DEFAULTTONEAREST,
        )
    };
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let work_area = if unsafe { GetMonitorInfoW(monitor, &mut mi).as_bool() } {
        Rect {
            x: mi.rcWork.left as f64,
            y: mi.rcWork.top as f64,
            w: (mi.rcWork.right - mi.rcWork.left) as f64,
            h: (mi.rcWork.bottom - mi.rcWork.top) as f64,
        }
    } else {
        Rect {
            x: 0.0,
            y: 0.0,
            w: 1920.0,
            h: 1040.0,
        }
    };
    let mut dpi_x: u32 = 96;
    let mut dpi_y: u32 = 96;
    let dpi_scale = if unsafe {
        GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y)
    }
    .is_ok()
    {
        (dpi_x as f64 / 96.0).max(1.0)
    } else {
        1.0
    };
    (effective_icon, dpi_scale, work_area)
}

fn run_menu_window(app: AppHandle, icon: Rect) -> windows::core::Result<()> {
    let (icon_rect, dpi_scale, work_area) = resolve_monitor_info(icon);
    let appearance = app.state::<TrayAppearanceState>().get();
    let animate = client_animations_enabled() && !appearance.reduced_motion;
    let fade_duration_ms = if !animate {
        0
    } else if appearance.subtle_motion {
        60
    } else {
        110
    };

    let mut state = Box::new(MenuWindowState {
        app: app.clone(),
        icon_rect,
        dpi_scale,
        work_area,
        win_x: 0,
        win_y: 0,
        win_w: 0,
        win_h: 0,
        items: Vec::new(),
        separators: Vec::new(),
        appearance,
        hovered: None,
        pressed: None,
        kbd_focus: None,
        tracking_leave: false,
        activated: false,
        opened_at: Instant::now(),
        alpha: if animate { 0 } else { 255 },
        fade_duration_ms,
        chosen: None,
        dib: None,
    });
    state.rebuild_layout();

    let hmodule = unsafe { GetModuleHandleW(None)? };
    let class_name: PCWSTR = w!("SuivelleTrayMenu");
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(wnd_proc),
        hInstance: hmodule.into(),
        hCursor: unsafe { LoadCursorW(None, IDC_ARROW)? },
        lpszClassName: class_name,
        ..Default::default()
    };
    unsafe {
        RegisterClassExW(&wc);
    }

    let state_ptr = Box::into_raw(state);
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            class_name,
            w!("Suivelle"),
            WS_POPUP,
            (*state_ptr).win_x,
            (*state_ptr).win_y,
            (*state_ptr).win_w,
            (*state_ptr).win_h,
            None,
            None,
            Some(hmodule.into()),
            Some(state_ptr as *const _),
        )
    };
    let hwnd = match hwnd {
        Ok(h) => h,
        Err(e) => {
            unsafe { drop(Box::from_raw(state_ptr)) };
            return Err(e);
        }
    };

    OPEN_HWND.store(hwnd.0 as isize, Ordering::SeqCst);

    // Render frame 0 before showing the window so there is zero wrong-theme flash.
    unsafe {
        (*state_ptr).render_and_present(hwnd);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
        let _ = SetFocus(Some(hwnd));
        (*state_ptr).activated = true;
        if (*state_ptr).fade_duration_ms > 0 {
            SetTimer(Some(hwnd), TIMER_FADE, 16, None);
        }
        SetTimer(Some(hwnd), TIMER_OUTSIDE, 50, None);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    OPEN_HWND.store(0, Ordering::SeqCst);
    LAST_HIDDEN.store(now_ms(), Ordering::SeqCst);

    let final_state = unsafe { Box::from_raw(state_ptr) };
    if let Some(action) = final_state.chosen {
        execute_action(&final_state.app, action);
    }
    Ok(())
}

fn execute_action(app: &AppHandle, action: MenuAction) {
    match action {
        MenuAction::Open => shell::show_window(app),
        MenuAction::Page(id) => {
            shell::show_window(app);
            let _ = app.emit("open-page", id);
        }
        MenuAction::Quit => app.exit(0),
    }
}

fn move_focus(state: &mut MenuWindowState, delta: isize) {
    let enabled: Vec<usize> = state
        .items
        .iter()
        .enumerate()
        .filter(|(_, item)| !item.disabled)
        .map(|(i, _)| i)
        .collect();
    if enabled.is_empty() {
        return;
    }
    let next = match state
        .kbd_focus
        .and_then(|cur| enabled.iter().position(|&i| i == cur))
    {
        Some(pos) => {
            let len = enabled.len() as isize;
            let idx = ((pos as isize + delta).rem_euclid(len)) as usize;
            enabled[idx]
        }
        None => {
            if delta >= 0 {
                enabled[0]
            } else {
                *enabled.last().unwrap()
            }
        }
    };
    state.kbd_focus = Some(next);
    state.hovered = None;
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCCREATE {
        let cs = &*(lparam.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, cs.lpCreateParams as isize);
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut MenuWindowState;
    if ptr.is_null() {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
    let state = &mut *ptr;

    match msg {
        WM_MOUSEMOVE => {
            if !state.tracking_leave {
                let mut tme = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                if TrackMouseEvent(&mut tme).is_ok() {
                    state.tracking_leave = true;
                }
            }
            let x = (lparam.0 & 0xFFFF) as i16 as i32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
            let hit = state.hit_test(x, y);
            if hit != state.hovered {
                state.hovered = hit;
                if hit.is_some() {
                    state.kbd_focus = None;
                }
                state.render_and_present(hwnd);
            }
            LRESULT(0)
        }
        WM_MOUSELEAVE => {
            state.tracking_leave = false;
            if state.hovered.is_some() || state.pressed.is_some() {
                state.hovered = None;
                state.pressed = None;
                state.render_and_present(hwnd);
            }
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            let x = (lparam.0 & 0xFFFF) as i16 as i32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
            let hit = state.hit_test(x, y);
            state.pressed = hit;
            state.hovered = hit;
            state.render_and_present(hwnd);
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let x = (lparam.0 & 0xFFFF) as i16 as i32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
            let hit = state.hit_test(x, y);
            let pressed = state.pressed.take();
            if let (Some(p), Some(h)) = (pressed, hit) {
                if p == h {
                    state.chosen = Some(state.items[h].action.clone());
                    let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
                    return LRESULT(0);
                }
            }
            state.render_and_present(hwnd);
            LRESULT(0)
        }
        WM_KEYDOWN => {
            let vk = wparam.0 as u16;
            if vk == VK_ESCAPE.0 {
                let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            } else if vk == VK_DOWN.0 {
                move_focus(state, 1);
                state.render_and_present(hwnd);
            } else if vk == VK_UP.0 {
                move_focus(state, -1);
                state.render_and_present(hwnd);
            } else if vk == VK_HOME.0 {
                state.kbd_focus = state.items.iter().position(|i| !i.disabled);
                state.hovered = None;
                state.render_and_present(hwnd);
            } else if vk == VK_END.0 {
                state.kbd_focus = state.items.iter().rposition(|i| !i.disabled);
                state.hovered = None;
                state.render_and_present(hwnd);
            } else if vk == VK_RETURN.0 || vk == VK_SPACE.0 {
                if let Some(idx) = state.kbd_focus.or(state.hovered) {
                    if let Some(item) = state.items.get(idx) {
                        if !item.disabled {
                            state.chosen = Some(item.action.clone());
                            let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
                        }
                    }
                }
            }
            LRESULT(0)
        }
        WM_TIMER => {
            if wparam.0 == TIMER_FADE {
                let elapsed = state.opened_at.elapsed().as_millis() as u64;
                if elapsed >= state.fade_duration_ms {
                    state.alpha = 255;
                    let _ =
                        windows::Win32::UI::WindowsAndMessaging::KillTimer(Some(hwnd), TIMER_FADE);
                } else {
                    state.alpha = ((elapsed as f32 / state.fade_duration_ms as f32) * 255.0)
                        .round()
                        .clamp(0.0, 255.0) as u8;
                }
                state.render_and_present(hwnd);
            } else if wparam.0 == TIMER_OUTSIDE
                && state.opened_at.elapsed().as_millis() >= OUTSIDE_GRACE_MS
            {
                let fg = GetForegroundWindow();
                let ldown = GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0;
                let rdown = GetAsyncKeyState(VK_RBUTTON.0 as i32) < 0;
                let mut outside_click = false;
                if ldown || rdown {
                    let mut pt = POINT::default();
                    if GetCursorPos(&mut pt).is_ok() {
                        outside_click = pt.x < state.win_x
                            || pt.x >= state.win_x + state.win_w
                            || pt.y < state.win_y
                            || pt.y >= state.win_y + state.win_h;
                    }
                }
                if fg != hwnd || outside_click {
                    let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
                }
            }
            LRESULT(0)
        }
        WM_SETTINGCHANGE | WM_TRAY_REFRESH => {
            let old_w = state.win_w;
            let old_h = state.win_h;
            let old_x = state.win_x;
            let old_y = state.win_y;
            state.rebuild_layout();
            if state.win_w != old_w
                || state.win_h != old_h
                || state.win_x != old_x
                || state.win_y != old_y
            {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    state.win_x,
                    state.win_y,
                    state.win_w,
                    state.win_h,
                    SWP_NOACTIVATE,
                );
            }
            state.render_and_present(hwnd);
            LRESULT(0)
        }
        WM_ACTIVATE => {
            if (wparam.0 & 0xFFFF) as u32 == WA_INACTIVE && state.activated {
                let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
            LRESULT(0)
        }
        WM_KILLFOCUS => {
            if state.activated {
                let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

#[cfg(test)]
mod picture_tests {
    use super::*;

    fn icon(tint: bool) -> TrayIcon {
        TrayIcon {
            size: 4,
            rgba: [255, 0, 0, 255].repeat(16),
            tint,
        }
    }

    #[test]
    fn picture_keeps_its_own_colours() {
        let mut px = vec![0xFF00_0000u32; 16];
        assert!(draw_picture(
            &mut px,
            4,
            4,
            &icon(false),
            0.0,
            0.0,
            4.0,
            Rgb { r: 0, g: 0, b: 255 }
        ));
        assert_eq!(px[5] & 0x00FF_FFFF, 0x00FF_0000);
    }

    #[test]
    fn mask_takes_the_tray_colour() {
        let mut px = vec![0xFF00_0000u32; 16];
        assert!(draw_picture(
            &mut px,
            4,
            4,
            &icon(true),
            0.0,
            0.0,
            4.0,
            Rgb { r: 0, g: 0, b: 255 }
        ));
        assert_eq!(px[5] & 0x00FF_FFFF, 0x0000_00FF);
    }

    #[test]
    fn malformed_data_falls_back() {
        let mut px = vec![0u32; 16];
        let bad = TrayIcon {
            size: 4,
            rgba: vec![0; 3],
            tint: false,
        };
        assert!(!draw_picture(
            &mut px,
            4,
            4,
            &bad,
            0.0,
            0.0,
            4.0,
            Rgb { r: 0, g: 0, b: 0 }
        ));
    }
}

use super::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Crop {
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.x >= 0.0
            && self.y >= 0.0
            && self.width > 0.0
            && self.height > 0.0
            && self.x + self.width <= 1.000001
            && self.y + self.height <= 1.000001
    }
}
pub fn validate(value: &serde_json::Value) -> AppResult<()> {
    let Some(p) = value.get("presentation").filter(|v| !v.is_null()) else {
        return Ok(());
    };
    let invalid = || AppError::Validation("Invalid image presentation settings".into());
    if !p.is_object() {
        return Err(invalid());
    }
    if let Some(v) = p.get("align") {
        if !matches!(v.as_str(), Some("left" | "center" | "right")) {
            return Err(invalid());
        }
    }
    if let Some(v) = p.get("widthMode") {
        if !matches!(v.as_str(), Some("px" | "percent")) {
            return Err(invalid());
        }
    }
    if let Some(v) = p.get("width") {
        let n = v.as_f64().ok_or_else(invalid)?;
        let max = if p["widthMode"] == "percent" {
            100.0
        } else {
            100000.0
        };
        if !n.is_finite() || n <= 0.0 || n > max {
            return Err(invalid());
        }
    }
    for key in ["caption", "alt", "link", "note"] {
        if let Some(v) = p.get(key) {
            if v.as_str().is_none_or(|s| s.chars().count() > 10000) {
                return Err(invalid());
            }
        }
    }
    if let Some(v) = p.get("crop") {
        let c: Crop = serde_json::from_value(v.clone()).map_err(|_| invalid())?;
        if !c.valid() {
            return Err(invalid());
        }
    }
    Ok(())
}

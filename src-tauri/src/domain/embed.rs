use crate::errors::{AppError, AppResult};
use serde_json::Value;

/// Remote HTML is never persisted or executed; only an HTTPS source and presentation settings.
pub fn validate(value: &Value) -> AppResult<()> {
    let bad = || AppError::Validation("invalid embed settings".into());
    for (key, max) in [("url", 4096), ("title", 200), ("caption", 2000)] {
        if let Some(v) = value.get(key) {
            if v.as_str().is_none_or(|s| s.chars().count() > max) {
                return Err(bad());
            }
        }
    }
    if let Some(source) = value
        .get("url")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        let url = tauri::Url::parse(source).map_err(|_| bad())?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || source.chars().any(char::is_control)
        {
            return Err(bad());
        }
    }
    for (key, min, max) in [("width", 25.0, 100.0), ("height", 160.0, 1200.0)] {
        if let Some(v) = value.get(key).filter(|v| !(key == "height" && v.is_null())) {
            if !v
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= min && n <= max)
            {
                return Err(bad());
            }
        }
    }
    if value.get("align").is_some_and(|v| {
        !v.as_str()
            .is_some_and(|s| ["left", "center", "right"].contains(&s))
    }) || value
        .get("mode")
        .is_some_and(|v| !v.as_str().is_some_and(|s| ["embed", "link"].contains(&s)))
    {
        return Err(bad());
    }
    Ok(())
}

pub fn validate_block(kind: &str, json: &str) -> AppResult<()> {
    if kind == "embed" {
        validate(
            &serde_json::from_str::<Value>(json)
                .map_err(|_| AppError::Validation("invalid embed settings".into()))?,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn web_embed_rejects_unsafe_sources_and_invalid_presentation() {
        assert!(validate(&json!({"url":"https://www.google.com/maps/embed?pb=test","width":75,"height":360,"align":"center","mode":"embed"})).is_ok());
        for source in [
            "javascript:alert(1)",
            "file:///C:/secret",
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com:444",
        ] {
            assert!(validate(&json!({"url":source})).is_err());
        }
        for value in [
            json!({"width":0}),
            json!({"height":5000}),
            json!({"align":"script"}),
            json!({"mode":"html"}),
            json!({"caption":true}),
        ] {
            assert!(validate(&value).is_err());
        }
        assert!(validate(&json!({})).is_ok());
    }
}

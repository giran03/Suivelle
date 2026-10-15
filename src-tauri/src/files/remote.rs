//! Remote media is inspected without storing it, then downloaded only after explicit consent.
use crate::errors::{AppError, AppResult};
use reqwest::blocking::{Client, Response};
use reqwest::header::{CONTENT_TYPE, RANGE};
use serde::Serialize;
use std::{io::Read, net::IpAddr, path::Path, time::Duration};

const MAX_BYTES: u64 = 256 * 1024 * 1024;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaUrlInfo {
    pub kind: String,
    pub name: String,
    pub mime: String,
    pub size: Option<u64>,
}

pub fn validate_url(source: &str) -> AppResult<reqwest::Url> {
    let invalid =
        || AppError::Validation("Use a public HTTP or HTTPS media URL without credentials.".into());
    if source.len() > 8192 || source.chars().any(char::is_control) {
        return Err(invalid());
    }
    let url = reqwest::Url::parse(source).map_err(|_| invalid())?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(invalid());
    }
    let host = url.host_str().ok_or_else(invalid)?;
    let host = host.trim_matches(['[', ']']);
    if let Ok(ip) = host.parse::<IpAddr>() {
        let private = match ip {
            IpAddr::V4(v) => {
                v.is_private()
                    || v.is_loopback()
                    || v.is_link_local()
                    || v.is_unspecified()
                    || v.octets()[0] == 0
                    || v.octets()[0] >= 224
            }
            IpAddr::V6(v) => {
                v.is_loopback()
                    || v.is_unspecified()
                    || v.is_multicast()
                    || v.is_unicast_link_local()
                    || v.segments()[0] & 0xfe00 == 0xfc00
                    || v.to_ipv4_mapped().is_some()
            }
        };
        if private {
            return Err(invalid());
        }
    } else if !host.contains('.')
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err(invalid());
    }
    Ok(url)
}

fn client() -> AppResult<Client> {
    // reqwest is built without a bundled crypto provider; ring is shared with the updater.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    Client::builder()
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(8))
        .user_agent("Suivelle media import")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || validate_url(attempt.url().as_str()).is_err() {
                attempt.error("Unsupported media redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| AppError::Internal("Could not prepare the media download.".into()))
}

pub fn media_type(mime: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(
        match mime.split(';').next()?.trim().to_ascii_lowercase().as_str() {
            "image/jpeg" | "image/jpg" => ("image", "image/jpeg", "jpg"),
            "image/png" => ("image", "image/png", "png"),
            "image/gif" => ("image", "image/gif", "gif"),
            "image/webp" => ("image", "image/webp", "webp"),
            "image/avif" => ("image", "image/avif", "avif"),
            "image/bmp" => ("image", "image/bmp", "bmp"),
            "image/svg+xml" => ("image", "image/svg+xml", "svg"),
            "audio/mpeg" => ("audio", "audio/mpeg", "mp3"),
            "audio/wav" | "audio/x-wav" => ("audio", "audio/wav", "wav"),
            "audio/ogg" => ("audio", "audio/ogg", "ogg"),
            "audio/mp4" => ("audio", "audio/mp4", "m4a"),
            "audio/opus" => ("audio", "audio/opus", "opus"),
            "audio/webm" => ("audio", "audio/webm", "webm"),
            "audio/aac" => ("audio", "audio/aac", "aac"),
            "audio/flac" | "audio/x-flac" => ("audio", "audio/flac", "flac"),
            "video/mp4" => ("video", "video/mp4", "mp4"),
            "video/webm" => ("video", "video/webm", "webm"),
            "video/quicktime" => ("video", "video/quicktime", "mov"),
            "video/ogg" => ("video", "video/ogg", "ogv"),
            "application/pdf" => ("pdf", "application/pdf", "pdf"),
            _ => return None,
        },
    )
}

fn response_info(response: &Response) -> Option<MediaUrlInfo> {
    let raw = response.headers().get(CONTENT_TYPE)?.to_str().ok()?;
    let (kind, mime, ext) = media_type(raw)?;
    let base = super::manage::clean_name(
        response
            .url()
            .path_segments()?
            .next_back()
            .unwrap_or("media"),
    );
    let name = if super::mime_for(&base) == mime {
        base
    } else {
        format!("{}.{}", base, ext)
    };
    Some(MediaUrlInfo {
        kind: kind.into(),
        mime: mime.into(),
        name,
        size: response.content_length(),
    })
}

pub fn inspect(source: &str) -> AppResult<Option<MediaUrlInfo>> {
    let url = validate_url(source)?;
    let client = client()?;
    let mut response = client
        .head(url.clone())
        .timeout(Duration::from_secs(5))
        .send()
        .map_err(|_| AppError::Validation("Could not check this media link.".into()))?;
    if [405, 501].contains(&response.status().as_u16()) {
        // Inspect headers only; never read or persist the response body before consent.
        response = client
            .get(url)
            .header(RANGE, "bytes=0-511")
            .timeout(Duration::from_secs(5))
            .send()
            .map_err(|_| AppError::Validation("Could not check this media link.".into()))?;
    }
    if !response.status().is_success() {
        return Ok(None);
    }
    Ok(response_info(&response))
}

pub fn download(root: &Path, source: &str) -> AppResult<(MediaUrlInfo, String, u64)> {
    let mut response = client()?.get(validate_url(source)?).send().map_err(|_| {
        AppError::Validation(
            "Could not download this media. Check your connection and try again.".into(),
        )
    })?;
    if !response.status().is_success() {
        return Err(AppError::Validation(format!(
            "The media server returned {}. The pasted link is unchanged.",
            response.status()
        )));
    }
    let info = response_info(&response).ok_or_else(|| {
        AppError::Validation(
            "This URL does not serve a supported image, audio, video, or PDF file.".into(),
        )
    })?;
    if info.size.is_some_and(|n| n > MAX_BYTES) {
        return Err(AppError::Validation(
            "Remote media must be 256 MB or smaller.".into(),
        ));
    }
    let mut prefix = Vec::new();
    response.by_ref().take(512).read_to_end(&mut prefix)?;
    if prefix.is_empty() {
        return Err(AppError::Validation("This media file is empty.".into()));
    }
    if info.kind == "image" && info.mime != "image/svg+xml" && image::guess_format(&prefix).is_err()
        || info.kind == "pdf" && !prefix.starts_with(b"%PDF-")
    {
        return Err(AppError::Validation(
            "The server did not return a valid media file. The pasted link is unchanged.".into(),
        ));
    }
    let (hash, size) = super::store_reader(root, &mut prefix.as_slice().chain(response), MAX_BYTES)
        .map_err(|e| match e {
            AppError::Validation(message) if message == "file is larger than 1 GiB" => {
                AppError::Validation("Remote media must be 256 MB or smaller.".into())
            }
            other => other,
        })?;
    Ok((info, hash, size))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_media_identifies_content_types_and_rejects_private_or_executable_urls() {
        assert_eq!(media_type("image/gif; charset=binary").unwrap().0, "image");
        assert_eq!(media_type("video/mp4").unwrap().0, "video");
        assert!(media_type("text/html").is_none());
        assert!(validate_url("https://encrypted-tbn0.gstatic.com/images?q=example&s=10").is_ok());
        for url in [
            "file:///secret",
            "javascript:alert(1)",
            "https://user:pass@example.com",
            "http://127.0.0.1",
            "http://192.168.1.1",
            "http://[::1]",
            "http://localhost",
            "https://example.com:444/",
        ] {
            assert!(validate_url(url).is_err(), "{url}");
        }
    }
    #[test]
    #[ignore = "Live network smoke test for an extensionless Google thumbnail"]
    fn remote_media_google_thumbnail() {
        let source = "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQ4cAm4fabcyoRYwsb9srkgNK7YHHZLeupFj3jLRSPj60da9yjQ01DreXM&s=10";
        assert_eq!(inspect(source).unwrap().unwrap().kind, "image");
        let root =
            std::env::temp_dir().join(format!("suivelle-media-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        let result = download(&root, source);
        std::fs::remove_dir_all(&root).unwrap();
        let (info, _, size) = result.unwrap();
        assert_eq!(info.kind, "image");
        assert!(size > 0);
    }
}

//! `attachment://<sha256>` for the webview: serves stored files (with Range support for
//! audio/video seeking). Only hashes that exist in the attachment table resolve.

use super::{is_hash, meta_by_hash, parse_range, read_range, AttachmentStore};
use crate::database::Db;
use tauri::{
    http::{header, Request, Response},
    AppHandle, Manager,
};

pub fn respond(app: &AppHandle, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    match serve(app, req) {
        Ok(r) => r,
        Err(status) => Response::builder()
            .status(status)
            .body(Vec::new())
            .expect("static response is valid"),
    }
}

fn serve(app: &AppHandle, req: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, u16> {
    let hash = req.uri().path().trim_start_matches('/');
    if !is_hash(hash) {
        return Err(400);
    }
    let db = app.try_state::<Db>().ok_or(503u16)?;
    let store = app.try_state::<AttachmentStore>().ok_or(503u16)?;
    let (mime, size) = {
        let conn = db.0.lock().map_err(|_| 500u16)?;
        meta_by_hash(&conn, hash)
            .map_err(|_| 500u16)?
            .ok_or(404u16)?
    };
    // `?thumb=<edge>` asks for a small copy of an image; anything else gets the original.
    if let Some(value) = req.uri().query().and_then(|q| q.split('&').find_map(|s| s.strip_prefix("crop="))) {
        let v: Vec<f64> = value.split(',').filter_map(|s| s.parse().ok()).collect();
        if v.len() != 4 || !mime.starts_with("image/") {
            return Err(400);
        }
        let crop = crate::domain::image::Crop {
            x: v[0],
            y: v[1],
            width: v[2],
            height: v[3],
        };
        if !crop.valid() {
            return Err(400);
        }
        let image = super::image_edit::render(&super::blob_path(&store.root, hash), Some(crop))
            .map_err(|_| 422u16)?;
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).map_err(|_| 500u16)?;
        return Response::builder().status(200u16).header(header::CONTENT_TYPE, "image/png").header("Access-Control-Allow-Origin", "*").header(header::CACHE_CONTROL, "public, max-age=31536000, immutable").body(bytes.into_inner()).map_err(|_| 500u16);
    }
    if let Some(edge) =
        super::thumb::size_param(req.uri().query()).filter(|_| mime.starts_with("image/"))
    {
        if let Ok(Some(t)) = super::thumb::get(&store.root, hash, edge) {
            return Response::builder()
                .status(200u16)
                .header(header::CONTENT_TYPE, t.mime)
                .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
                .header("Access-Control-Allow-Origin", "*")
                .header(header::CONTENT_LENGTH, t.bytes.len())
                .body(t.bytes)
                .map_err(|_| 500u16);
        }
    }
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| parse_range(h, size));
    let (status, start, end) = match range {
        Some((s, e)) => (206u16, s, e),
        None => (200u16, 0, size.saturating_sub(1)),
    };
    let body = if size == 0 {
        Vec::new()
    } else {
        read_range(&store.root, hash, start, end).map_err(|_| 404u16)?
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header("Access-Control-Allow-Origin", "*")
        .header(header::CONTENT_LENGTH, body.len());
    if status == 206 {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    builder.body(body).map_err(|_| 500u16)
}

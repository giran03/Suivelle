//! `attachment://<sha256>` for the webview: serves stored files (with Range support for
//! audio/video seeking). Only hashes that exist in the attachment table resolve.

use super::{is_hash, meta_by_hash, parse_range, read_range, AttachmentStore};
use crate::database::Db;
use tauri::{
    http::{header, Request, Response},
    AppHandle, Manager,
};

type Job = Box<dyn FnOnce() + Send>;

/// Runs attachment requests on a small fixed pool, off the webview thread. A gallery that asks
/// for hundreds of thumbnails at once queues them instead of starting a thread for each.
pub fn spawn(job: impl FnOnce() + Send + 'static) {
    static QUEUE: std::sync::OnceLock<std::sync::mpsc::Sender<Job>> = std::sync::OnceLock::new();
    let queue = QUEUE.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Job>();
        let rx = std::sync::Arc::new(std::sync::Mutex::new(rx));
        let workers = std::thread::available_parallelism().map_or(2, |n| n.get().clamp(2, 4));
        for i in 0..workers {
            let rx = rx.clone();
            let _ = std::thread::Builder::new()
                .name(format!("attachment-{i}"))
                .spawn(move || loop {
                    // The lock is held only while taking the next job, never while running it.
                    let next = rx.lock().unwrap_or_else(|e| e.into_inner()).recv();
                    match next {
                        Ok(job) => job(),
                        Err(_) => break,
                    }
                });
        }
        tx
    });
    if let Err(std::sync::mpsc::SendError(job)) = queue.send(Box::new(job)) {
        job();
    }
}

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
    if let Some(value) = req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|s| s.strip_prefix("crop=")))
    {
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
        image
            .write_to(&mut bytes, image::ImageFormat::Png)
            .map_err(|_| 500u16)?;
        return Response::builder()
            .status(200u16)
            .header(header::CONTENT_TYPE, "image/png")
            .header("Access-Control-Allow-Origin", "*")
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .body(bytes.into_inner())
            .map_err(|_| 500u16);
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};

    #[test]
    fn a_burst_of_requests_runs_on_a_bounded_pool() {
        let (running, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let (done, finished) = mpsc::channel();
        for _ in 0..64 {
            let (running, peak, done) = (running.clone(), peak.clone(), done.clone());
            super::spawn(move || {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(2));
                running.fetch_sub(1, Ordering::SeqCst);
                done.send(()).unwrap();
            });
        }
        for _ in 0..64 {
            finished
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
        }
        assert!((1..=4).contains(&peak.load(Ordering::SeqCst)));
    }
}

//! Image thumbnails: small cached copies served as `attachment://<hash>?thumb=<edge>`.
//!
//! A thumbnail is built the first time it is asked for and kept under `thumbnails/<xx>/`, named
//! by hash and size, so it is rebuilt on demand if the folder is cleared. Images that are
//! animated, already small, formats that cannot be decoded, and anything unreadable simply have no
//! thumbnail; the caller serves the original instead.

use super::{blob_path, is_hash};
use crate::errors::{AppError, AppResult};
use image::{
    codecs::{jpeg::JpegEncoder, png::PngDecoder, webp::WebPDecoder},
    ImageFormat, ImageReader, Limits,
};
use std::{
    fs,
    io::{BufReader, Cursor},
    path::{Path, PathBuf},
    sync::Mutex,
};

/// The edge lengths a caller may ask for.
pub const SIZES: [u32; 3] = [320, 640, 1280];
const MAX_DECODE_PIXELS: u32 = 16_000;
const MAX_DECODE_BYTES: u64 = 512 * 1024 * 1024;

/// Thumbnails are built one at a time so a page of large photos cannot use every core and
/// all the memory at once.
static BUILDING: Mutex<()> = Mutex::new(());

pub struct Thumb {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

pub fn size_param(query: Option<&str>) -> Option<u32> {
    let q = query?;
    let v = q.split('&').find_map(|kv| kv.strip_prefix("thumb="))?;
    let n: u32 = v.parse().ok()?;
    SIZES.contains(&n).then_some(n)
}

fn cache_dir(attachments_root: &Path, hash: &str) -> PathBuf {
    attachments_root
        .parent()
        .unwrap_or(attachments_root)
        .join("thumbnails")
        .join(&hash[..2])
}

/// The thumbnail for `hash` at `edge` pixels, or `None` when the original should be used.
pub fn get(attachments_root: &Path, hash: &str, edge: u32) -> AppResult<Option<Thumb>> {
    if !is_hash(hash) || !SIZES.contains(&edge) {
        return Err(AppError::Validation("invalid thumbnail request".into()));
    }
    let dir = cache_dir(attachments_root, hash);
    let (png, jpg, none) = (
        // v2 discards old cached still frames of GIF, WebP and APNG uploads.
        dir.join(format!("{hash}-{edge}-v2.png")),
        dir.join(format!("{hash}-{edge}-v2.jpg")),
        dir.join(format!("{hash}-{edge}-v2.none")),
    );
    for (path, mime) in [(&png, "image/png"), (&jpg, "image/jpeg")] {
        if let Ok(bytes) = fs::read(path) {
            return Ok(Some(Thumb { bytes, mime }));
        }
    }
    if none.exists() {
        return Ok(None);
    }
    let _guard = BUILDING.lock().unwrap_or_else(|p| p.into_inner());
    // Another request may have built it while this one waited.
    for (path, mime) in [(&png, "image/png"), (&jpg, "image/jpeg")] {
        if let Ok(bytes) = fs::read(path) {
            return Ok(Some(Thumb { bytes, mime }));
        }
    }
    fs::create_dir_all(&dir)?;
    match build(&blob_path(attachments_root, hash), edge) {
        Ok(Some((bytes, mime))) => {
            let target = if mime == "image/png" { &png } else { &jpg };
            let tmp = target.with_extension("part");
            fs::write(&tmp, &bytes)?;
            super::move_path(&tmp, target)?;
            Ok(Some(Thumb { bytes, mime }))
        }
        Ok(None) => {
            // Remember that this one needs no thumbnail.
            let _ = fs::write(&none, b"");
            Ok(None)
        }
        Err(_) => Ok(None),
    }
}

fn build(blob: &Path, edge: u32) -> Result<Option<(Vec<u8>, &'static str)>, image::ImageError> {
    let mut reader = ImageReader::open(blob)?.with_guessed_format()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DECODE_PIXELS);
    limits.max_image_height = Some(MAX_DECODE_PIXELS);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits.clone());
    let Some(format) = reader.format() else {
        return Ok(None);
    };
    // Preserve timing, looping and all frames by letting the browser render the original.
    // Treat GIFs as potentially animated; no frame decoding is needed to make this decision.
    let animated = match format {
        ImageFormat::Gif => true,
        ImageFormat::Png => {
            PngDecoder::with_limits(BufReader::new(fs::File::open(blob)?), limits)?.is_apng()?
        }
        ImageFormat::WebP => {
            WebPDecoder::new(BufReader::new(fs::File::open(blob)?))?.has_animation()
        }
        _ => false,
    };
    if animated {
        return Ok(None);
    }
    if !matches!(
        format,
        ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::Gif
            | ImageFormat::WebP
            | ImageFormat::Bmp
    ) {
        return Ok(None);
    }
    let img = reader.decode()?;
    if img.width().max(img.height()) <= edge {
        return Ok(None);
    }
    let small = img.thumbnail(edge, edge);
    let mut out = Cursor::new(Vec::new());
    if format == ImageFormat::Jpeg {
        let rgb = small.to_rgb8();
        JpegEncoder::new_with_quality(&mut out, 82).encode_image(&rgb)?;
        Ok(Some((out.into_inner(), "image/jpeg")))
    } else {
        small.write_to(&mut out, ImageFormat::Png)?;
        Ok(Some((out.into_inner(), "image/png")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgba, RgbaImage};
    use sha2::{Digest, Sha256};

    fn store(bytes: &[u8]) -> (PathBuf, String) {
        let root = std::env::temp_dir()
            .join(format!("tako-thumb-{}", uuid::Uuid::now_v7()))
            .join("attachments");
        let hash: String = Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let path = blob_path(&root, &hash);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
        (root, hash)
    }

    fn encode(img: &DynamicImage, fmt: ImageFormat) -> Vec<u8> {
        let mut c = Cursor::new(Vec::new());
        img.write_to(&mut c, fmt).unwrap();
        c.into_inner()
    }

    fn gradient(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::from_fn(w, h, |x, y| {
            Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
        }))
    }

    #[test]
    fn large_images_get_a_cached_thumbnail_in_their_own_format() {
        let (root, hash) = store(&encode(&gradient(1000, 500), ImageFormat::Png));
        let t = get(&root, &hash, 320).unwrap().expect("a thumbnail");
        assert_eq!(t.mime, "image/png");
        let decoded = image::load_from_memory(&t.bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (320, 160));
        // Cached on disk, served again without the original.
        fs::remove_file(blob_path(&root, &hash)).unwrap();
        assert_eq!(get(&root, &hash, 320).unwrap().unwrap().bytes, t.bytes);
        // Another size is a separate file.
        assert!(
            get(&root, &hash, 640).unwrap().is_none(),
            "the original is gone, so no new one can be made"
        );
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn photos_become_jpeg_and_small_or_odd_files_have_no_thumbnail() {
        let rgb = DynamicImage::ImageRgb8(gradient(900, 900).to_rgb8());
        let (root, hash) = store(&encode(&rgb, ImageFormat::Jpeg));
        assert_eq!(get(&root, &hash, 640).unwrap().unwrap().mime, "image/jpeg");

        let (small_root, small) = store(&encode(&gradient(100, 80), ImageFormat::Png));
        assert!(get(&small_root, &small, 320).unwrap().is_none());
        assert!(
            cache_dir(&small_root, &small)
                .join(format!("{small}-320-v2.none"))
                .exists(),
            "the decision is remembered"
        );
        assert!(get(&small_root, &small, 320).unwrap().is_none());

        let (junk_root, junk) = store(b"definitely not an image");
        assert!(get(&junk_root, &junk, 320).unwrap().is_none());
        let (svg_root, svg) = store(b"<svg xmlns='http://www.w3.org/2000/svg'/>");
        assert!(get(&svg_root, &svg, 320).unwrap().is_none());
        // A missing blob is not an error either.
        assert!(get(&junk_root, &"a".repeat(64), 320).unwrap().is_none());
        for r in [root, small_root, junk_root, svg_root] {
            let _ = fs::remove_dir_all(r.parent().unwrap());
        }
    }

    #[test]
    fn animated_uploads_keep_the_original_even_with_an_old_still_thumbnail() {
        use image::AnimationDecoder;
        let gif = include_bytes!("fixtures/animated-icon.gif");
        assert_eq!(
            image::codecs::gif::GifDecoder::new(Cursor::new(gif))
                .unwrap()
                .into_frames()
                .count(),
            2
        );
        for bytes in [
            gif.as_slice(),
            include_bytes!("fixtures/animated-icon.webp").as_slice(),
            include_bytes!("fixtures/animated-icon.apng").as_slice(),
        ] {
            let (root, hash) = store(bytes);
            let old = cache_dir(&root, &hash);
            fs::create_dir_all(&old).unwrap();
            fs::write(
                old.join(format!("{hash}-320.png")),
                encode(&gradient(320, 160), ImageFormat::Png),
            )
            .unwrap();
            for edge in SIZES {
                assert!(
                    get(&root, &hash, edge).unwrap().is_none(),
                    "an animated upload must not be flattened"
                );
                assert!(
                    get(&root, &hash, edge).unwrap().is_none(),
                    "the original is also used on later requests"
                );
                assert!(old.join(format!("{hash}-{edge}-v2.none")).exists());
            }
            assert_eq!(fs::read(blob_path(&root, &hash)).unwrap(), bytes);
            let _ = fs::remove_dir_all(root.parent().unwrap());
        }
        assert!(super::super::kind_extensions("image")
            .unwrap()
            .contains(&"apng"));
        assert_eq!(super::super::mime_for("animation.apng"), "image/png");
    }

    #[test]
    fn requests_are_validated() {
        let root = std::env::temp_dir()
            .join("tako-thumb-none")
            .join("attachments");
        assert!(get(&root, "../../etc", 320).is_err());
        assert!(get(&root, &"a".repeat(64), 321).is_err());
        assert_eq!(size_param(Some("thumb=640")), Some(640));
        assert_eq!(size_param(Some("x=1&thumb=320")), Some(320));
        assert_eq!(size_param(Some("thumb=999")), None);
        assert_eq!(size_param(Some("thumb=abc")), None);
        assert_eq!(size_param(None), None);
    }
}

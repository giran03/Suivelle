use crate::domain::image::Crop;
use crate::errors::{AppError, AppResult};
use image::{ImageFormat, ImageReader, Limits};
use std::{io::BufReader, path::Path};

pub fn animated(path: &Path) -> AppResult<bool> {
    let format = ImageReader::open(path)?.with_guessed_format()?.format();
    let file = || std::fs::File::open(path).map(BufReader::new);
    Ok(match format {
        Some(ImageFormat::Gif) => true,
        Some(ImageFormat::Png) => image::codecs::png::PngDecoder::new(file()?)
            .map_err(bad)?
            .is_apng()
            .map_err(bad)?,
        Some(ImageFormat::WebP) => image::codecs::webp::WebPDecoder::new(file()?)
            .map_err(bad)?
            .has_animation(),
        _ => false,
    })
}
fn bad(e: impl std::fmt::Display) -> AppError {
    AppError::Validation(format!("Could not process image: {e}"))
}
pub fn render(path: &Path, crop: Option<Crop>) -> AppResult<image::DynamicImage> {
    static DECODING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = DECODING.lock().unwrap_or_else(|e| e.into_inner());
    if crop.is_some_and(|c| !c.valid()) {
        return Err(bad("invalid crop"));
    }
    let mut reader = ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(16000);
    limits.max_image_height = Some(16000);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(bad)?;
    if let Some(c) = crop {
        if animated(path)? {
            return Err(bad(
                "cropping animated images is not supported; save the original instead",
            ));
        }
        let (w, h) = (image.width(), image.height());
        let x = ((c.x * w as f64).floor() as u32).min(w - 1);
        let y = ((c.y * h as f64).floor() as u32).min(h - 1);
        let cw = ((c.width * w as f64).round() as u32).max(1).min(w - x);
        let ch = ((c.height * h as f64).round() as u32).max(1).min(h - y);
        Ok(image.crop_imm(x, y, cw, ch))
    } else {
        Ok(image)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crop_preserves_source_and_matches_normalized_dimensions() {
        let path = std::env::temp_dir().join(format!("suivelle-crop-{}.png", uuid::Uuid::now_v7()));
        image::RgbaImage::from_pixel(100, 80, image::Rgba([20, 40, 60, 255]))
            .save(&path)
            .unwrap();
        let cropped = render(
            &path,
            Some(Crop {
                x: 0.2,
                y: 0.25,
                width: 0.5,
                height: 0.5,
            }),
        )
        .unwrap();
        assert_eq!((cropped.width(), cropped.height()), (50, 40));
        assert_eq!(image::image_dimensions(&path).unwrap(), (100, 80));
        std::fs::remove_file(path).unwrap();
    }
}

//! Minimal PDFium diagnostic path. All PDFium work stays on this process's
//! main OS thread; this is not the production IPC loop.

use image::ImageEncoder;
use pdfium_render::prelude::{PdfRenderConfig, Pdfium};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const MAX_BITMAP_DIMENSION: u32 = 8_192;
const MAX_BITMAP_PIXELS: u64 = 8_388_608;
const MAX_RGBA_BITMAP_BYTES: usize = 32 * 1024 * 1024;
const MAX_ENCODED_PNG_BYTES: usize = 32 * 1024 * 1024;

struct Args {
    pdfium_path: PathBuf,
    input_path: PathBuf,
    output_path: PathBuf,
}

struct RenderReport {
    page_count: i32,
    page_width_points: f32,
    page_height_points: f32,
    bitmap_width: u32,
    bitmap_height: u32,
    png: Vec<u8>,
}

fn main() -> ExitCode {
    match parse_args(std::env::args_os().skip(1).collect()).and_then(run_smoke_test) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pdfium-worker: {error}");
            ExitCode::FAILURE
        }
    }
}

fn parse_args(args: Vec<OsString>) -> Result<Args, String> {
    let mut values = std::collections::HashMap::<String, PathBuf>::new();
    let mut iter = args.into_iter();
    let mode = iter
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or_else(usage)?;

    if mode != "--smoke-test" {
        return Err(usage());
    }

    while let Some(flag) = iter.next() {
        let flag = flag
            .into_string()
            .map_err(|_| "arguments must use ASCII option names".to_string())?;
        let path = iter.next().map(PathBuf::from).ok_or_else(usage)?;
        let key = match flag.as_str() {
            "--pdfium-path" => "pdfium",
            "--input" => "input",
            "--output" => "output",
            _ => return Err(usage()),
        };
        if values.insert(key.to_string(), path).is_some() {
            return Err(format!("duplicate {flag} argument"));
        }
    }

    let pdfium_path = values.remove("pdfium").ok_or_else(usage)?;
    let input_path = values.remove("input").ok_or_else(usage)?;
    let output_path = values.remove("output").ok_or_else(usage)?;

    for (name, path) in [
        ("PDFium DLL", &pdfium_path),
        ("input PDF", &input_path),
        ("output PNG", &output_path),
    ] {
        if !path.is_absolute() {
            return Err(format!("{name} path must be absolute: {}", path.display()));
        }
    }

    Ok(Args {
        pdfium_path,
        input_path,
        output_path,
    })
}

fn usage() -> String {
    "usage: pdfium-worker --smoke-test --pdfium-path <absolute-pdfium.dll> --input <absolute-pdf> --output <absolute-png>".to_string()
}

fn run_smoke_test(args: Args) -> Result<(), String> {
    if !args.pdfium_path.is_file() {
        return Err(format!(
            "PDFium DLL does not exist or is not a file: {}",
            args.pdfium_path.display()
        ));
    }
    if !args.input_path.is_file() {
        return Err(format!(
            "input PDF does not exist or is not a file: {}",
            args.input_path.display()
        ));
    }

    // There is no implicit current-directory or system-library fallback.
    let bindings = Pdfium::bind_to_library(&args.pdfium_path).map_err(|error| {
        format!(
            "could not load the explicitly selected PDFium DLL {}: {error}",
            args.pdfium_path.display()
        )
    })?;
    let pdfium = Pdfium::new(bindings);

    let report = render_first_page(&pdfium, &args.input_path)?;
    fs::write(&args.output_path, &report.png).map_err(|error| {
        format!(
            "could not write PNG {}: {error}",
            args.output_path.display()
        )
    })?;

    println!(
        "pages={} page1_points={:.2}x{:.2} render_px={}x{} png_bytes={} png={}",
        report.page_count,
        report.page_width_points,
        report.page_height_points,
        report.bitmap_width,
        report.bitmap_height,
        report.png.len(),
        args.output_path.display()
    );

    // `PdfDocument`, page, and bitmap ownership is scoped and dropped before
    // returning. This diagnostic process then exits, which unloads the native
    // library and reclaims its remaining process-local allocations.
    drop(pdfium);
    Ok(())
}

fn render_first_page(pdfium: &Pdfium, input_path: &Path) -> Result<RenderReport, String> {
    let document = pdfium
        .load_pdf_from_file(input_path, None)
        .map_err(|error| format!("could not open PDF {}: {error}", input_path.display()))?;
    let page_count = document.pages().len();
    if page_count <= 0 {
        return Err("PDF contains no pages".to_string());
    }

    let (page_width_points, page_height_points, bitmap_width, bitmap_height, rgba) = {
        let page = document
            .pages()
            .get(0)
            .map_err(|error| format!("could not open PDF page one: {error}"))?;
        let page_width_points = page.width().value;
        let page_height_points = page.height().value;
        let (target_width, target_height) =
            bounded_target_dimensions(page_width_points, page_height_points)?;

        let bitmap = page
            .render_with_config(
                &PdfRenderConfig::new()
                    .set_target_size(target_width as i32, target_height as i32)
                    .set_maximum_width(MAX_BITMAP_DIMENSION as i32)
                    .set_maximum_height(MAX_BITMAP_DIMENSION as i32),
            )
            .map_err(|error| format!("could not render PDF page one: {error}"))?;
        let bitmap_width = bitmap.width() as u32;
        let bitmap_height = bitmap.height() as u32;
        validate_bitmap_size(bitmap_width, bitmap_height)?;
        let rgba = bitmap.as_rgba_bytes();
        if rgba.len() > MAX_RGBA_BITMAP_BYTES {
            return Err(format!(
                "RGBA bitmap exceeded the {} byte limit",
                MAX_RGBA_BITMAP_BYTES
            ));
        }

        (
            page_width_points,
            page_height_points,
            bitmap_width,
            bitmap_height,
            rgba,
        )
    };
    // The native bitmap and page handles are dropped at the end of the block;
    // the document is dropped before the function returns.

    let mut png = BoundedVec::new(MAX_ENCODED_PNG_BYTES);
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            &rgba,
            bitmap_width,
            bitmap_height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| format!("could not encode bounded PNG: {error}"))?;

    if png.bytes.is_empty() {
        return Err("PNG encoder produced an empty image".to_string());
    }

    Ok(RenderReport {
        page_count,
        page_width_points,
        page_height_points,
        bitmap_width,
        bitmap_height,
        png: png.bytes,
    })
}

fn bounded_target_dimensions(width_points: f32, height_points: f32) -> Result<(u32, u32), String> {
    if !width_points.is_finite()
        || !height_points.is_finite()
        || width_points <= 0.0
        || height_points <= 0.0
    {
        return Err("PDF page dimensions must be finite and positive".to_string());
    }

    let width = f64::from(width_points);
    let height = f64::from(height_points);
    let pixel_scale = (MAX_BITMAP_PIXELS as f64 / (width * height)).sqrt();
    let scale = 1.0_f64
        .min(f64::from(MAX_BITMAP_DIMENSION) / width)
        .min(f64::from(MAX_BITMAP_DIMENSION) / height)
        .min(pixel_scale);
    let target_width = (width * scale).floor().max(1.0) as u32;
    let target_height = (height * scale).floor().max(1.0) as u32;
    validate_bitmap_size(target_width, target_height)?;
    Ok((target_width, target_height))
}

fn validate_bitmap_size(width: u32, height: u32) -> Result<(), String> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| "bitmap pixel count overflow".to_string())?;
    if width == 0
        || height == 0
        || width > MAX_BITMAP_DIMENSION
        || height > MAX_BITMAP_DIMENSION
        || pixels > MAX_BITMAP_PIXELS
        || pixels.saturating_mul(4) > MAX_RGBA_BITMAP_BYTES as u64
    {
        return Err(format!(
            "bitmap dimensions {width}x{height} exceed limits (max dimension {MAX_BITMAP_DIMENSION}, max pixels {MAX_BITMAP_PIXELS})"
        ));
    }
    Ok(())
}

struct BoundedVec {
    bytes: Vec<u8>,
    limit: usize,
}

impl BoundedVec {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
        }
    }
}

impl Write for BoundedVec {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let new_len = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "PNG size overflow"))?;
        if new_len > self.limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "PNG exceeds the encoded image payload limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{bounded_target_dimensions, validate_bitmap_size, BoundedVec, MAX_BITMAP_PIXELS};
    use std::io::Write;

    #[test]
    fn small_page_keeps_its_intrinsic_pixel_dimensions() {
        assert_eq!(bounded_target_dimensions(200.0, 120.0), Ok((200, 120)));
    }

    #[test]
    fn huge_page_is_scaled_under_dimension_and_pixel_limits() {
        let (width, height) = bounded_target_dimensions(50_000.0, 25_000.0).unwrap();
        assert!(width <= 8_192);
        assert!(height <= 8_192);
        assert!(u64::from(width) * u64::from(height) <= MAX_BITMAP_PIXELS);
        assert!(validate_bitmap_size(width, height).is_ok());
    }

    #[test]
    fn invalid_page_dimensions_are_rejected() {
        assert!(bounded_target_dimensions(f32::NAN, 10.0).is_err());
        assert!(bounded_target_dimensions(10.0, 0.0).is_err());
    }

    #[test]
    fn bitmap_over_limit_is_rejected() {
        assert!(validate_bitmap_size(8_192, 8_192).is_err());
        assert!(validate_bitmap_size(0, 1).is_err());
    }

    #[test]
    fn encoded_output_writer_rejects_bytes_over_its_hard_cap() {
        let mut output = BoundedVec::new(4);
        assert_eq!(output.write(b"1234").unwrap(), 4);
        assert!(output.write(b"5").is_err());
        assert_eq!(output.bytes, b"1234");
    }
}

//! Minimal PDFium diagnostic path. All PDFium work stays on this process's
//! main OS thread; this is not the production IPC loop.

use image::ImageEncoder;
use pdfium_protocol::{
    encode, parse_header, read_u32, read_u64, validate_bitmap, Frame, Kind, MAX_CONTROL_PAYLOAD,
    MAX_IMAGE_BYTES, OPEN_ACK_LEN,
};
use pdfium_render::prelude::{PdfDocument, PdfRenderConfig, Pdfium};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
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
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let result = if args.first().is_some_and(|v| v == "--serve") {
        parse_server_args(args).and_then(run_server)
    } else {
        parse_args(args).and_then(run_smoke_test)
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pdfium-worker: {error}");
            ExitCode::FAILURE
        }
    }
}

fn parse_server_args(args: Vec<OsString>) -> Result<PathBuf, String> {
    if args.len() != 3 || args[0] != "--serve" || args[1] != "--pdfium-path" {
        return Err("usage: pdfium-worker --serve --pdfium-path <absolute-pdfium.dll>".into());
    }
    let path = PathBuf::from(&args[2]);
    if !path.is_absolute() {
        return Err("PDFium DLL path must be absolute".into());
    }
    if !path.is_file() {
        return Err(format!("PDFium DLL does not exist: {}", path.display()));
    }
    Ok(path)
}

fn run_server(pdfium_path: PathBuf) -> Result<(), String> {
    let bindings = Pdfium::bind_to_library(&pdfium_path)
        .map_err(|e| format!("could not load PDFium DLL {}: {e}", pdfium_path.display()))?;
    // The worker owns this library for its whole process lifetime. The leaked
    // allocation gives PdfDocument its required library lifetime; the OS
    // reclaims it when the supervised worker exits.
    let pdfium: &'static Pdfium = Box::leak(Box::new(Pdfium::new(bindings)));
    let mut session = WorkerSession {
        pdfium,
        document: None,
        identity: None,
    };
    write_frame(&Frame {
        kind: Kind::Ready,
        request_id: 0,
        payload: Vec::new(),
    })?;
    let stdin = io::stdin();
    let mut input = stdin.lock();
    loop {
        let frame = match read_frame(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(error) => return Err(format!("protocol input failure: {error}")),
        };
        if frame.kind == Kind::Shutdown {
            if !frame.payload.is_empty() {
                send_error(frame.request_id, 1, "SHUTDOWN payload must be empty")?;
                continue;
            }
            write_frame(&Frame {
                kind: Kind::Ack,
                request_id: frame.request_id,
                payload: Vec::new(),
            })?;
            break;
        }
        let result = session.handle(frame.kind, &frame.payload);
        match result {
            Ok((kind, payload)) => write_frame(&Frame {
                kind,
                request_id: frame.request_id,
                payload,
            })?,
            Err((code, message)) => send_error(frame.request_id, code, &message)?,
        }
    }
    Ok(())
}

struct WorkerSession {
    pdfium: &'static Pdfium,
    document: Option<PdfDocument<'static>>,
    identity: Option<([u8; 16], u64)>,
}

impl WorkerSession {
    fn handle(&mut self, kind: Kind, payload: &[u8]) -> Result<(Kind, Vec<u8>), (u16, String)> {
        match kind {
            Kind::Open => self.open(payload),
            Kind::Render => self.render(payload),
            Kind::Close => self.close(payload),
            _ => Err((2, format!("message kind {kind:?} is not a worker request"))),
        }
    }

    fn open(&mut self, payload: &[u8]) -> Result<(Kind, Vec<u8>), (u16, String)> {
        if self.document.is_some() {
            return Err((3, "a document is already open".into()));
        }
        if payload.len() < 28 {
            return Err((4, "OPEN payload is truncated".into()));
        }
        let tab_id: [u8; 16] = payload[..16]
            .try_into()
            .map_err(|_| (4, "invalid tab identifier".into()))?;
        let generation = read_u64(payload, 16).map_err(protocol_err)?;
        let path_len = read_u32(payload, 24).map_err(protocol_err)? as usize;
        let expected = 28usize
            .checked_add(path_len)
            .ok_or_else(|| (4, "OPEN path length overflow".into()))?;
        if generation == 0
            || path_len == 0
            || path_len > MAX_CONTROL_PAYLOAD - 28
            || expected != payload.len()
        {
            return Err((4, "invalid OPEN identifier or path length".into()));
        }
        let path = std::str::from_utf8(&payload[28..])
            .map_err(|_| (4, "OPEN path is not UTF-8".into()))?;
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err((4, "document path must be absolute".into()));
        }
        let document = self
            .pdfium
            .load_pdf_from_file(&path, None)
            .map_err(|e| (5, format!("could not open PDF {}: {e}", path.display())))?;
        let page_count = u32::try_from(document.pages().len())
            .map_err(|_| (5, "page count exceeds protocol range".into()))?;
        if page_count == 0 {
            return Err((5, "PDF contains no pages".into()));
        }
        let (width, height) = {
            let first = document
                .pages()
                .get(0)
                .map_err(|e| (5, format!("could not read page one: {e}")))?;
            (first.width().value as f64, first.height().value as f64)
        };
        let mut response = Vec::with_capacity(OPEN_ACK_LEN);
        response.extend_from_slice(&tab_id);
        response.extend_from_slice(&generation.to_be_bytes());
        response.extend_from_slice(&page_count.to_be_bytes());
        response.extend_from_slice(&width.to_be_bytes());
        response.extend_from_slice(&height.to_be_bytes());
        self.document = Some(document);
        self.identity = Some((tab_id, generation));
        Ok((Kind::Ack, response))
    }

    fn render(&mut self, payload: &[u8]) -> Result<(Kind, Vec<u8>), (u16, String)> {
        if payload.len() != 48 {
            return Err((4, "RENDER payload must be 48 bytes".into()));
        }
        let tab_id: [u8; 16] = payload[..16]
            .try_into()
            .map_err(|_| (4, "invalid tab identifier".into()))?;
        let generation = read_u64(payload, 16).map_err(protocol_err)?;
        let page_index = read_u32(payload, 24).map_err(protocol_err)?;
        let zoom = f64::from_be_bytes(
            payload[28..36]
                .try_into()
                .map_err(|_| (4, "invalid zoom".into()))?,
        );
        let target_width = read_u32(payload, 36).map_err(protocol_err)?;
        let target_height = read_u32(payload, 40).map_err(protocol_err)?;
        if payload[45..48] != [0, 0, 0] || payload[44] > 1 {
            return Err((4, "invalid RENDER priority or reserved bytes".into()));
        }
        if !zoom.is_finite() || !(0.25..=5.0).contains(&zoom) {
            return Err((4, "zoom must be between 0.25 and 5.0".into()));
        }
        validate_bitmap(target_width, target_height).map_err(protocol_err)?;
        if self.identity != Some((tab_id, generation)) {
            return Err((
                6,
                "render does not match the active document generation".into(),
            ));
        }
        let document = self
            .document
            .as_ref()
            .ok_or_else(|| (6, "no document is open".into()))?;
        if page_index >= document.pages().len() as u32 || page_index > i32::MAX as u32 {
            return Err((4, "page index is out of range".into()));
        }
        let page = document
            .pages()
            .get(page_index as i32)
            .map_err(|e| (7, format!("could not open page: {e}")))?;
        let (width, height) = bounded_render_dimensions(
            page.width().value,
            page.height().value,
            target_width,
            target_height,
            zoom,
        )
        .map_err(|e| (4, e))?;
        let page = page
            .render_with_config(
                &PdfRenderConfig::new()
                    .set_target_size(width as i32, height as i32)
                    .set_maximum_width(8192)
                    .set_maximum_height(8192),
            )
            .map_err(|e| (7, format!("could not render page: {e}")))?;
        let actual_width = page.width() as u32;
        let actual_height = page.height() as u32;
        validate_bitmap(actual_width, actual_height).map_err(protocol_err)?;
        let rgba = page.as_rgba_bytes();
        let mut png = BoundedVec::new(MAX_IMAGE_BYTES);
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                &rgba,
                actual_width,
                actual_height,
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| (8, format!("IMAGE_TOO_LARGE or PNG encode failure: {e}")))?;
        if png.bytes.is_empty() {
            return Err((8, "PNG encoder produced no image".into()));
        }
        let mut response = Vec::with_capacity(42 + png.bytes.len());
        response.extend_from_slice(&tab_id);
        response.extend_from_slice(&generation.to_be_bytes());
        response.extend_from_slice(&page_index.to_be_bytes());
        response.extend_from_slice(&actual_width.to_be_bytes());
        response.extend_from_slice(&actual_height.to_be_bytes());
        response.extend_from_slice(&1u16.to_be_bytes()); // content type: PNG
        response.extend_from_slice(&(png.bytes.len() as u32).to_be_bytes());
        response.extend_from_slice(&png.bytes);
        Ok((Kind::Page, response))
    }

    fn close(&mut self, payload: &[u8]) -> Result<(Kind, Vec<u8>), (u16, String)> {
        if payload.len() != 24 {
            return Err((4, "CLOSE payload must be 24 bytes".into()));
        }
        let tab_id: [u8; 16] = payload[..16]
            .try_into()
            .map_err(|_| (4, "invalid tab identifier".into()))?;
        let generation = read_u64(payload, 16).map_err(protocol_err)?;
        if self.identity != Some((tab_id, generation)) {
            return Err((
                6,
                "close does not match the active document generation".into(),
            ));
        }
        self.document.take();
        self.identity = None;
        Ok((Kind::Ack, payload.to_vec()))
    }
}

fn protocol_err(error: pdfium_protocol::ProtocolError) -> (u16, String) {
    (4, error.to_string())
}

fn read_frame(input: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut header_bytes = [0u8; pdfium_protocol::HEADER_LEN];
    let first = input.read(&mut header_bytes[..1])?;
    if first == 0 {
        return Ok(None);
    }
    input.read_exact(&mut header_bytes[1..])?;
    let header =
        parse_header(&header_bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let mut payload = vec![0; header.payload_len];
    input.read_exact(&mut payload)?;
    Ok(Some(Frame {
        kind: header.kind,
        request_id: header.request_id,
        payload,
    }))
}

fn write_frame(frame: &Frame) -> Result<(), String> {
    let bytes = encode(frame).map_err(|e| e.to_string())?;
    let stdout = io::stdout();
    let mut out = stdout.lock();
    out.write_all(&bytes)
        .and_then(|_| out.flush())
        .map_err(|e| format!("could not write protocol frame: {e}"))
}

fn send_error(request_id: u64, code: u16, message: &str) -> Result<(), String> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&code.to_be_bytes());
    let text = message.as_bytes();
    let text = &text[..text.len().min(4096)];
    payload.extend_from_slice(&(text.len() as u16).to_be_bytes());
    payload.extend_from_slice(text);
    write_frame(&Frame {
        kind: Kind::Error,
        request_id,
        payload,
    })
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

fn bounded_render_dimensions(
    page_width: f32,
    page_height: f32,
    target_width: u32,
    target_height: u32,
    zoom: f64,
) -> Result<(u32, u32), String> {
    if !page_width.is_finite()
        || !page_height.is_finite()
        || page_width <= 0.0
        || page_height <= 0.0
        || target_width == 0
        || target_height == 0
        || !zoom.is_finite()
        || !(0.25..=5.0).contains(&zoom)
    {
        return Err("page and target dimensions must be positive and zoom must be in range".into());
    }

    let width = f64::from(page_width);
    let height = f64::from(page_height);
    let desired_scale =
        (f64::from(target_width) / width).min(f64::from(target_height) / height) * zoom;
    let pixel_scale = (MAX_BITMAP_PIXELS as f64 / (width * height)).sqrt();
    let scale = desired_scale
        .min(f64::from(MAX_BITMAP_DIMENSION) / width)
        .min(f64::from(MAX_BITMAP_DIMENSION) / height)
        .min(pixel_scale);
    let bitmap_width = (width * scale).floor().max(1.0) as u32;
    let bitmap_height = (height * scale).floor().max(1.0) as u32;
    validate_bitmap_size(bitmap_width, bitmap_height)?;
    Ok((bitmap_width, bitmap_height))
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
    use super::{
        bounded_render_dimensions, bounded_target_dimensions, validate_bitmap_size, BoundedVec,
        MAX_BITMAP_PIXELS,
    };
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
    fn render_dimensions_preserve_page_aspect_ratio_in_wide_viewport() {
        let (width, height) = bounded_render_dimensions(612.0, 792.0, 1794, 800, 1.0).unwrap();
        assert_eq!(height, 800);
        assert!((f64::from(width) / f64::from(height) - 612.0 / 792.0).abs() < 0.002);
        assert!(validate_bitmap_size(width, height).is_ok());
    }

    #[test]
    fn render_dimensions_apply_zoom_without_exceeding_bitmap_caps() {
        let (width, height) = bounded_render_dimensions(612.0, 792.0, 1800, 1400, 5.0).unwrap();
        assert!(width <= 8_192 && height <= 8_192);
        assert!(u64::from(width) * u64::from(height) <= MAX_BITMAP_PIXELS);
        assert!((f64::from(width) / f64::from(height) - 612.0 / 792.0).abs() < 0.002);
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

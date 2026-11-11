//! Minimal PDFium diagnostic path. All PDFium work stays on this process's
//! main OS thread; this is not the production IPC loop.

use image::ImageEncoder;
use pdfium_protocol::{
    encode, parse_header, read_u16, read_u32, read_u64, validate_bitmap, Frame, Kind,
    MAX_CONTROL_PAYLOAD, MAX_IMAGE_BYTES, MAX_SEARCH_EXCERPT_BYTES, MAX_SEARCH_QUERY_BYTES,
    MAX_SEARCH_RESULTS, MAX_TEXT_LAYER_BYTES, OPEN_ACK_LEN,
};
use pdfium_render::prelude::{
    PdfDocument, PdfRenderConfig, PdfSearchDirection, PdfSearchOptions, Pdfium,
};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[cfg(windows)]
mod print;

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
            Kind::Search => self.search(payload),
            Kind::Print => self.print(payload),
            Kind::Close => self.close(payload),
            Kind::GetTextLayer => self.get_text_layer(payload),
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

    fn search(&mut self, payload: &[u8]) -> Result<(Kind, Vec<u8>), (u16, String)> {
        const REQUEST_FIXED_LEN: usize = 27;
        if payload.len() < REQUEST_FIXED_LEN {
            return Err((4, "SEARCH payload is truncated".into()));
        }
        let tab_id: [u8; 16] = payload[..16]
            .try_into()
            .map_err(|_| (4, "invalid tab identifier".into()))?;
        let generation = read_u64(payload, 16).map_err(protocol_err)?;
        let flags = payload[24];
        let query_len = read_u16(payload, 25).map_err(protocol_err)? as usize;
        let expected_len = REQUEST_FIXED_LEN
            .checked_add(query_len)
            .ok_or_else(|| (4, "SEARCH query length overflow".into()))?;
        if self.identity != Some((tab_id, generation)) {
            return Err((
                6,
                "search does not match the active document generation".into(),
            ));
        }
        if generation == 0
            || flags & !0b11 != 0
            || query_len == 0
            || query_len > MAX_SEARCH_QUERY_BYTES
            || expected_len != payload.len()
            || payload.len() > MAX_CONTROL_PAYLOAD
        {
            return Err((4, "invalid SEARCH flags or query length".into()));
        }
        let query = std::str::from_utf8(&payload[REQUEST_FIXED_LEN..])
            .map_err(|_| (4, "SEARCH query is not UTF-8".into()))?;
        if query.trim().is_empty() {
            return Err((4, "SEARCH query is empty".into()));
        }
        let document = self
            .document
            .as_ref()
            .ok_or_else(|| (6, "no document is open".into()))?;
        let options = PdfSearchOptions::new()
            .match_case(flags & 0b01 != 0)
            .match_whole_word(flags & 0b10 != 0);
        let mut matches: Vec<(u32, Vec<u8>)> = Vec::new();
        let mut truncated = false;
        'pages: for page_index in 0..document.pages().len() {
            let page = document
                .pages()
                .get(page_index)
                .map_err(|e| (7, format!("could not open page for search: {e}")))?;
            let text = page
                .text()
                .map_err(|e| (7, format!("could not read page text: {e}")))?;
            let search = text
                .search(query, &options)
                .map_err(|e| (7, format!("could not search page text: {e}")))?;
            for result in search.iter(PdfSearchDirection::SearchForward) {
                if matches.len() == MAX_SEARCH_RESULTS {
                    truncated = true;
                    break 'pages;
                }
                let text = result
                    .iter()
                    .map(|segment| segment.text())
                    .collect::<Vec<_>>()
                    .join(" ");
                let excerpt = bounded_match_text(text);
                if !excerpt.is_empty() {
                    matches.push((page_index as u32, excerpt));
                }
            }
        }

        let mut response = Vec::with_capacity(28 + matches.len() * 16);
        response.extend_from_slice(&tab_id);
        response.extend_from_slice(&generation.to_be_bytes());
        response.extend_from_slice(&(matches.len() as u16).to_be_bytes());
        response.push(u8::from(truncated));
        response.push(0);
        for (page_index, excerpt) in matches {
            response.extend_from_slice(&page_index.to_be_bytes());
            response.extend_from_slice(&(excerpt.len() as u16).to_be_bytes());
            response.extend_from_slice(&excerpt);
        }
        if response.len() > MAX_CONTROL_PAYLOAD {
            return Err((
                8,
                "SEARCH results exceeded the bounded response size".into(),
            ));
        }
        Ok((Kind::SearchResults, response))
    }

    fn print(&mut self, payload: &[u8]) -> Result<(Kind, Vec<u8>), (u16, String)> {
        const PRINT_REQUEST_LEN: usize = 45;
        if payload.len() != PRINT_REQUEST_LEN {
            return Err((4, "PRINT payload must be exactly 45 bytes".into()));
        }
        let tab_id: [u8; 16] = payload[..16]
            .try_into()
            .map_err(|_| (4, "invalid PRINT tab identifier".into()))?;
        let generation = read_u64(payload, 16).map_err(protocol_err)?;
        let current_page = read_u32(payload, 24).map_err(protocol_err)?;
        let owner_window = read_u64(payload, 28).map_err(protocol_err)?;
        let page_selection = payload[36];
        let range_start = read_u32(payload, 37).map_err(protocol_err)?;
        let range_end = read_u32(payload, 41).map_err(protocol_err)?;
        if generation == 0 || self.identity != Some((tab_id, generation)) {
            return Err((
                6,
                "PRINT does not match the active document generation".into(),
            ));
        }
        if owner_window == 0 {
            return Err((4, "PRINT owner window handle is invalid".into()));
        }
        let document = self
            .document
            .as_ref()
            .ok_or_else(|| (6, "no document is open".into()))?;
        let page_count = u32::try_from(document.pages().len())
            .map_err(|_| (4, "PDF page count exceeds protocol range".into()))?;
        if current_page >= page_count {
            return Err((4, "PRINT current page is outside the document".into()));
        }
        match page_selection {
            0 | 1 if range_start == 0 && range_end == 0 => {}
            2 if range_start > 0 && range_start <= range_end && range_end <= page_count => {}
            0..=2 => return Err((4, "PRINT page-selection metadata is invalid".into())),
            _ => return Err((4, "PRINT page-selection mode is unknown".into())),
        }
        if page_selection == 1 && page_count > 10_000
            || page_selection == 2 && range_end - range_start + 1 > 10_000
        {
            return Err((4, "PRINT is limited to 10,000 pages per job".into()));
        }

        #[cfg(windows)]
        let outcome = {
            let owner_window = usize::try_from(owner_window).map_err(|_| {
                (
                    4,
                    "PRINT owner window handle is outside the platform range".into(),
                )
            })?;
            print::print_document(
                document,
                owner_window,
                current_page,
                page_selection,
                range_start,
                range_end,
            )
            .map_err(|error| (7, error))?
        };

        #[cfg(not(windows))]
        let outcome = {
            let _ = (
                document,
                owner_window,
                page_selection,
                range_start,
                range_end,
            );
            return Err((
                7,
                "Native PDF printing is currently supported on Windows only".into(),
            ));
        };

        let mut response = Vec::with_capacity(29);
        response.extend_from_slice(&tab_id);
        response.extend_from_slice(&generation.to_be_bytes());
        response.push(u8::from(!outcome.cancelled));
        response.extend_from_slice(&outcome.pages_printed.to_be_bytes());
        Ok((Kind::PrintResult, response))
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

    fn get_text_layer(&mut self, payload: &[u8]) -> Result<(Kind, Vec<u8>), (u16, String)> {
        const REQUEST_LEN: usize = 28; // tab_id(16) + generation(8) + page_index(4)
        if payload.len() != REQUEST_LEN {
            return Err((4, "GET_TEXT_LAYER payload must be 28 bytes".into()));
        }
        let tab_id: [u8; 16] = payload[..16]
            .try_into()
            .map_err(|_| (4, "invalid tab identifier".into()))?;
        let generation = read_u64(payload, 16).map_err(protocol_err)?;
        let page_index = read_u32(payload, 24).map_err(protocol_err)?;
        if self.identity != Some((tab_id, generation)) {
            return Err((
                6,
                "GET_TEXT_LAYER does not match the active document".into(),
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
            .map_err(|e| (7, format!("could not open page {page_index}: {e}")))?;
        let page_height = page.height().value; // PDF user-space points, y=0 at bottom
        let text_page = page.text().map_err(|e| {
            (
                7,
                format!("could not get text layer for page {page_index}: {e}"),
            )
        })?;

        // Binary encoding per span:
        //   x:        f32 BE  (4 bytes) — left edge in PDF points
        //   y:        f32 BE  (4 bytes) — top edge, CSS-flipped (page_height - pdf_top)
        //   w:        f32 BE  (4 bytes) — width in PDF points
        //   h:        f32 BE  (4 bytes) — height in PDF points
        //   text_len: u16 BE  (2 bytes) — byte length of the following UTF-8 string
        //   text:     [u8]    (text_len bytes)
        // Response prefix: u32 BE span count.
        let chars = text_page.chars();
        let mut spans: Vec<(f32, f32, f32, f32, String)> = Vec::new();
        for ch in chars.iter() {
            let unicode = match ch.unicode_char() {
                Some(c) if c != '\0' && c != '\r' && c != '\n' => c,
                _ => continue,
            };
            if let Ok(bounds) = ch.loose_bounds() {
                let x = bounds.left().value;
                let pdf_top = bounds.top().value;
                let y = page_height - pdf_top;
                let w = (bounds.right().value - bounds.left().value).max(0.5);
                let h = (pdf_top - bounds.bottom().value).max(0.5);
                spans.push((x, y, w, h, unicode.to_string()));
            }
        }

        // Encode to binary, truncating at the byte limit.
        let mut response = Vec::with_capacity(4 + spans.len() * 20);
        response.extend_from_slice(&(spans.len() as u32).to_be_bytes());
        let mut written_spans: u32 = 0;
        for (x, y, w, h, text) in &spans {
            let text_bytes = text.as_bytes();
            let entry_len = 4 + 4 + 4 + 4 + 2 + text_bytes.len();
            if response.len() + entry_len > MAX_TEXT_LAYER_BYTES {
                break;
            }
            response.extend_from_slice(&x.to_be_bytes());
            response.extend_from_slice(&y.to_be_bytes());
            response.extend_from_slice(&w.to_be_bytes());
            response.extend_from_slice(&h.to_be_bytes());
            response.extend_from_slice(&(text_bytes.len() as u16).to_be_bytes());
            response.extend_from_slice(text_bytes);
            written_spans += 1;
        }
        // Patch the span count at offset 0 to reflect how many actually fit.
        response[0..4].copy_from_slice(&written_spans.to_be_bytes());
        Ok((Kind::TextLayer, response))
    }
}

fn bounded_match_text(text: String) -> Vec<u8> {
    let mut result = String::new();
    for character in text.chars() {
        if result.len() + character.len_utf8() > MAX_SEARCH_EXCERPT_BYTES {
            break;
        }
        result.push(character);
    }
    result.into_bytes()
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

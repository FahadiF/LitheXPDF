use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

fn worker() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_pdfium-worker"))
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("smoke-one-page.pdf")
}

fn pdfium_dll() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("src-tauri")
        .join("resources")
        .join("pdfium")
        .join("pdfium.dll")
        .canonicalize()
        .expect("selected PDFium DLL must exist for the compatibility integration test")
}

fn temp_path(extension: &str) -> PathBuf {
    let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "lithexpdf-pdfium-test-{}-{id}.{extension}",
        std::process::id()
    ))
}

fn run(pdfium: &Path, input: &Path, output: &Path) -> Output {
    assert!(pdfium.is_absolute());
    assert!(input.is_absolute());
    assert!(output.is_absolute());
    Command::new(worker())
        .arg("--smoke-test")
        .arg("--pdfium-path")
        .arg(pdfium)
        .arg("--input")
        .arg(input)
        .arg("--output")
        .arg(output)
        .output()
        .expect("worker diagnostic process should start")
}

fn png_dimensions(bytes: &[u8]) -> (u32, u32) {
    assert!(bytes.len() >= 24);
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    (
        u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
        u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
    )
}

#[test]
fn missing_dll_path_fails_clearly() {
    let missing = temp_path("missing.dll");
    let output_path = temp_path("png");
    let result = run(&missing, &fixture(), &output_path);
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert_eq!(result.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("PDFium DLL does not exist"), "{stderr}");
    assert!(!output_path.exists());
}

#[test]
fn relative_dll_path_is_rejected_without_searching() {
    let result = Command::new(worker())
        .arg("--smoke-test")
        .arg("--pdfium-path")
        .arg("pdfium.dll")
        .arg("--input")
        .arg(fixture())
        .arg("--output")
        .arg(temp_path("png"))
        .output()
        .expect("worker diagnostic process should start");
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert_eq!(result.status.code(), Some(1), "{stderr}");
    assert!(
        stderr.contains("PDFium DLL path must be absolute"),
        "{stderr}"
    );
}

#[test]
fn invalid_dll_is_rejected_without_crashing() {
    let fake_dll = temp_path("dll");
    let output_path = temp_path("png");
    fs::write(&fake_dll, b"not a Windows DLL").unwrap();
    let result = run(&fake_dll, &fixture(), &output_path);
    let stderr = String::from_utf8_lossy(&result.stderr);
    let _ = fs::remove_file(&fake_dll);
    assert_eq!(result.status.code(), Some(1), "{stderr}");
    assert!(
        stderr.contains("could not load the explicitly selected PDFium DLL"),
        "{stderr}"
    );
    assert!(!output_path.exists());
}

#[test]
fn selected_pdfium_opens_renders_and_closes_known_fixture() {
    let output_path = temp_path("png");
    let result = run(&pdfium_dll(), &fixture(), &output_path);
    let stdout = String::from_utf8_lossy(&result.stdout);
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert_eq!(
        result.status.code(),
        Some(0),
        "stdout={stdout}\nstderr={stderr}"
    );
    assert!(stdout.contains("pages=1"), "{stdout}");
    assert!(stdout.contains("page1_points=200.00x120.00"), "{stdout}");
    assert!(stdout.contains("render_px=200x120"), "{stdout}");
    let png = fs::read(&output_path).expect("worker should write the PNG before exiting");
    assert!(!png.is_empty());
    assert_eq!(png_dimensions(&png), (200, 120));
    fs::remove_file(output_path).unwrap();
}

#[test]
fn corrupt_pdf_returns_error_without_crashing_or_creating_output() {
    let corrupt_pdf = temp_path("pdf");
    let output_path = temp_path("png");
    fs::write(&corrupt_pdf, b"not a PDF").unwrap();
    let result = run(&pdfium_dll(), &corrupt_pdf, &output_path);
    let stderr = String::from_utf8_lossy(&result.stderr);
    let _ = fs::remove_file(&corrupt_pdf);
    assert_eq!(result.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("could not open PDF"), "{stderr}");
    assert!(!output_path.exists());
}

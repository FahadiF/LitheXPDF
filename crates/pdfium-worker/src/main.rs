//! Scaffold only. This binary intentionally does not load PDFium or render PDFs.

fn main() {
    eprintln!(
        "LitheXPDF PDFium worker scaffold: rendering is not implemented; refusing to start."
    );
    std::process::exit(78);
}

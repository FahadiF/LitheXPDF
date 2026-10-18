# PDFium worker scaffold

This separate binary is only a packaging and workspace placeholder. It does
not link `pdfium-render`, load PDFium, implement the binary IPC protocol, or
render documents. It exits with status 78 instead of presenting itself as a
working renderer. PDFium integration remains blocked on the compatibility gate
in `docs/adr/0001-tauri-rust-pdfium.md`.

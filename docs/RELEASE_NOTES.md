# LitheXPDF 0.1.0 — Windows Preview

LitheXPDF is an early Windows PDF reader built with Rust, Tauri 2, and PDFium.
This release provides a first installable build for evaluation.

## Included

- Continuous PDF viewing with page navigation, zoom, and rotation.
- Multiple document tabs, with one PDFium document active at a time.
- Text search, page bookmarks, and light and dark themes.
- Windows printing for the current page, all pages, or a selected page range.
  The LitheXPDF print dialog shows the document page count and validates the
  selected range; printer and driver settings are provided by Windows.
- A LitheXPDF application icon in the installer’s installed-product entry.

## Before installing

This preview MSI is unsigned. Windows may show a publisher or reputation
warning. Installation on a clean Windows machine and printer behavior have not
been fully verified. PDFium compatibility beyond the operations exercised so
far remains under review.

Please report issues with your Windows version, steps to reproduce, and any
relevant error messages. Do not attach confidential PDFs.

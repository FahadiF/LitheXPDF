# LitheXPDF Roadmap

This document tracks feature milestones, planned work, and long-term goals.
Current stable release: **v0.2.0**

---

## Released

### v0.1.0 — Initial preview (Windows x64)
- Continuous PDF viewing with smooth vertical scroll
- Multi-document tab strip with single active worker model
- Page navigation (arrows, keyboard shortcuts, page-number jump)
- Zoom (per-tab), rotation (90° steps), fit-to-width
- Full-document text search (Ctrl+F) with case/whole-word options
- Per-document bookmarks, persisted between sessions
- Print support — custom page selector + native Windows printer dialog
- Recent files list
- Dark / light theme (follows system preference or manual toggle)
- Windows file association (.pdf) — set as default handler from Options
- Bounded page preloading with four render modes (On-demand → Maximum)

### v0.1.1 — Windows integration & styling fixes (Windows x64)
- Windows Default Apps handler registration refinements
- App icon and packaging adjustments
- Quality vs. Speed render-density mode preference

### v0.2.0 — Text, Tabs, Session & Dual Architecture (Windows x64 + x86)
- **Text selection and copy** — click-drag to select text directly on rendered pages; Ctrl+C copies to clipboard
- **Session restore** — all open tabs and per-document scroll positions survive app restart
- **Tab drag-to-reorder** — HTML5 drag-and-drop tab organization
- **Tab right-click context menu** — Close, Close Others, Close to Right, Close All, Pin, Duplicate, Show in Explorer, Copy path
- **Show in Explorer** — highlights the selected PDF file in Windows Explorer
- **Official 32-bit (x86) and 64-bit (x64) installers** — fully separated architecture pipelines, per-arch PDFium DLL packaging, and WiX component architecture alignment

---

## Upcoming

### v0.3.0 — Annotation layer
Core annotation support saved as a copy of the original document:

- **Highlight** — select text, apply a color highlight (yellow, green, pink)
- **Freehand drawing** — pen/pencil strokes over any page
- **Sticky notes** — place a comment box anywhere on a page
- Annotations always save as `{filename} (annotated).pdf`; original is never overwritten
- Annotation toolbar with mode buttons (pointer, highlight, pen, note)

### v0.3.x — Polish and reliability
- Encrypted PDF support — password prompt on open
- Robust error dialogs on corrupt or unsupported PDFs
- Thumbnail sidebar (page strip) — click to jump to any page
- Keyboard shortcut to toggle sidebar

### v0.4.0 — Export and extraction
- Copy selected text as formatted Markdown
- Export the current page as PNG or JPEG image
- Table detection and CSV export for selected table regions

### v0.5.0 — Reading experience & navigation
- Table of contents panel (PDF outline/bookmarks tree)
- Presentation / fullscreen reading mode
- Two-page side-by-side view
- Hyperlink support — clickable internal document jumps and external URLs

### v1.0.0 — Stable release gates
Before tagging 1.0:

- Authenticode code-signing certificate to eliminate SmartScreen warnings
- Clean install and uninstall verified on fresh Windows 10 and Windows 11 environments
- Automated test coverage in CI (TypeScript, Rust unit, and packaged installer checks)
- Full dependency audits clean (`pnpm audit` and `cargo audit`)
- Full keyboard-only navigation throughout the application
- WCAG 2.1 AA color contrast compliance in both dark and light themes

---

## Out of scope
- Linux or macOS support (Windows-first focus)
- In-browser extension or web application
- Optical Character Recognition (OCR) for scanned images
- PDF document authoring / form filling
- Cloud synchronization or mandatory user accounts

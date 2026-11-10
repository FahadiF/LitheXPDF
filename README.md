# LitheXPDF

A fast, lightweight Windows PDF reader built with Rust, Tauri 2, TypeScript, and PDFium. Open dozens of documents in tabs while keeping memory use low — only the active document is fully rendered; every other tab holds just its path and last-read position.

<img width="1106" height="694" alt="LitheXPDF reader with dark theme" src="https://github.com/user-attachments/assets/ea50296f-ac00-428c-96e1-b8a7c77d8d5d" />

<img width="1160" height="841" alt="LitheXPDF reader with light theme" src="https://github.com/user-attachments/assets/438efc2b-6a73-4fba-855c-01484d841cef" />

---

## Features

- **Multi-tab** — open up to 100 PDF documents at once; switch instantly between them
- **Session restore** — reopen all tabs from the previous session at startup (on by default, can be disabled in Options)
- **Tab management** — drag tabs to reorder; right-click any tab for close, close others, restore recently closed, copy path, and Show in Explorer
- **Continuous scroll** — smooth vertical scrolling through every page
- **Page preloading** — four preload modes from On-demand through Maximum (up to 30 cached pages)
- **Text search** — full-document search with match-case and whole-word options
- **Bookmarks** — per-document page bookmarks persisted in browser storage
- **Zoom and rotation** — per-tab zoom (Ctrl+/Ctrl−) and page rotation
- **Print** — LitheXPDF page selector (current, all, or range up to 10,000 pages) then Windows printer dialog
- **Recent files** — quick access to previously opened documents
- **Dark and light themes** — follows system preference or switch manually
- **Windows file association** — set LitheXPDF as the system default PDF handler

---

## How it works

LitheXPDF runs three processes:

1. **TypeScript UI** — renders the tab strip, viewer, and all dialogs in a WebView2 window
2. **Rust host** (`src-tauri`) — handles window management, Tauri commands, and coordinates with the worker
3. **PDFium worker** (`crates/pdfium-worker`) — a separate sidecar process that owns the PDFium library; communicates with the host over a binary IPC protocol

Only one PDF document is open in the PDFium worker at any time. Background tabs hold path and view state only — they add no rendering cost. When you switch tabs the previous document is closed in the worker and the new one is opened.

---

## Technology

| Layer | Stack |
|---|---|
| Desktop shell | [Tauri 2](https://tauri.app) + WebView2 |
| PDF rendering | [PDFium](https://pdfium.googlesource.com/pdfium/) via [pdfium-render](https://github.com/ajrcarey/pdfium-render) |
| Host language | Rust stable |
| Frontend | Vanilla TypeScript, HTML, CSS — no framework |
| Build tooling | Vite 6, pnpm 12 |

---

## Requirements

- Windows 10 or Windows 11, 64-bit
- [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (included on Windows 11; downloadable for Windows 10)
- [Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist) (usually already present)

---

## Install

Download the latest MSI from the [Releases](https://github.com/FahadiF/LitheXPDF/releases) page and run the installer.

> [!NOTE]
> Releases are currently unsigned. Windows SmartScreen may show a warning on first run — click **More info → Run anyway** to proceed. This will resolve once the project obtains a code-signing certificate.

---

## Build from source

**Prerequisites:** Rust stable toolchain, Node.js 18+, pnpm 12+, `x86_64-pc-windows-msvc` Rust target.

```powershell
# Clone
git clone https://github.com/FahadiF/LitheXPDF.git
cd LitheXPDF

# Install frontend dependencies
pnpm install

# Build and stage the PDFium worker (required before tauri dev or build)
pnpm worker:build:x64
pnpm worker:stage:x64

# Start development mode
pnpm tauri dev

# Produce a release MSI
pnpm release:msi:x64
```

The PDFium DLL (`src-tauri/resources/pdfium/pdfium.dll`) is not included in the repository. Download a prebuilt Windows x64 binary from [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries/releases) and place it at that path before building.

---

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Open PDF | Ctrl+O |
| New tab | Ctrl+T |
| Close tab | Ctrl+W |
| Next tab | Ctrl+Tab |
| Previous tab | Ctrl+Shift+Tab |
| Zoom in | Ctrl++ |
| Zoom out | Ctrl+− |
| Print | Ctrl+P |
| Previous page | ← |
| Next page | → |
| Help | F1 |

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — process model, IPC protocol, memory policy
- [Render protocol](docs/RENDER_PROTOCOL.md) — binary frame format between host and worker
- [Memory policy](docs/MEMORY_POLICY.md) — cache limits and eviction rules
- [Testing](docs/TESTING.md) — test plan and release gates
- [Roadmap](docs/ROADMAP_1.0.md) — planned features and milestones

---

## License

MIT — see [LICENSE](LICENSE) for details.

PDFium is used under the BSD 3-Clause License. See [`src-tauri/resources/pdfium/THIRD_PARTY_NOTICES.txt`](src-tauri/resources/pdfium/THIRD_PARTY_NOTICES.txt).

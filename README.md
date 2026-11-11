# LitheXPDF

A fast, lightweight PDF reader built with Rust. Open dozens of documents in tabs while keeping memory usage low.

<img width="1106" height="694" alt="LitheXPDF reader with dark theme" src="https://github.com/user-attachments/assets/ea50296f-ac00-428c-96e1-b8a7c77d8d5d" />

<img width="1160" height="841" alt="LitheXPDF reader with light theme" src="https://github.com/user-attachments/assets/438efc2b-6a73-4fba-855c-01484d841cef" />

---

## Features

**Reading**
- Multi-tab — open up to 100 PDF documents at once; switch instantly between them
- Continuous scroll with smooth vertical page flow
- Zoom per tab (Ctrl+scroll or buttons), rotation (90° steps), fit-to-width
- Page navigation — arrows, keyboard shortcuts, or type a page number directly

**Text**
- Select text with click-drag; copy with Ctrl+C
- Full-document search (Ctrl+F) with case-sensitive and whole-word options, up to 250 highlighted matches

**Tabs & Session**
- Drag tabs to reorder
- Right-click any tab: Close, Close Others, Close to Right, Close All, Pin, Duplicate, Show in Explorer, Copy path
- Session restore — all tabs and scroll positions reopen at startup; disable in Options

**Bookmarks**
- Per-document bookmarks, persisted between sessions

**Print**
- LitheXPDF page selector (current page, all pages, or a custom range), then the native Windows printer dialog

**Appearance**
- Dark and light themes, auto-detects the system preference or switch manually
- File associations — set LitheXPDF as your system default PDF handler from Options

---

## Download

Download the latest MSI from the [Releases](https://github.com/FahadiF/LitheXPDF/releases) page.

| Installer | Platform |
|---|---|
| `LitheXPDF_x.y.z_x64_en-US.msi` | Windows 10/11 · 64-bit (recommended) |
| `LitheXPDF_x.y.z_x86_en-US.msi` | Windows 10/11 · 32-bit (legacy systems) |

> [!NOTE]
> Releases are currently unsigned. Windows SmartScreen may show a warning on first run — click **More info → Run anyway**. This will clear once the project has a code-signing certificate.

**Minimum requirements**

| | |
|---|---|
| OS | Windows 10 1803 or Windows 11 |
| Architecture | x64 (primary) · x86 available |
| WebView2 | Bundled in the installer |

---

## How it works

LitheXPDF runs as three separate processes:

```
TypeScript UI  →  Rust host (Tauri)  →  PDFium worker (sidecar)
```

- **TypeScript UI** — renders the tab strip, viewer, toolbar, and all dialogs inside a WebView2 window.
- **Rust host** (`src-tauri`) — manages the window, handles Tauri commands, and supervises the worker.
- **PDFium worker** (`crates/pdfium-worker`) — a sidecar process that owns PDFium exclusively; communicates with the host over a versioned binary protocol on stdio.

Only the active tab holds an open PDFium document. Background tabs store path and view state only — they add no rendering overhead. Switching tabs closes the previous document in the worker and opens the new one; this keeps memory tightly bounded regardless of how many tabs are open.

---

## Technology

| Layer | Stack |
|---|---|
| Desktop shell | [Tauri 2](https://tauri.app) + WebView2 |
| PDF rendering | [PDFium](https://pdfium.googlesource.com/pdfium/) via [pdfium-render](https://github.com/ajrcarey/pdfium-render) |
| Host | Rust stable |
| Frontend | Vanilla TypeScript, HTML, CSS — no framework |
| Build tooling | Vite 6 · pnpm 12 |

---

## Build from source

**Prerequisites:** Rust stable toolchain · Node.js 18+ · pnpm 12+ · `x86_64-pc-windows-msvc` Rust target

```powershell
# Clone
git clone https://github.com/FahadiF/LitheXPDF.git
cd LitheXPDF

# Install frontend dependencies
pnpm install

# Build and stage the PDFium worker (required before dev or release)
pnpm worker:build:x64
pnpm worker:stage:x64

# Start development mode
pnpm tauri dev

# Produce a release MSI
pnpm release:msi:x64
```

### Architecture-specific builds

LitheXPDF supports building separate, native installers for both 64-bit (`x64`) and 32-bit (`x86`) Windows.

Architecture-specific PDFium runtime libraries are kept separate:
- 64-bit: `src-tauri/resources/pdfium-x64/pdfium.dll`
- 32-bit: `src-tauri/resources/pdfium-x86/pdfium.dll`

The build scripts automatically verify binary headers and stage the matching worker sidecar and PDFium DLL:

```powershell
# Build and package 64-bit MSI
pnpm release:msi:x64

# Build and package 32-bit MSI (requires i686-pc-windows-msvc target)
rustup target add i686-pc-windows-msvc
pnpm release:msi:x86
```

---

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Open file | Ctrl+O |
| New tab | Ctrl+T |
| Close tab | Ctrl+W |
| Next tab | Ctrl+Tab |
| Previous tab | Ctrl+Shift+Tab |
| Zoom in | Ctrl++ |
| Zoom out | Ctrl+− |
| Find in document | Ctrl+F |
| Print | Ctrl+P |
| Previous page | ← |
| Next page | → |
| First page | Home |
| Last page | End |

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — process model, IPC protocol, memory policy
- [Render protocol](docs/RENDER_PROTOCOL.md) — binary frame format between host and worker
- [Memory policy](docs/MEMORY_POLICY.md) — cache limits and eviction rules
- [Testing](docs/TESTING.md) — test plan and release checklist
- [Roadmap](docs/ROADMAP.md) — planned milestones and feature goals

---

## License

GNU General Public License v3.0 (GPLv3) — see [LICENSE](LICENSE) for details.

PDFium is used under the BSD 3-Clause License. See [`src-tauri/resources/pdfium/THIRD_PARTY_NOTICES.txt`](src-tauri/resources/pdfium/THIRD_PARTY_NOTICES.txt).

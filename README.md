# LitheXPDF

LitheXPDF is an early-stage Windows PDF reader built with Rust, Tauri 2, TypeScript, and PDFium. The long-term goal is a lightweight reader that can keep 30 or more documents open in tabs.

**Light on memory. Fast through documents.** That is the goal for the app, not a measured performance claim yet.

<img width="1918" height="1030" alt="image" src="https://github.com/user-attachments/assets/30f67034-fe45-4707-9d7c-bcc202eee6d1" />

## Current status

The current reader connects the interface to a Rust host and a separate PDFium worker. It permits up to 100 document tabs in one window while keeping only one PDFium document active; inactive tabs retain path and view-position metadata. The reader includes continuous scrolling, page navigation, per-tab zoom, text search, bookmarks, dark/light themes, recent files, page preloading controls, and Windows printing. Printing starts with a LitheXPDF-styled page selector showing the document's total page count and validating a page range, then opens Windows printer selection and driver settings. The worker prints one bounded page bitmap at a time, with a 10,000-page job limit. The default warms up to 12 following page images in a bounded rolling cache after opening, then continues as the reader advances. This provides a continuous full-document scroll surface without eagerly retaining every raster image; pages beyond the warmed window can still need rendering time. Search runs inside the worker and returns bounded text metadata; scanned pages without an embedded text layer are not searchable. A Windows x64 0.1.0 preview MSI is publicly available. It is unsigned and has not been installed or validated on a clean machine. Its installed-product entry uses the LitheXPDF ICO; the setup wizard uses WiX's standard layout. PDFium compatibility beyond the exercised calls, broad document coverage, and the latest cache/printing workflow remain under validation; the preview is not a verified 1.0 release.

PDFium integration currently uses a specific `pdfium-render` and PDFium pairing. Compatibility beyond the calls verified so far, and reliable setup on a clean machine, still need validation. See the [testing plan](docs/TESTING.md) for current checks and release gates.

## Technology

- Rust stable and Tauri 2 for the desktop host
- Vanilla TypeScript, HTML, and CSS for the interface
- A separate Rust worker for PDFium operations
- Bounded, versioned binary messages between the host and worker

The frontend does not call PDFium directly; the Rust side owns document lifecycle and rendering.

Bookmarks store only page numbers and labels in the WebView's local storage,
under a key derived from a normalized document path. The hash is an identifier,
not encryption. Theme preference is also stored locally. Neither feature stores
PDF contents or rendered page images.

## Development setup

This project targets Windows. To work on the desktop app, install Node.js, pnpm, stable Rust with the MSVC target, Visual Studio C++ Build Tools and Windows SDK, and WebView2. See the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/) for the current platform requirements.

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm worker:build:windows
pnpm worker:stage:windows
pnpm tauri dev
```

To build a Windows x64 MSI after completing manual release checks, use
`pnpm release:msi` from Windows with the MSVC Rust toolchain and the VBSCRIPT
Windows optional feature enabled. The Tauri CLI can download and validate WiX
Toolset v3 when it is not installed. The script builds and stages the worker
before asking Tauri to create an MSI. A locally built MSI still requires
clean-machine installation and PDFium smoke tests before publication.

The worker build and staging commands prepare the Windows x64 sidecar. PDFium runtime compatibility and clean-machine packaging are still being validated, so the development commands do not imply that a distributable build is ready.

Useful checks:

```powershell
pnpm typecheck
pnpm test
pnpm build
cargo check --workspace --all-targets
cargo test --workspace
```

## Project notes

- [Architecture](docs/ARCHITECTURE.md) — document and worker ownership, tab states, and recovery
- [Memory policy](docs/MEMORY_POLICY.md) — proposed memory limits and measurement approach; targets are not results
- [Render protocol](docs/RENDER_PROTOCOL.md) — message bounds, generations, and stale-result handling
- [Testing plan](docs/TESTING.md) — completed checks, open issues, and acceptance criteria
- [Roadmap to 1.0.0](docs/ROADMAP_1.0.md) — stabilization, annotations, rendering measurements, x86, signing, and release gates
- [Release notes](docs/RELEASE_NOTES.md) — current preview release summary
- [Architecture decisions](docs/adr/) — recorded design decisions
- [Security policy](SECURITY.md) — supported versions and private vulnerability reporting

The memory and speed goal will need representative benchmarks before the project can claim that it meets it.

## License

LitheXPDF project source is licensed under the [MIT License](LICENSE). The bundled PDFium runtime is a separate third-party component with its own notices in `src-tauri/resources/pdfium/THIRD_PARTY_NOTICES.txt`.

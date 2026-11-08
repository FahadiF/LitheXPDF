# LitheXPDF

LitheXPDF is an early-stage Windows PDF reader built with Rust, Tauri 2, TypeScript, and PDFium. The long-term goal is a lightweight reader that can keep 30 or more documents open in tabs.

**Light on memory. Fast through documents.** That is the goal for the app, not a measured performance claim yet.

## Current status

The current reader connects the interface to a Rust host and a separate PDFium worker. It permits up to 100 document tabs in one window while keeping only one PDFium document active; inactive tabs retain path and view-position metadata. The reader includes continuous scrolling, page navigation, per-tab zoom, text search, bookmarks, dark/light themes, recent files, rendering modes, and current-page printing. Search runs inside the worker and returns bounded text metadata; scanned pages without an embedded text layer are not searchable. The new tab and menu workflow still needs manual WebView2 review. PDFium compatibility beyond the exercised calls, broad document coverage, and clean-machine packaging remain open, so LitheXPDF is not ready as a packaged release.

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
- [Architecture decisions](docs/adr/) — recorded design decisions
- [Security policy](SECURITY.md) — supported versions and private vulnerability reporting

The memory and speed goal will need representative benchmarks before the project can claim that it meets it.

## License

No license has been selected for the LitheXPDF project source. Do not assume it is offered under an open-source license. The bundled PDFium runtime is a separate third-party component with its notices in `src-tauri/resources/pdfium/THIRD_PARTY_NOTICES.txt`.

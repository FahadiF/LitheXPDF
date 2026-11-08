# Testing and release readiness

LitheXPDF is an early-stage Windows application. This page records reproducible
checks and remaining validation work. A passing build does not establish full
PDF compatibility, packaged readiness, or lower memory use.

## Automated checks

Run from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm audit
pnpm typecheck
pnpm test
pnpm build
cargo check --workspace --all-targets
cargo test --workspace
```

For the Windows x64 worker and desktop development run:

```powershell
cargo build --release --target x86_64-pc-windows-msvc -p pdfium-worker
node scripts/stage-worker-windows.mjs
pnpm tauri dev
```

Latest recorded results (2026-11-08): frozen pnpm install, full pnpm audit,
typecheck, production build, Cargo workspace check, and sidecar build/staging
passed. The frontend suite passed 7 tests; the latest recorded Rust workspace
run passed 32 tests. `pnpm tauri dev` started Vite and the Tauri host; the Vite
page returned HTTP 200. Rust dependency advisories have not yet been checked.

The frontend tests cover binary response validation, loading/hidden state,
stale-image cleanup, render errors, and viewport-page selection. Rust tests
cover the binary protocol, worker supervision, PDFium smoke paths, and worker
lifecycle. Automated tests do not replace manual WebView2 testing.

## Manual desktop validation

An earlier manual run opened a multi-page PDF and displayed a page. The latest
scroll and aspect-ratio corrections still need verification in the desktop
WebView2 window.

- [ ] Open `crates/pdfium-worker/tests/fixtures/smoke-two-page.pdf`; confirm
      page 1 has the correct proportions and the loading indicator clears.
- [ ] Scroll through both pages and back; confirm the page counter follows the
      page nearest the viewport.
- [ ] Use Previous and Next, including at page boundaries; confirm the correct
      page appears and controls disable at the ends.
- [ ] Open a second PDF; confirm no image from the previous document appears.
- [ ] Open an invalid PDF; confirm a useful error appears and a valid PDF can
      be opened afterward.
- [ ] Close the document; confirm the image clears and the worker closes it.
- [ ] Close the app; confirm the worker process exits.

The UI creates one lightweight slot per page and renders only the page nearest
the viewport. Test very high page counts before deciding whether page-slot
virtualization is needed.

## Compatibility and release gates

- The selected runtime is PDFium 157.0.8086.0 with `pdfium-render` 0.9.4 and
  the `pdfium_7881` API binding. Tested open/render calls work, but complete API
  compatibility is not established.
- Packaged execution, clean-machine dependencies, installer behavior, and
  worker recovery from a packaged installation have not been verified.
- The PDFium worker is a separate process, not an operating-system sandbox; it
  runs with the current user's privileges.
- No memory or performance improvement is claimed. Memory and latency
  measurements on a representative PDF corpus remain outstanding.
- Multiple tabs are not implemented; the app supports one live PDFium document.

Do not treat the project as release-ready until the manual checks,
compatibility gates, and clean-machine packaging checks pass.
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

### Frontend follow-up — 2026-11-08

At that point in the project history, placeholder search, annotation, and theme
controls had been removed pending real implementations. The five-slot page-DOM
experiment was reverted after it limited navigation to the slot window,
shortened the document's scroll extent, and failed the existing image-lifecycle
test. The current reader keeps lightweight slots for all pages and moves one
shared image between them. This restores full-document navigation; it is not
DOM virtualization and no memory improvement is claimed.

After removing nonfunctional search, annotation, and theme controls and adding
long-document navigation, URL-cleanup, and mixed-page-aspect-ratio tests,
`pnpm typecheck`, `pnpm test` (9 tests), `pnpm build`, and `git diff --check`
passed. Rust checks were not rerun because no Rust source changed. The desktop
window, large-document workload, memory, and render performance were not
measured in this follow-up.

## Manual desktop validation

The user reports that a 115-page PDF opened and rendered in an earlier manual
run. That check predates the latest toolbar, search, bookmark, and theme
changes. The current changes still need verification in the desktop WebView2
window.

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
virtualization is needed. The reverted five-slot experiment is not a supported
implementation; any later virtual scroller must preserve full-document scroll
geometry and pass navigation tests beyond its recycled slot window.

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

### Page jump, bookmarks, search, and theme — 2026-11-08

The toolbar now has a validated one-based page-number field between Previous
and Next. Bookmarks can be added to the current page, listed, opened, and
removed; the current implementation persists page numbers and labels in
WebView local storage under a SHA-256-derived key for the normalized file path.
The key hash is not encryption. Text search runs through the host and worker,
supports case-sensitive and whole-word options, displays up to 250 bounded
matches, and navigates to a matching page. It does not highlight text in the
rendered bitmap and does not OCR image-only pages. The theme toggle persists a
dark or light UI preference locally.

Checks run from the repository root after these changes:

| Command | Result |
| --- | --- |
| `cargo fmt --all` | Passed, exit 0 |
| `pnpm typecheck` | Passed, exit 0 |
| `pnpm test` | Passed, 16 tests, exit 0 |
| `pnpm build` | Passed, Vite production build, exit 0 |
| `cargo check --workspace --all-targets` | Passed, exit 0 |
| `cargo test --workspace` | Passed, 34 tests across host, protocol, worker, PDFium smoke, and worker protocol suites; exit 0 |
| `git diff --check` | Passed, exit 0; Git printed line-ending conversion warnings for edited files |

The real worker protocol test used the repository's two-page text fixture and
the locally selected PDFium DLL. It verified matches on both pages, case
sensitivity, whole-word matching, result bounds, and request correlation.
Frontend tests cover page-number bounds, bookmark persistence/navigation,
theme persistence, search response validation and navigation, stale search
rejection, existing long-document page navigation, and image URL cleanup.
These are automated checks; they do not confirm that the controls look or work
correctly in the actual Tauri WebView2 window.

Manual checks still needed in `pnpm tauri dev`:

- [ ] Enter page 1, a middle page, and the last page in the toolbar. Confirm
      Enter and field change navigate immediately, and 0/out-of-range values
      are rejected without changing the displayed page.
- [ ] Add a bookmark, navigate away, open the bookmark, remove it, and reopen
      the same PDF to confirm it persists. Open a different PDF and confirm its
      bookmarks are separate.
- [ ] Search a known phrase in a text PDF; test case and whole-word options,
      no-result behavior, and clicking a result. Confirm the target page loads.
      Test a scanned PDF and confirm the UI explains that no text layer was
      found.
- [ ] Toggle light/dark mode, close and relaunch the app, and confirm the
      selected theme persists.
- [ ] Repeat navigation and search in the user's 115-page PDF; confirm the
      page field tracks scrolling and no result from a previous document
      replaces the current page.

Search is serialized with other PDFium operations on the single worker thread.
The 30-second deadline bounds the host wait by terminating and reaping the
worker on timeout; it does not cancel PDFium in place. The PDFium runtime/API
compatibility caveat, packaged execution, clean-machine dependencies, memory
measurements, and performance benchmarks remain open. No memory or speed
improvement is claimed.

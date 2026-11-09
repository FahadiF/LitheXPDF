# Testing and release readiness

LitheXPDF is an early-stage Windows application. This page records reproducible
checks and remaining validation work. A passing build does not establish full
PDF compatibility, packaged readiness, or lower memory use.

## Windows default-app integration — 2026-11-09

The current working tree adds an MSI WiX fragment that registers LitheXPDF as
a selectable PDF handler without changing the user's Windows default. The
first-run prompt and Options controls open Default apps; the user must confirm
the `.pdf` association. The host captures a `.pdf` startup argument so a file
opened from Explorer can be loaded after launch.

Checks for this implementation pass:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed, exit 0 |
| `pnpm build` | Passed, exit 0; Vite bundled the canonical icon from `src-tauri/icons/lithexpdf.png` without a `public/` directory |
| `cargo check --workspace --all-targets` | Passed, exit 0 with a temporary target directory and repository access; the sandboxed attempt was blocked by Tauri context-generation access to the working directory |
| `pnpm tauri build --bundles msi` | Passed, exit 0; local unsigned x64 MSI built under the temporary target directory. Generated WiX object contains the PDF ProgID, `.pdf` capability, `RegisteredApplications` entry, and host open command. |
| `git diff --check` | Passed, exit 0; Git emitted configured LF-to-CRLF warnings |
| Frontend/Rust tests | Not run in this pass |

The 0.1.1 MSI was rebuilt locally with `pnpm release:msi` (exit 0) after the
larger ICO, clearer Settings instructions, and extra Windows `Applications`
handler registration. The worker build/staging, frontend production build,
host release build, and WiX candle/light packaging all passed. The MSI reports
ProductVersion `0.1.1` and contains the host, worker, PDFium DLL, third-party
notices, and both app-capability and Open With association entries. Its
Authenticode status is `NotSigned`.

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `target/release/bundle/msi/LitheXPDF_0.1.1_x64_en-US.msi` | 8,474,624 bytes | `1CBD1D040CA7A45DF2D52B84DA373FC2856A417E679A5CB2712FFC902F3104D8` |

An earlier 0.1.1 candidate was installed on the developer's Windows machine;
this rebuilt MSI has not been installed. No 0.1.1 build has been published;
the public `v0.1.0` release was left unchanged. The user reported that the
Options button opened Documents instead of Windows Settings; the code now
launches the URI through `ShellExecuteW`, and the reported Windows Settings
page confirms URI navigation works. The updated handler picker still needs
manual testing.

Explorer thumbnails are not implemented and have no toggle. A real Windows
Shell thumbnail provider needs an architecture review so it cannot create a
second, concurrent PDFium worker or bypass the existing worker ownership and
memory bounds.

### Follow-up findings from the local Windows installation

The v0.1.1 uninstall attempt failed with Windows Installer event 11310: error
1310 while creating `E:\Program Files\LitheXPDF\30ea91.rbf`, with system error
1307 (`ERROR_INVALID_OWNER`). The `.rbf` path is a Windows Installer rollback
file, not a file in the MSI's application file table. The E: volume is NTFS
with substantial free space; the error is not evidence of a full disk. The
exact ownership/ACL cause has not been established, so uninstall is a release
blocker and no rollback-suppression workaround has been added. Verify uninstall
with a verbose MSI log and on a clean Windows environment before release.

The Options dialog now hides rendering and cache explanations behind
keyboard-accessible info buttons. This UI change is build-checked but still
needs visual review in the desktop app. The rebuilt MSI has replaced the local
ignored artifact at the standard path; it has not been installed or published.

### Windows icon, app picker, and space calculation — 2026-11-09

The user's Settings screenshot is the LitheXPDF-specific Default Apps page. Its
`.pdf` tile displays the *current* handler (SumatraPDF), not the list of
available handlers. Clicking that tile should open the handler picker. The
installed registry contains the machine `RegisteredApplications` capability,
the `.pdf` capability, the LitheXPDF ProgID, and `.pdf\OpenWithProgids`; the
additional `Applications\lithexpdf-host.exe\SupportedTypes` registration was
absent. It has been added to the next MSI candidate to improve Windows Open
With discoverability. The picker still needs manual confirmation after
installing the updated package.

The original PNG has visible artwork bounds 320 x 414 inside a 512 x 512
transparent canvas. A derived Windows source scales the same artwork to 386 x
500, preserving transparency and the original source PNG. The local Tauri CLI
regenerated `icon.ico` with 16, 24, 32, 48, 64, and 256 pixel frames. The
installer icon has not yet been visually checked after installation.

The MSI's “Computing space requirements” phase is Windows Installer file
costing. `CostInitialize`, `FileCost`, and `CostFinalize` are required to
calculate install/remove disk costs and validate target volumes; they are not
removed. The short phase remains.

## Current verification snapshot — 2026-11-09

The public `v0.1.0` x64 preview exists; this snapshot concerns the current
working tree, not a claim that the published MSI contains these local changes.
The user reports a prior successful 115-page manual read, but the latest
image-cache and print changes still need packaged desktop review. The selected
next target is 1.0.0 with separate x64 and x86 MSIs.

Checks in this environment after updating the test DOM fixture for the print
dialog and correcting protocol tests that still expected version 1:

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed, exit 0 outside the restricted sandbox with installed pnpm 12.14.0; the lockfile was unchanged. The project requests pnpm 11.25.0, which could not be downloaded here. |
| `pnpm typecheck` | Passed, exit 0 using installed pnpm with process-local `npm_config_manage_package_manager_versions=false`; the pinned pnpm version could not be downloaded in this network-restricted environment. |
| `pnpm test` | Passed, 23 tests, exit 0 using the same pnpm workaround. |
| `pnpm build` | Passed, exit 0 when run outside the restricted sandbox. A default sandboxed run cannot clear `dist` and exits 1 with `EPERM`. |
| `cargo check --workspace --all-targets --target x86_64-pc-windows-msvc` | Passed, exit 0 with `CARGO_TARGET_DIR` in `%TEMP%` and execution outside the restricted filesystem sandbox. The first sandboxed attempt failed because `tauri::generate_context!()` could not access the working directory (exit 101). |
| `cargo test --workspace --target x86_64-pc-windows-msvc` | Passed, exit 0: 35 tests across host, protocol, worker, PDFium smoke, annotation compatibility, and real worker protocol integration targets; zero doc tests. The first run exposed two stale protocol-version assertions; these were fixed and all tests then passed. |
| `cargo audit` | Unavailable: the cargo-audit subcommand is not installed. |
| `pnpm audit` | Not completed: package-registry access did not return in the allotted run; the network is unavailable in this environment. |
| Git state | Read-only inspection outside the restricted sandbox reports branch `main`, revision `affb48b`, tracking `origin/main`, with numerous modified files and existing untracked files. Preserve the dirty checkout; no files were staged or committed. `git diff --check` passes. |

The current suite has 23 frontend tests and 35 Windows-target Rust tests. Those
automated checks include worker/PDFium smoke tests and a one-page annotation
API probe, but do not exercise the current UI in a desktop window or install an
MSI. The x86 Rust target and matching x86 PDFium DLL are not staged.
Code-signing credentials are not available in this environment.

The public Actions page currently shows a successful CodeQL setup and four
failed Dependabot Cargo update runs for `glib`; these local workflow and policy
updates have not been pushed. The remote `SECURITY.md` still says there are no
supported release builds without acknowledging the published preview. The
local revision clarifies that `v0.1.0` is an evaluation preview, not a
supported stable release. The `glib` 0.18.5 alert is reached through GTK/WebKit Linux dependency
packages in the lockfile; the Windows target does not build those packages,
but the alert remains unresolved for the full dependency graph. Do not dismiss
it or claim the full dependency graph is clean. Install/use `cargo-audit` and
inspect Dependabot logs from an online environment before setting the 1.0
security gate.

The repository now contains `.github/workflows/windows-ci.yml`. It is a
Windows x64 validation and unsigned MSI-candidate workflow for pull requests,
pushes to `main`, and manual runs. It does not sign or publish. Its first
GitHub-hosted run is still pending; x86 is intentionally absent until a
matching DLL and validation environment are verified. The x86 artifact
identified in `docs/ROADMAP_1.0.md` remains a research candidate, not a selected
runtime. A new native compatibility probe creates, saves, and reloads a
highlight, free-text note, and ink annotation with the selected DLL; it is not
yet wired to the host-worker protocol or reader UI. Multi-page and rotated
geometry, output-copy workflow, and compatibility outside this one fixture are
still unverified.

Treat the dated entries below as evidence of what was tested at each point,
not as a statement of current status.

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
- Multiple UI tabs are implemented with one live PDFium document. The 30–50-tab switching workload has not been measured.

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


### Page-transition loader and bounded prefetch — 2026-11-08

The centered loading indicator now remains for the initial page open only.
During page changes the current image remains assigned until a validated
replacement arrives, and the status line is not changed to “Rendering page”.
The frontend waits one second after an installed page before prefetching only
the next page. The encoded response cache is limited to two entries and 16
MiB total; larger responses are not cached. Document open/replacement/close
clears the cache and URL references.

Automated verification in the repository root:

| Command | Result |
| --- | --- |
| pnpm typecheck | Passed, exit 0 |
| pnpm test | Passed, 20 tests, exit 0 |
| pnpm build | Passed, exit 0 |
| git diff --check | Passed, exit 0 |

The added frontend tests cover the hidden navigation loader and retained page
image, one-second delayed next-page prefetch and response reuse, delayed
prefetch cleanup on document close, and stale in-flight prefetch rejection
after navigating away. These tests do not measure process memory or prove a
performance improvement.

Manual desktop WebView2 confirmation is still required. In particular, open a
multi-page PDF, scroll quickly and slowly, confirm no centered loader appears
between pages, verify the first-page loader disappears after open, and compare
page transitions with prefetch enabled. The automated checks do not establish
the visual experience in the running Tauri window.


### Tabs, menu, zoom, print, and render modes — 2026-11-08

The frontend now permits up to 100 tab records in one window. Inactive tabs
retain only their path, ID, page index, zoom, and scroll offsets. Tab switches
close and acknowledge the previous native document before opening the selected
path. The recent menu stores up to ten file paths locally in WebView storage.
Tabs themselves are session-only and do not persist across app restarts.

The hamburger menu exposes Open, New tab, Recent, Zoom, Print, Options and
settings, Help, and About. About displays version 0.1.0 and the developer
contact and profile links supplied for the project. Zoom is per tab and ranges
from 25% to 400%. Printing currently prints the displayed page through the
WebView print dialog; full-document PDF printing is not implemented.

Rendering settings are current page only, current page plus next page, and
progressive all-pages rendering. All-pages mode walks pages serially after
idle pauses while keeping one render active and the existing two-entry/16 MiB
encoded cache. It can consume CPU and a foreground request may wait for an
already-running PDFium render. It does not retain every rendered page.

Checks actually run in this implementation pass:

| Command | Result |
| --- | --- |
| pnpm typecheck | Passed, exit 0 |
| pnpm build | Passed, exit 0 |
| git diff --check | Passed, exit 0; Git printed line-ending conversion warnings |

The automated test suite was not run and no new automated tests were added in
this pass. The desktop WebView2 window was not opened for manual verification.
Before treating the feature as complete, manually verify opening at least two
PDFs, switching tabs and restoring page/zoom/scroll state, closing active and
inactive tabs, selecting each rendering mode, zoom limits, the native print
dialog/current-page output, About links, and behavior with 30–50 tabs. The
all-pages mode's CPU impact and full-workload memory use remain unmeasured.

### Menu, bookmarks, and source-license follow-up — 2026-11-08

The menu now sits at the left of the top bar with a text label. Recent files
are exposed through a right-side submenu with a Clear recent action, and the
options label is shortened. The bookmarks panel now refreshes when opened,
announces its state to assistive technology, and receives keyboard focus. These
changes have not yet been exercised in a running WebView2 window. The menu and
bookmark interactions remain pending manual verification.

The project source now uses the MIT License, selected by the project owner.
This license does not replace or change the separate PDFium runtime notices.
The About dialog identifies the developer and links the project license.

Printing still sends only the displayed page to the WebView print dialog.
Printer and paper settings depend on the available system print dialog and
printer. Full-document and page-range printing are not implemented; the
current page-only raster path cannot safely be presented as whole-document
printing under the existing memory policy.

Checks run for this follow-up:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed, exit 0 |
| `pnpm build` | Passed, exit 0 |
| `pnpm test` | Not run |
| Desktop window review | Not available in this session; manual verification remains required |
| `git diff --check` | Passed, exit 0; Git reported its configured LF-to-CRLF conversion warnings |

### Active-document preloading settings — 2026-11-08

The previous choices appeared alike because they all waited one second, only
prefetched the immediate next page, and retained at most two responses. The
No preloading choice also still consumed frames already in that cache. The
implementation now has four observable active-document windows: 0, 3, 12
(default), and up to 30 pages. Selecting 0 clears cached responses. Initial
warm-up starts after one second; after navigation and between successful
prefetches, it continues serially with 40 ms gaps. It remains subject to one
active render and a shared 64 MiB/30-page encoded cache limit. Switching tabs
still clears the old document's cache; inactive tabs are not prefetched. The
preference key is versioned so existing installs receive the new 12-page
default once; new choices persist under the updated key.

The new settings and cache limit are implementation changes, not measured
memory or speed improvements. Checks run for this change:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed, exit 0 |
| `pnpm build` | Passed, exit 0 |
| `pnpm test` | Not run |
| Desktop WebView2 review | Not performed; manual comparison of all four choices remains outstanding |
| `git diff --check` | Passed, exit 0; Git reported its configured LF-to-CRLF conversion warnings |

Verify idle warm-up, normal scrolling, a jump past the cache window, switching
tabs, and No preloading after a prior mode has filled the cache.


### Rolling page-image cache and Windows MSI candidate — 2026-11-09

The active implementation now keeps full-document scroll geometry and places
validated page images in their own page slots. Recommended mode is the default:
it starts warming up to 12 following pages 250 ms after the first image is
installed, then continues serially with a 16 ms scheduling gap. The rolling
cache is limited to 30 page images, 64 MiB of encoded PNG bytes, and 64 MiB of
estimated decoded RGBA bytes; it keeps at most two previous pages. If a page
cannot fit in the decoded budget, background prefetch stops until navigation
or a settings change instead of repeatedly rendering pages that are evicted.
These are cache limits and tested lifecycle behavior, not measured memory or
speed improvements. Pages outside the warmed window can still need rendering.

Automated checks:

| Command | Result |
| --- | --- |
| `pnpm --version` | Passed; 11.25.0 |
| `pnpm typecheck` | Passed, exit 0 |
| `pnpm test` | Passed, 23 frontend tests, exit 0 |
| `pnpm build` | Passed, exit 0 |
| `cargo check --workspace --all-targets` | Passed, exit 0 with a temporary Cargo target directory and reviewed repository access |
| `cargo test --workspace` | Passed, 34 Rust tests, exit 0 with a temporary Cargo target directory and reviewed repository access |
| `cargo build --release --target x86_64-pc-windows-msvc -p pdfium-worker` | Passed, exit 0 |
| `node scripts/stage-worker-windows.mjs` | Passed, exit 0; staged worker SHA-256 matches the release build |
| `pnpm release:msi` | Passed, exit 0; the complete worker/frontend/host/MSI workflow finished |
| `git diff --check` | Passed, exit 0; Git emitted configured LF-to-CRLF warnings |

The release command produced
`target/release/bundle/msi/LitheXPDF_0.1.0_x64_en-US.msi` (8,278,016 bytes).
Its SHA-256 is `2225f0e03c00ae18b19a71a8e5ae59c9d33a10bb3608f86a8b2215e1c8e32af7`
(also saved beside the MSI). A read-only Windows Installer database query
confirmed the package contains the host executable, `pdfium-worker.exe`,
`pdfium.dll` (7,494,656 bytes), and `THIRD_PARTY_NOTICES.txt` (124,540 bytes).
The packaged worker size matches the staged release binary. Its product name
is LitheXPDF, version 0.1.0, and publisher Fahad Ibne Fahian. The MSI is not
digitally signed.

The MSI retains Tauri's default WebView2 `downloadBootstrapper` mode. A machine
without the WebView2 runtime needs internet access during installation; the
current package was not installed on a clean machine. See the [Tauri Windows
Installer documentation](https://v2.tauri.app/distribute/windows-installer/)
for the available WebView2 installation modes and their size/network tradeoffs.

Two earlier sandbox-only attempts were denied filesystem access: Vite could
not clean the repository's ignored `dist` output, and Cargo/Tauri could not
read the repository working directory. The production build and package were
then run successfully using the reviewed project command; workspace checks
also passed with the target directory under `%TEMP%`. These sandbox errors are
not source build failures.

Not verified in this pass: launching the updated app in a desktop WebView2
window, opening/scrolling short, long, and mixed-page-size PDFs with the new
image cache, installing and launching the MSI, clean-machine dependencies,
digital signing, performance baselines, or process/WebView memory measurements.
The prior manual 115-page check predates this cache change and is not evidence
for this implementation. Automated frontend coverage includes bounded URL
retention over 50 pages, decoded-cache saturation, stale responses, and keeping
the old image during a distant jump until the replacement decodes. The selected
PDFium 157.0.8086.0 / `pdfium-render`
0.9.4 / `pdfium_7881` pairing remains a partial-coverage compatibility gate.
Do not publish this local MSI as a verified release until the outstanding
desktop and installation checks are completed.

### Native multi-page Windows printing — 2026-11-09

This section records the initial native-print implementation. Its page
selection inside the Windows dialog is superseded by the LitheXPDF page
selector documented below; the native dialog now only selects the printer and
driver settings.

The earlier notes above describing current-page-only WebView printing are
historical and are superseded by this implementation. The toolbar, menu, and
Ctrl+P now invoke an asynchronous Tauri command. On Windows, the host sends a
bounded `PRINT` request to the existing worker; the worker opens the native
print property sheet, initially selects the current page, and supports current
page, all pages, or up to 16 page ranges. The dialog selects an installed
printer and exposes printer-specific settings; paper size and orientation
availability depend on that printer's driver. The worker renders selected
pages serially, one bitmap at a time, directly to the printer DC. Jobs are
limited to 10,000 pages and each temporary bitmap uses the renderer's existing
dimension and 32 MiB RGBA bounds. No image is sent through the WebView.

Application shutdown now waits asynchronously for an in-progress worker
operation for up to the separate 2,000 ms grace. If a print dialog or driver
still holds the operation lock, shutdown terminates and reaps the worker rather
than waiting indefinitely. The PDFium call and printer driver path still need
runtime observation on Windows.

Checks actually run for this change:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed, exit 0 |
| `pnpm build` | Passed, exit 0 |
| `cargo check --workspace --all-targets` | Passed, exit 0; the first attempt found and led to fixes for Windows bitmap helper imports, a `BI_RGB` binding type, and a host error-string conversion |
| `cargo build --release --target x86_64-pc-windows-msvc -p pdfium-worker` | Passed, exit 0 |
| `node scripts/stage-worker-windows.mjs` with `%TEMP%\LithexPDF-Cargo-Print` as `CARGO_TARGET_DIR` | Passed, exit 0; staged sidecar SHA-256 matches the release worker |
| `cargo fmt --all` | Passed, exit 0 |
| `git diff --check` | Passed, exit 0 after the documentation update |
| `pnpm test` / `cargo test --workspace` | Not run; no tests were added or executed in this implementation pass |

The native Windows dialog and printer output were not manually verified in
this session. Before treating printing as verified, use a multi-page document
(including the 115-page fixture if available) and test: current page, all
pages, a range such as 3–8, selecting a printer, paper size/orientation and
driver settings, cancelling, and closing the app while the print dialog is
open. Microsoft Print to PDF can provide a reproducible output for checking
the resulting page count. Also confirm the app remains responsive before the
native modal dialog opens and reports useful errors for missing printers or
failed print jobs. No print reliability, performance, or memory improvement
is claimed until those checks and measurements exist.

### Branded print selection and MSI artwork — 2026-11-09

The toolbar, menu, and Ctrl+P now open a LitheXPDF-styled page-selection
dialog before the Windows printer property sheet. It displays the current
page and total count, including the maximum range endpoint (for example,
`1–115` of `115`), validates inclusive one-based ranges, and prevents jobs
larger than the worker's 10,000-page limit. For a document over that limit,
the all-pages choice is disabled and smaller ranges remain available. The
Windows dialog remains responsible for printer selection and driver-specific
paper/orientation settings; its own page controls are disabled. The worker
still renders and prints pages sequentially, one bounded bitmap at a time.

Because the `PRINT` request payload changed from 36 to 45 bytes, the shared
PDFW protocol version is now 2. The host, worker, and WebView render-response
validator must be shipped from the same build. See ADR 0004.

The WiX output uses `icons/icon.ico` as the Windows Installer product icon
(`ProductIcon` / `ARPPRODUCTICON`). A later attempt to add custom WiX banner
and welcome/finish bitmaps was removed after manual review found text overlap
and poor contrast; the installer now uses the standard WiX page layout.

Checks actually run:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed, exit 0 using the installed pnpm 12.14.0 with process-local `npm_config_manage_package_manager_versions=false`; the project pins pnpm 11.25.0, but the default shim could not resolve that version because DNS lookup for `registry.npmjs.org` failed |
| `pnpm build` | Passed, exit 0 with the same local pnpm workaround; TypeScript and Vite production build both passed |
| `cargo check --workspace --all-targets --target x86_64-pc-windows-msvc` | Passed, exit 0 |
| `cargo fmt --all` and `cargo fmt --all -- --check` | Passed, exit 0 |
| `pnpm release:msi` | Passed, exit 0 with the local pnpm workaround; rebuilt the Windows x64 worker, staged it, rebuilt the host/frontend, and produced the MSI |
| `git diff --check` | Passed, exit 0; Git emitted configured LF-to-CRLF conversion warnings |
| `pnpm test` / `cargo test --workspace` | Not run in this implementation pass |

The MSI from that build was later replaced by the icon/layout correction below.
The MSI remains unsigned.

No desktop-window print interaction was performed. Manually verify a 115-page
PDF shows the page-count bound and accepts ranges such as `3–8`, rejects zero,
reversed, or out-of-document endpoints, prints current/all/range selections
through Microsoft Print to PDF, opens printer settings, and cancels cleanly.
Also verify that the custom dialog and the Windows printer dialog appear in
the intended order. Automated compilation and package generation do not
verify rendered UI, printer output, or installation behavior.

### MSI icon and setup layout correction — 2026-11-09

The icon source is now a transparent page mark: white page, neon-red outline,
and a red lightning bolt, with no tile, glow, shadow, or badge. Tauri's local
icon command regenerated the Windows ICO and related icon sizes. The browser
favicon uses the same no-background design.

The user-provided installer screenshots showed the custom dark welcome/finish
bitmap making WiX's native black text unreadable, and the custom banner label
overlapping page headings. Both bitmap overrides were removed. The MSI now
uses WiX's standard page layout; its product icon still points to
`icons/icon.ico` through `ProductIcon` / `ARPPRODUCTICON`.

The local MSI was rebuilt with `pnpm release:msi` (exit 0, using the installed
pnpm 12.14.0 and the same process-local workaround described above). The
generated WiX source has the product ICO entry and no custom banner/dialog
bitmap references. The MSI is
`target/release/bundle/msi/LitheXPDF_0.1.0_x64_en-US.msi` (8,298,496 bytes;
SHA-256 `4C323371204EF24972B616B5EA808A1AD521C1CADA54FF1407DA13A1FE81D2D8`).
The source ICO and packaged ICO SHA-256 values match. The new MSI was not
installed in this pass, so its screens still need user visual confirmation.
No tests were run.

### LitheXPDF 0.1.1 x64 MSI rebuild — 2026-11-09

The updated release notes are in `docs/RELEASE_NOTES_0.1.1.md`. The local
release build was run with `pnpm release:msi` and completed with exit code 0.
The Windows x64 worker build and staging, frontend typecheck/production build,
host release build, and WiX MSI packaging all completed successfully. The
resulting MSI is `target/release/bundle/msi/LitheXPDF_0.1.1_x64_en-US.msi`
(8,486,912 bytes; SHA-256
`C941C27006EBE3DAE2BE424F43BCB3D39D32D293CDCE4B158E1543EE60EC7550`). Its
Authenticode status is `NotSigned`.

`git diff --check` completed with exit code 0 and emitted the repository's
configured LF-to-CRLF warnings. The MSI was not installed or tested in this
pass, no test suites were run, and no release was published. Clean-machine
installation/uninstallation, PDF association behavior, printing, and visual
comparison of the new Quality rendering setting remain manual checks.

### Render-density quality option — 2026-11-09

The reader now defaults to a persisted Quality preference that requests up to
2× the prior WebView display-density dimensions. Options includes a checkbox
to disable the multiplier for Speed. Changing the preference clears other
cached page images and rerenders the current page; the existing worker limits
on bitmap dimensions, pixel count, RGBA memory, and encoded PNG size remain in
force. Quality may increase render time and reduce how many pages fit in the
existing image-cache byte limits. This change has not yet been visually
compared with SumatraPDF, and no performance or memory improvement is claimed.

`pnpm build` is the required frontend verification for this change. No Rust
renderer code or protocol was changed. Manual verification should compare the
same text-heavy PDF at 100%, 150%, and 200% in Quality and Speed modes and
check that changing modes rerenders the current page without showing a stale
image. Installer behavior and packaged rendering remain unverified.

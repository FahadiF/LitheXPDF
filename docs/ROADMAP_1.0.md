# Roadmap to 1.0.0

## Starting point

The public `v0.1.0` release is a Windows x64 preview. It is not a supported
stable build. The reader already has continuous scrolling, metadata-only
background tabs, one live PDFium document, search, bookmarks, themes, zoom,
rotation, page navigation, recent files, bounded preloading, and page-range
printing. Annotations, measured rendering policy, x86 packaging, signing, and
clean-install validation remain incomplete.

The local checkout is on `main` at `affb48b`, tracking `origin/main`, with
pre-existing modifications and untracked files. The restricted initial shell
could not inspect Git state, but a permitted read-only status check succeeded.
Preserve the dirty working tree; this implementation did not stage or commit
anything.

## Milestones and release gates

### A. Repository, dependency, and CI baseline

- Keep the x64 Windows CI workflow as a required quality signal. It runs frozen
  pnpm installation, typecheck, frontend tests/build, Rust formatting/checks/
  tests, and creates an unsigned MSI candidate with a SHA-256 sidecar. It never
  publishes or signs artifacts.
- Resolve the public `glib` advisory from dependency update logs and a complete
  Rust dependency audit. The current lockfile brings glib through GTK/WebKit
  packages used on Linux; this does not put glib in the Windows runtime, but
  the repository-wide advisory remains open until the graph is safely updated
  or independently assessed. Do not suppress the alert to make CI green.
- Keep the preview source/runtime notices and licensing records together.
  Refresh the README, this roadmap, `docs/TESTING.md`, and `SECURITY.md` from
  current evidence rather than treating old dated notes as current status.

**Acceptance:** CI passes on main and pull requests; `pnpm audit` and
`cargo audit` results are recorded and each finding is fixed or explicitly
accepted with reachability evidence before stable release.

### B. Stabilize the reader in the Windows desktop app

- Test the current checkout, not an earlier development run: open short,
  long, mixed-size, corrupt, scanned, and text PDFs; exercise page jump,
  scrolling, bookmarks, search, themes, rotation, menu/recent actions, tab
  switching, and shutdown.
- Verify active-tab restoration and stale-result rejection across 30–50 tab
  switches while maintaining the one-worker/one-live-document design.
- Test current-page, all-pages, and page-range printing through the custom
  LitheXPDF selector and native printer settings. Use Microsoft Print to PDF
  and verify output page counts.
- Fix only reproduced failures and add regression tests for each defect.

**Acceptance:** all workflows pass in a real Tauri/WebView2 window with no
stale document images, stuck loading state, orphan worker, or incorrect print
range. Record which user workflows were manual.

### C. Choose the rendering default from measurements

- Compare the current bounded rolling cache with bounded eager full-document
  rendering on short, 115-page, mixed-dimension, and 1,000-page PDFs.
- Measure per-page cold/warm latency and CPU, plus host/WebView2/worker memory,
  encoded image cache, estimated/observed decoded image storage, and peak
  renderer bitmap/IPC allocations. Record machine, Windows build, app/runtime
  versions, and fixture hashes.
- Keep existing per-render and rolling-cache hard limits during the study.
  Only select eager rendering if measurements show it fits a documented total
  memory target without starving foreground rendering. Otherwise tune the
  bounded policy. Do not promise zero wait or memory savings without evidence.

**Acceptance:** repeatable measurements for both modes, a chosen default with
tradeoffs documented in Options and the memory policy, and tests that enforce
cache bounds and URL cleanup.

### D. Add PDF annotations

- Add highlight, text-note, and freehand tools. Convert pointer/selection
  geometry into PDF page coordinates so zoom and quarter-turn rotation do not
  change placement.
- Keep every PDFium annotation and save operation in the worker. Extend the
  bounded binary host-worker protocol and version it consistently.
- Add an explicit Save Annotated Copy action. Never overwrite the source PDF
  by default; write through a temporary output and atomically finalize it.
- A one-page Windows integration probe now creates, saves, and reloads one
  highlight, text note, and ink annotation with the selected PDFium DLL and
  `pdfium-render` binding. Extend it to multi-page output, source-preservation,
  coordinate and rotation cases before enabling the feature in the UI. This
  API probe does not establish broad PDFium compatibility.

**Acceptance:** tests verify every annotation type, page/rotation coordinates,
multi-page output, failed-save cleanup, unchanged source bytes, and reopening
the output in LitheXPDF and a second PDF reader.

### E. Add x86 and x64 Windows distributions

- Build separate target stacks for `x86_64-pc-windows-msvc` and
  `i686-pc-windows-msvc`, each with a matching host, target-triple worker,
  PDFium DLL, notices, and explicit Tauri resource mapping.
- A candidate exists for PDFium 157.0.8086.0 x86 from the
  `bblanchon/pdfium-binaries` `chromium/8086` release. Its published archive
  SHA-256 is `4958b594e9709df44b8d69af3f90e62be54e335785c469217a2d364e6f141a54`.
  This is not yet a selected runtime: retrieve it in an online environment,
  verify the archive and extracted DLL hashes, inspect notices/dependencies,
  and run the worker load/open/render/close tests before packaging it.
- Produce two MSI files, named and labeled by architecture. Do not combine
  incompatible native binaries into one MSI. Extend CI only after the x86
  resource and runner prerequisites exist.

**Acceptance:** clean 32-bit Windows install and smoke test for x86, clean
64-bit Windows install and smoke test for x64, verified hashes/notices, correct
sidecar/DLL resource resolution, and install/launch/print/uninstall checks.
If the x86 runtime fails compatibility, x86 remains a release blocker; do not
substitute an unverified DLL.

### F. Sign and qualify 1.0.0

- Obtain a trusted code-signing certificate. Keep private keys and credentials
  outside the repository and in protected signing infrastructure. Sign the
  host, worker, and both MSI files; timestamp and verify signatures before
  computing final published hashes.
- Signing does not guarantee no SmartScreen prompt for a new app or publisher.
  State this accurately in release information.
- Update README, release notes, support policy, PDFium notices, and both
  architecture-specific installer names. Publish only after all prior gates
  pass; do not have CI publish automatically.

**Acceptance:** signed artifacts install and run on clean test machines for
both architectures; PDF open/render/search/annotate/print and update/uninstall
checks pass; release asset digests match; documentation and support status
match the tested build.

## Verification commands

```powershell
pnpm install --frozen-lockfile
pnpm audit
pnpm typecheck
pnpm test
pnpm build
cargo fmt --all -- --check
cargo check --workspace --all-targets
cargo test --workspace
pnpm release:msi
git diff --check
```

Run target-specific build and package commands separately for x64 and x86.
Do not commit, push, sign, publish, or release from the automated CI workflow.

# Testing and milestone plan

The Milestone 0 scaffold is in progress. No reader features or PDFium runtime
integration have been implemented. Each milestone adds a concrete verification
gate before expanding scope.

The root workspace, minimal Tauri host, explicit worker placeholder, vanilla
TypeScript shell, and frontend configuration are scaffolded. In the current
PowerShell session, Rust stable is active (`stable-x86_64-pc-windows-msvc`,
`rustc`/`cargo` 1.99.0), and `cargo check`, `cargo test`, and the Windows worker
release build pass after adding the application icon. `pnpm` 11.25.0 and the
local Tauri CLI are available in this session. A separate earlier Tauri
development launch failed because `pnpm` was not found in that launch process's
`PATH`; rerun the launch from an environment that exposes pnpm. No PDFium
binary has been selected or bundled. See the historical environment snapshot
and current verification record below.

## Milestone 0 — environment and compatibility (current scope)

Complete the environment and compatibility gate. Install stable Rust with the
MSVC target; run Cargo metadata/checks for the scaffold; build and stage the
x64 MSVC sidecar; then verify absolute Tauri resource loading and the
open/render/close compatibility smoke test. Pin the exact `pdfium-render`
crate version, API binding feature, and matching PDFium Windows x64 revision.
Verify binary archive hashes, redistribution notices, resource location,
sidecar target-triple naming, and packaged launch on a clean Windows
environment. The Rust workspace checks and worker build pass, but PDFium
compatibility, runtime loading/rendering, and release packaging remain
unverified. Do not implement reader features in this milestone.

**Test:** clean-machine launch/open/full-page-render/close smoke test; CI build
of the Windows x64 executable and chosen installer. Record `rustc -Vv`, Tauri
CLI and crate versions, PDFium API feature, DLL file version and SHA-256,
worker/sidecar hash, binary archive hash, resolved absolute DLL path, and
license artifacts. Inspect native dependencies of the worker and PDFium DLL,
including the MSVC runtime, and verify the chosen redistributable/install
strategy on a clean VM. Verify the Tauri raw `Response` arrives as an
`ArrayBuffer` in WebView2 at the configured encoded payload limit. Exercise
malformed/oversized IPC frames and verify rejection occurs before payload
allocation.

The workspace layout is fixed for these commands: repository-root
`Cargo.toml` has `[workspace]`, `resolver = "2"`, and members `"src-tauri"`
and `"crates/pdfium-worker"`; there is no nested workspace. Run all Cargo
commands below from the repository root. The root `package.json` owns
TypeScript scripts and the Tauri CLI, and `src-tauri/tauri.conf.json` is the
Tauri configuration discovered by the root Tauri CLI scripts.

For the Windows x64 packaging gate, build from the root with
`cargo build --release --target x86_64-pc-windows-msvc -p pdfium-worker` and
stage `target/x86_64-pc-windows-msvc/release/pdfium-worker.exe` as
`src-tauri/binaries/pdfium-worker-x86_64-pc-windows-msvc.exe`. Its
`src-tauri/tauri.conf.json` entry is
`bundle.externalBin: ["binaries/pdfium-worker"]`; Rust launches it with
`ShellExt::sidecar("pdfium-worker")`. Bundle
`src-tauri/resources/pdfium/pdfium.dll` as `pdfium/pdfium.dll` and
`src-tauri/resources/pdfium/THIRD_PARTY_NOTICES.txt` as
`pdfium/THIRD_PARTY_NOTICES.txt`; resolve the DLL through
`BaseDirectory::Resource`, then pass the worker the resulting absolute path.
Do not select a DLL until its API compatibility, hash, redistribution terms,
and clean-machine load are verified.

For the current scaffold only, `tauri.conf.json` intentionally omits
`bundle.resources` because no verified PDFium DLL or redistribution notices
are present. This omission lets Cargo workspace checks run without fabricating
compatibility artifacts; it does not satisfy release packaging. Restore both
exact mappings above with the verified files before building any distributable
package. Treat package/release acceptance as blocked until that gate passes.

The host/worker link is the version-1, 20-byte-header `PDFW` length-prefixed
binary protocol over raw sidecar stdin/stdout. The WebView image response is
the same bounded binary envelope returned as `tauri::ipc::Response` and
received by `invoke()` as an `ArrayBuffer`. Do not substitute JSON/base64 or
large JSON events. Verify both directions at the 32 MiB encoded-image limit,
all frame boundaries, malformed/version failures, and pre-allocation length
rejection.

**Acceptance:** Cargo check, frontend type check, Tauri dev launch, bounded
full-page render of a known fixture, and packaged install/launch all succeed.
The exact crate/API/DLL tuple and SHA-256 hashes are recorded and pinned.
Missing DLL, version mismatch, malformed IPC, or unsupported architecture
produces a useful error rather than an unbounded allocation or crash. The
selected license notices ship with the package. This milestone produces no
memory-improvement claim.

### Scaffold execution record — 2026-10-12

Implemented the repository-root Cargo workspace, Tauri host bootstrap, shell
plugin registration, capability/configuration, separate non-rendering worker
placeholder, vanilla frontend, pnpm scripts, Vite/Vitest configuration, and
Windows sidecar staging script. The root workspace and Tauri config files
exist. The 2026-10-12 environment snapshot below recorded that Cargo was not
available then; the active Rust toolchain is now installed and verified.
`Cargo.lock` exists and the target-triple Windows sidecar is staged; no PDFium
DLL or redistribution notices have been selected or added.

Executed checks and results:

- `pnpm install --lockfile-only --ignore-scripts` — completed and generated
  `pnpm-lock.yaml`; registry requests emitted transient `EACCES` warnings
  during metadata resolution.
- `pnpm install --frozen-lockfile` — first stopped at pnpm's ignored-build
  guard for `esbuild`. Added a project allowlist for `esbuild` only, then reran
  successfully; 64 packages were installed.
- `pnpm typecheck` — passed (`tsc --noEmit`).
- `pnpm test` — passed; 1 frontend scaffold test.
- `pnpm build` — passed; TypeScript check and Vite production bundle completed.
- `pnpm tauri --version` — passed; local `tauri-cli 2.12.2`.
- `pnpm tauri info` — reported WebView2 `154.0.4258.62`, Visual Studio Build
  Tools 2026, Node `26.5.1`, pnpm `11.25.0`, and no `rustc`, Cargo, or rustup.
- `node --check scripts/stage-worker-windows.mjs` — passed.
- Parsed `package.json` and `src-tauri/tauri.conf.json` with Node — passed.
- `git diff --check` — passed with no whitespace errors.

Follow-up scaffold resource check (2026-10-12): removed the missing PDFium
entries from active `bundle.resources` while retaining the Windows sidecar
configuration; the exact future mappings and release block are documented
above. JSON parsing of `tauri.conf.json` passed, and the staged sidecar exists.
`cargo check --workspace --all-targets` and `cargo test --workspace` were each
attempted; both could not start because `cargo` is not installed or available
on `PATH` (PowerShell reported that `cargo` is not recognized). A fresh
`git diff --check` passed with exit code 0; Git printed only LF-to-CRLF
normalization warnings for existing changed text files.

The 2026-10-12 Cargo check/test attempts could not start because Cargo was
unavailable at that time. The exact PDFium crate/API/DLL tuple, hashes, notices,
and native runtime dependencies remain an explicit blocked compatibility gate.

### Windows icon and Rust verification — 2026-10-18

The pre-fix host build and workspace test logs reached `tauri-build` and failed
because `src-tauri/icons/icon.ico` was missing. A separate earlier `pnpm tauri
dev` launch failed because `pnpm` was not found in that launch process's
`PATH`. Added an original `src-tauri/icons/lithexpdf.svg`, generated assets
with `pnpm exec tauri icon src-tauri/icons/lithexpdf.svg --output
src-tauri/icons`, and configured the generated PNG, ICNS, and ICO files in
`bundle.icon`. The generated ICO passed structural validation (ICO header,
six image entries, and in-file image bounds).

Current PowerShell toolchain: `rustup show active-toolchain` reports
`stable-x86_64-pc-windows-msvc`; `rustc --version` is 1.99.0,
`cargo --version` is 1.99.0, and `pnpm --version` is 11.25.0. The staged worker
retains the target-triple name
`src-tauri/binaries/pdfium-worker-x86_64-pc-windows-msvc.exe`.

Commands run from the repository root on 2026-10-18:

- `cargo check --workspace --all-targets` — exit 0; Tauri host and workspace
  targets checked successfully.
- `cargo test --workspace` — exit 0; all targets and doc tests completed, with
  zero Rust tests currently defined.
- `cargo build --release --target x86_64-pc-windows-msvc -p pdfium-worker` —
  exit 0; optimized Windows x64 worker build completed. The staging script
  copied it to the existing target-triple sidecar path.
- `git diff --check` — exit 0; Git emitted only LF-to-CRLF normalization
  warnings for changed text files.

The prior missing-icon build failures are resolved by the generated icon.
The earlier Tauri development launch has not been rerun; the current session
does expose pnpm. PDFium loading/rendering and distributable release packaging
remain unverified, and no memory improvement is claimed.

### Milestone 0 rerun and PDFium research — 2026-10-18

The stale statements above about current Rust availability and an unrerun Tauri
launch are historical to the earlier 2026-10-18 icon pass. In this rerun,
`rustup show active-toolchain` reported `stable-x86_64-pc-windows-msvc`,
`rustc --version` reported 1.99.0, `cargo --version` reported 1.99.0, and
`pnpm --version` reported 11.25.0. The commands below ran from the repository
root:

- `pnpm --version` — exit 0; `11.25.0`.
- `pnpm install --frozen-lockfile` — exit 0; lockfile already up to date.
- `pnpm typecheck` — exit 0 (`tsc --noEmit`).
- `pnpm test` — exit 0; 1 frontend scaffold test passed. This is not reader
  feature coverage.
- `pnpm build` — exit 0; TypeScript check and Vite production build passed.
- `cargo check --workspace --all-targets` — exit 0.
- `cargo test --workspace` — exit 0; 0 Rust tests are defined across host,
  worker, and doc tests.
- `cargo build --release --target x86_64-pc-windows-msvc -p pdfium-worker` —
  exit 0.
- `node scripts/stage-worker-windows.mjs` — exit 0; staged
  `src-tauri/binaries/pdfium-worker-x86_64-pc-windows-msvc.exe`.
- `git diff --check` — exit 0 after the final edits; see the verification
  record at the end of this section.

#### Tauri development launch

The first `pnpm tauri dev` attempt exited 1 before opening a window. Vite
started, then Node failed with `EBUSY` while watching Cargo's concurrently
written `target/debug/deps/lithexpdf_host.exe`; `vite.config.ts` ignored
`src-tauri` but not Cargo's `target` tree. Added `**/target/**` to Vite's
watcher exclusions and reran `pnpm build` successfully. The next launch reached
`Running target/debug/lithexpdf-host.exe`. During the live run, the host process
had a responsive native window titled `LitheXPDF` with a nonzero window handle;
the Vite page returned HTTP 200 with `<title>LitheXPDF</title>`, and
`/src/main.ts` returned HTTP 200. The host process and Vite listener were both
absent after shutdown. Ctrl+C stopped the dev command; Windows emitted a
Chromium window-class unregister warning (`Error 1411`) while handling the
interrupt, then the host reported `STATUS_CONTROL_C_EXIT`. This did not prevent
startup or leave the process/port running.

#### PDFium distribution candidates

**Repository selection status:** neither `Cargo.toml` nor `Cargo.lock` contains
`pdfium-render` or `pdfium-sys`. There is no crate version or feature set
selected in this checkout. ADR 0001's 0.9.4 / `pdfium_7881` pairing is a
research baseline only. Current upstream `pdfium-render` 0.9.4 documentation
states that its default features are `pdfium_latest`, `image_latest`, and
`thread_safe`; `pdfium_latest` currently selects API binding `pdfium_7881`.
This describes the documented candidate configuration, not the compiled
LitheXPDF dependency graph.

| Candidate | Exact build and Windows artifact | Binding assessment | Integrity evidence |
| --- | --- | --- | --- |
| Direct `bblanchon/pdfium-binaries` release | PDFium `151.0.7881.0`, tag `chromium/7881`, upstream PDFium commit `867b3ec`; artifact `pdfium-win-x64.tgz`, containing `bin/pdfium.dll` (`pdfium.dll`). [Release](https://github.com/bblanchon/pdfium-binaries/releases/tag/chromium%2F7881) | Exact API-number match for the *proposed* `pdfium-render 0.9.4` default `pdfium_7881` binding. It still needs a real load/render test; API-number alignment alone does not prove ABI/runtime compatibility. | The inspected release page did not expose a per-asset SHA-256. The archive was not downloaded, so no local hash exists. Compute and pin its SHA-256 before use. |
| `pypdfium2` Windows wheel | Release `5.13.0` (tag commit `a465910`); release record pins PDFium build `7999` (`chromium/7999`). Artifact `pypdfium2-5.13.0-py3-none-win_amd64.whl`; its PDFium payload is named `pdfium.dll` in the `pypdfium2_raw` package area (verify exact wheel path before extraction). [Release](https://github.com/pypdfium2-team/pypdfium2/releases/tag/5.13.0), [release record](https://raw.githubusercontent.com/pypdfium2-team/pypdfium2/5.13.0/autorelease/record.json), [PyPI file](https://pypi.org/project/pypdfium2/5.13.0/) | Windows x86-64 wheel is published, but its PDFium build 7999 is not the proposed 7881 binding revision. pypdfium2's generated Python bindings do not establish `pdfium-render` compatibility. Treat compatibility as unknown until the Rust binding and native API are tested together. | PyPI publishes SHA-256 `47dcca2a8d507b5fd24f94c3c9d48fb379430f097bc20f01beff6c963ffbcedb` for the **whole wheel**, not its extracted DLL. No download or DLL hash was made. |
| Firecrawl repackaged native release | Release `native-v7988`, PDFium `153.0.7988.0`, upstream tag `chromium/7988`; Windows x64 asset `firecrawl-pdfium-win-x64.tgz` (3,764,191 bytes); packaged upstream layout includes `bin/pdfium.dll`. [Release](https://github.com/firecrawl/pdfium-rs/releases/tag/native-v7988) | The upstream build number differs from proposed binding `pdfium_7881`; the release belongs to the `firecrawl-pdfium` wrapper and does not document `pdfium-render` compatibility. Runtime API compatibility is unverified. | The release lists upstream `pdfium-win-x64.tgz` SHA-256 `654daf488d9357d2787cec439d0dbdb93d7e180e2cb28e5f1d41c66d2645daec`, verified by the publisher at repack time. This is **not** the repackaged asset hash or a local hash. The publisher says its release includes `SHA256SUMS` and GitHub attestations; verify those against the downloaded repack before use. No asset was downloaded. |

**License and native-runtime review for these candidates:** PDFium's upstream
license and the licenses/notices for third-party components linked into that
exact build must accompany redistribution. The `pdfium-binaries` repository's
MIT license covers its distribution project and does not replace the PDFium
build's notices. pypdfium2 documents its own Apache-2.0/BSD-3-Clause licensing
and says wheel distributions carry PDFium and dependency license material;
that must be checked against the selected wheel's actual files. Firecrawl's
release says the archive carries upstream `LICENSE` and `licenses/` material,
and its repository publishes a third-party notices file; inspect the actual
release archive and notice inventory before redistribution. These statements
are publisher documentation, not a legal review. No artifact was downloaded,
so no candidate's actual archive contents or applicable notice set has been
inspected. No native dependency scan has been done for any DLL; inspect PE
imports and MSVC runtime dependencies, then verify on a clean Windows machine.

**Recommendation:** use the direct `chromium/7881` Windows x64 archive as the
first *smoke-test candidate* because its build number exactly matches the
documented `pdfium-render 0.9.4` default API binding, and it is a direct DLL
distribution rather than a Python wheel extraction. This is not a final binary
selection. Before loading it, download the immutable versioned artifact, record
its local SHA-256, inspect its `VERSION`/build flags and complete license
inventory, and inspect PE dependencies. Then add and pin `pdfium-render` in the
worker only, bind to the explicit DLL path, and run open/page-count/render/close
smoke tests. Keep `bundle.resources` omitted until those checks pass. The
pypdfium2 wheel is a provenance-rich alternative package, but its 7999 build,
wheel extraction, and `pdfium-render` ABI remain unverified; do not substitute
its wheel SHA for a DLL hash. Firecrawl's v7988 archive offers stronger
publisher-documented provenance and a pinned upstream archive hash, but its
repackaged asset hash must be independently checked and the API revision still
does not match the proposed `pdfium_7881` binding. It is a useful alternative
to compare during the same smoke-test gate, not evidence of compatibility.

**Smoke-test readiness:** none of the three candidates is ready to load today.
The direct 7881 release is the preferred first candidate after downloading it
in a later authorized compatibility task, recording the downloaded archive and
DLL hashes, auditing its real license/notice files and PE dependencies, and
pinning `pdfium-render` and its API feature in the worker. The firecrawl 7988
archive can serve as a comparison only if its actual release checksum and
attestation verify. Candidate assessment alone is insufficient to restore
`bundle.resources` or claim PDFium compatibility.

No PDFium artifact was downloaded. No exact crate version/features, DLL hash,
runtime dependency set, redistribution notice file, open/render/close result,
or release-package result is selected or verified. The target-triple sidecar,
`bundle.externalBin`, and omission of `bundle.resources` remain unchanged.

Final `git diff --check` after this record: exit 0.

### Worker-only PDFium integration — 2026-10-18

This section supersedes the earlier statement that no PDFium crate or runtime
had been selected. The Tauri host and frontend remain PDFium-free; only
`crates/pdfium-worker` now depends on the PDFium binding. The production
sidecar IPC loop and host resource handoff are still not implemented.

#### Candidate comparison and selected smoke runtime

`pdfium-render` 0.9.4 exposes API features through `pdfium_7881`; its default
`pdfium_latest` currently aliases that feature. The crate does not publish a
numbered 8086 binding. Rendering uses the explicit `image_025` feature, and
`thread_safe` remains enabled; defaults are disabled to avoid a floating API
alias. `image =0.25.10` is pinned directly with only its `png` feature for the
bounded diagnostic encoder. See the [0.9.4 crate features and binding
documentation](https://docs.rs/pdfium-render/0.9.4/pdfium_render/).

| Path | Official release evidence | Compatibility and decision |
| --- | --- | --- |
| Candidate A: exact binding-number match | PDFium `151.0.7881.0`, tag `chromium/7881`, release commit `867b3ec`; Windows x64 archive `pdfium-win-x64.tgz`, with `bin/pdfium.dll`. The official expanded release asset listing reports archive SHA-256 `73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08`. [Release](https://github.com/bblanchon/pdfium-binaries/releases/tag/chromium%2F7881) | Exact API-number match to `pdfium_7881`, but an older runtime branch. This archive was not downloaded locally, so its DLL hash and actual imports/notices were not inspected and it was not smoke-tested. |
| Candidate B: newer official release; selected for worker proof | PDFium `157.0.8086.0`, tag `chromium/8086`, release commit `5325fa6d0d9379329f10f98fdc4839b4e40f2e79`; Windows x64 archive `pdfium-win-x64.tgz`, with `bin/pdfium.dll`. [Release](https://github.com/bblanchon/pdfium-binaries/releases/tag/chromium%2F8086) | The crate exposes `pdfium_7881`, not `pdfium_8086`, so the newer release was treated as an unverified candidate until tested. Its GitHub release API digest matched the local archive SHA-256. The worker loaded the DLL with the `pdfium_7881` bindings, opened the fixture, read its page metadata, rendered PNG, and exited successfully. This verifies the tested call path, not every PDFium function or a packaged app. |

Candidate B was selected for this limited proof because it is the newer
official x64 release, while the crate's API binding lacks a matching 8086
feature. Candidate A remains the exact-version fallback if broader testing
finds a compatibility issue. The successful subprocess result is the needed
runtime evidence to proceed with this worker-only milestone; release support
still requires broader document testing and clean-machine packaged execution.

#### Selected artifact, licensing, and native imports

- Source URL:
  `https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F8086/pdfium-win-x64.tgz`
- Release/build: tag `chromium/8086`, PDFium `157.0.8086.0`, release commit
  `5325fa6d0d9379329f10f98fdc4839b4e40f2e79`; archive filename
  `pdfium-win-x64.tgz`, extracted DLL `bin/pdfium.dll`.
- Publisher SHA-256 from GitHub release API:
  `1fd8af952832dbb0eb16d9249f68fe09e5f5ebf7c3dd9f6066ea2720cc28487d`.
- Locally computed archive SHA-256:
  `1fd8af952832dbb0eb16d9249f68fe09e5f5ebf7c3dd9f6066ea2720cc28487d`
  (matches the publisher digest).
- Locally computed extracted DLL SHA-256:
  `1f2aee4286b8cf0413ab4562b7121aa454f9cfd9afd6ca8609bcef80927b3f80`.
- Archive `VERSION`: `MAJOR=157`, `MINOR=0`, `BUILD=8086`, `PATCH=0`.
  `args.gn` reports `target_cpu="x64"`, `target_os="win"`, standalone build,
  and V8/XFA disabled.
- The archive contains a top-level distribution `LICENSE` plus 17 files in
  `licenses/`, including `licenses/pdfium.txt` and dependency notices. The
  bundled `src-tauri/resources/pdfium/THIRD_PARTY_NOTICES.txt` contains those
  actual files verbatim, each under its archive-relative source filename.
  This includes the distributor's MIT terms, PDFium's BSD terms, and included
  dependency license texts; no legal opinion is implied. Primary license
  sources: [archive license](https://github.com/bblanchon/pdfium-binaries/blob/master/LICENSE)
  and [PDFium upstream license](https://github.com/chromium/pdfium/blob/main/LICENSE).
- `dumpbin /DEPENDENTS` on the extracted x64 DLL reported `KERNEL32.dll`,
  `ADVAPI32.dll`, `GDI32.dll`, and `USER32.dll`. No separate VC runtime DLL
  appeared in that import list. This local import inspection does not replace
  clean-machine execution.

#### Worker implementation and smoke evidence

The worker uses exact `pdfium-render =0.9.4` features `pdfium_7881`,
`image_025`, and `thread_safe`, with defaults off. It requires an explicit
absolute `--pdfium-path`, input path, and output path; it has no working-
directory or system-DLL fallback. The diagnostic runs on the worker process's
main OS thread, opens one PDF, reads page count/point dimensions, scales under
the documented 8,192-pixel dimension, 8,388,608-pixel, and 32 MiB RGBA caps,
and uses a 32 MiB bounded PNG writer. Page and document objects are dropped
before successful process exit.

`crates/pdfium-worker/tests/fixtures/smoke-one-page.pdf` is a local 507-byte
PDF with one page and a 200×120-point media box. `cargo test -p pdfium-worker
--all-targets` passed 10 tests: 5 worker unit tests for dimension/payload
bounds and 5 subprocess integration tests for missing/relative/invalid DLL
paths, valid open/render/close, output PNG dimensions, and corrupt-PDF failure.

Exact standalone smoke command, using explicit absolute paths:

```powershell
& 'E:\Projects\LithexPDF\target\debug\pdfium-worker.exe' --smoke-test `
  --pdfium-path 'E:\Projects\LithexPDF\src-tauri\resources\pdfium\pdfium.dll' `
  --input 'E:\Projects\LithexPDF\crates\pdfium-worker\tests\fixtures\smoke-one-page.pdf' `
  --output 'C:\Users\xexen\AppData\Local\Temp\lithexpdf-pdfium-audit\standalone-smoke-8086.png'
```

Result: exit **0**; `pages=1`, `page1_points=200.00x120.00`,
`render_px=200x120`, and `png_bytes=912`. The output PNG was opened and visually
inspected; it shows the fixture's blue rectangle on a white background.

The exact source-to-target Tauri mappings are now active:
`resources/pdfium/pdfium.dll` → `pdfium/pdfium.dll` and
`resources/pdfium/THIRD_PARTY_NOTICES.txt` →
`pdfium/THIRD_PARTY_NOTICES.txt`. The bundle has not been built, and the host
does not yet resolve the resource path or launch the worker. No claim is made
about Tauri packaged loading, installer execution, WebView rendering, or
memory/performance improvement.

#### Verification after integration

The first default-sandbox run of write-producing checks hit access-denied
errors in existing `dist/` and `target/` directories. The same checks were
rerun with repository access and passed. Current outcomes:

- `pnpm --version` — exit 0; `11.25.0`.
- `pnpm install --frozen-lockfile` — exit 0.
- `pnpm typecheck` — exit 0.
- `pnpm test` — exit 0; 1 frontend scaffold test passed, not reader coverage.
- `pnpm build` — exit 0.
- `cargo check --workspace --all-targets` — exit 0.
- `cargo test --workspace` — exit 0; worker contributes 10 tests, while host
  and host doc tests currently define 0 tests.
- `cargo build --release --target x86_64-pc-windows-msvc -p pdfium-worker` —
  exit 0.
- `node scripts/stage-worker-windows.mjs` — exit 0; target-triple sidecar
  staged at `src-tauri/binaries/pdfium-worker-x86_64-pc-windows-msvc.exe`.
- `git diff --check` — exit 0 after the final documentation edits.

Remaining gates: production binary IPC/supervisor and Tauri resource handoff;
clean Windows packaging/load; WebView2 raw binary response test; broader PDF
fixture coverage; and memory/latency measurements. The bounded PNG writer
caps encoded output, but encoder scratch and total peak process memory were
not measured. The worker-only smoke test does not implement a usable PDF
reader.

## Milestone 1 — worker lifecycle and protocol

Implement the bounded IPC, worker supervisor, one-thread PDFium owner, one
active document, tab metadata state machine, and explicit close/shutdown.

**Test:** Rust unit tests for legal/illegal state transitions, generation
increments, binary payload bounds, malformed frames, and message validation.
Integration tests race delayed renders against rapid document switches,
cancel queued renders and verify active native renders are not misreported as
preempted, and open one fixture, switch paths, close, and observe worker
acknowledgements. Inject worker exit and startup failure.
Assert the configurable 30,000 ms provisional render timeout is distinct from
the fixed 2,000 ms shutdown grace. Use a short test override to verify timeout
invalidation, asynchronous termination/reap, and restart without blocking GUI
dispatch.

**Acceptance:** no path allows two live documents/workers; document-switch
races never bind a result to the wrong document; queued cancellation prevents
dispatch while active cancellation reports completion/discard accurately;
stale generations are rejected; orderly close is acknowledged; a crashed
worker is terminated, reaped, and replaced once without losing background
metadata. Timeout, shutdown grace, and process-exit observation remain
separate; no GUI-thread timeout or child wait is permitted.

## Milestone 2 — bounded asynchronous rendering

Implement frontend request correlation, async Tauri commands/events, queue
coalescing, pixel limits, encoding, and stale-result disposal.

**Test:** protocol/unit tests for binary frame bounds, malformed and oversized
messages, including length boundaries immediately below, at, and above each
cap and a bounded image writer that discards partial output on overflow;
integration tests with delayed render responses across tab switch/close;
frontend tests for stale
result rejection, request correlation, image element/source cleanup, object
URL revocation, and encoded/decoded reference removal on deactivation.

**Acceptance:** the GUI and Tauri async runtime never invoke PDFium; maximum
request/cache/payload limits hold under bursts; stale images never display;
inactive tabs retain no encoded or decoded page image references; active
rendering eventually responds after the current native call completes.

## Milestone 3 — recovery and adversarial documents

Add timeout/restart behavior and recovery from invalid files, file deletion,
worker crash, and malformed IPC.

**Test:** integration suite with corrupt/large/image-heavy fixtures, worker
termination during idle and render, restart and reopen of only the selected
tab, malformed IPC termination, and repeated open/close cycles. Verify timeout
tuning using dispatch-to-result p50/p95/p99/max, open/render/encode/IPC splits,
and false-timeout/restart counts across the hashed corpus and supported
hardware. Confirm the old child is reaped before restart. Measure private
bytes and working set in the parent, worker, and WebView.

**Acceptance:** the parent remains responsive after worker failure, no stale
result displays, restart attempts are bounded, and failure is surfaced with a
retry/close path. Measurements are reported; no memory claim is made without
the recorded baseline and comparison.

## Milestone 4 — 30+ tab and packaging validation

Exercise 1, 10, 30, and 50 metadata tabs with repeated activation and page
navigation; package and install on supported Windows versions.

**Test:** repeatedly switch through 30 and 50 metadata tabs while rendering a
fixed, hashed PDF corpus; repeat at 1 and 10 tabs. Assert one worker/document,
zero encoded/decoded page images on every inactive tab, stale-result rejection,
bounded cancellation, and correct worker restart. Capture memory/latency
benchmarks. Smoke test the installer on a clean Windows x64 VM and a machine
without WebView2.

**Acceptance:** background tabs retain metadata only; only one PDFium document
is resident; explicit memory caps are respected; publish measured cold-start,
switch latency, private bytes, working set, and installer size with hardware,
OS, and corpus context.

## Baseline commands (after Milestone 0 setup)

```powershell
cargo check --workspace --all-targets
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
cargo test --workspace
cargo build --release --target x86_64-pc-windows-msvc -p pdfium-worker
pnpm worker:stage:windows
pnpm tauri:build
```

These commands assume the single repository-root Cargo workspace and root
package scripts described above. Sidecar staging follows its Cargo build and
precedes `pnpm tauri:build`. Current Cargo checks, workspace tests, and the
Windows worker release build pass. An earlier Tauri development launch failed
because pnpm was not found in that launch process's `PATH`; pnpm is available
in the current PowerShell session. The sidecar is staged, but verified PDFium
resources are absent. PDFium loading/rendering and release packaging remain
unverified; listing commands does not claim otherwise.


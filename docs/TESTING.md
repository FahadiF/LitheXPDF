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


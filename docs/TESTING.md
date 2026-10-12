# Testing and milestone plan

No implementation or tests have been run yet. Each milestone adds a concrete
verification gate before expanding scope.

The Milestone 0 environment inventory has started. It is currently blocked
before compilation because `rustup`, `rustc`, `cargo`, and the Tauri CLI are
not installed or available on `PATH`, and the official rustup bootstrap
download was blocked by the environment's socket/network restrictions; see the
snapshot in `README.md`.

## Milestone 0 — environment and compatibility (current scope)

Install stable Rust with the MSVC target and Tauri CLI. Establish the workspace
and a separate `crates/pdfium-worker` binary target, plus the minimal Tauri 2
host and vanilla TypeScript shell. Configure and build the x64 MSVC sidecar,
load the PDFium DLL by an absolute Tauri resource path, and do only the
open/render/close compatibility smoke test. Pin the exact `pdfium-render`
crate version, API binding feature, and matching PDFium Windows x64 revision.
Verify binary archive hashes, redistribution notices, resource location,
sidecar target-triple naming, and packaged launch on a clean Windows
environment. Do not implement tabs/UI features beyond the smoke harness.

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

**Acceptance:** Cargo check, frontend type check, Tauri dev launch, bounded
full-page render of a known fixture, and packaged install/launch all succeed.
The exact crate/API/DLL tuple and SHA-256 hashes are recorded and pinned.
Missing DLL, version mismatch, malformed IPC, or unsupported architecture
produces a useful error rather than an unbounded allocation or crash. The
selected license notices ship with the package. This milestone produces no
memory-improvement claim.

## Milestone 1 — worker lifecycle and protocol

Implement the bounded IPC, worker supervisor, one-thread PDFium owner, one
active document, tab metadata state machine, and explicit close/shutdown.

**Test:** Rust unit tests for legal/illegal state transitions, generation
increments, binary payload bounds, malformed frames, and message validation.
Integration tests race delayed renders against rapid document switches,
cancel queued renders and verify active native renders are not misreported as
preempted, and open one fixture, switch paths, close, and observe worker
acknowledgements. Inject worker exit and startup failure.

**Acceptance:** no path allows two live documents/workers; document-switch
races never bind a result to the wrong document; queued cancellation prevents
dispatch while active cancellation reports completion/discard accurately;
stale generations are rejected; orderly close is acknowledged; a crashed
worker is terminated, reaped, and replaced once without losing background
metadata.

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
tab, malformed IPC termination, and repeated open/close cycles. Confirm the
old child is reaped before restart. Measure private bytes and working set in
the parent, worker, and WebView.

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
pnpm tauri build
```

The exact scripts depend on the scaffold created in Milestone 0. These commands
are a target checklist, not runnable commands in the current empty repository.


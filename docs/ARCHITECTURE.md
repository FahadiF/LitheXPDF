# Architecture

## Boundaries

```text
Vanilla TS UI
    │ async Tauri commands; metadata JSON + raw binary image response
    ▼
Rust Tauri host / supervisor
    │ bounded, versioned binary IPC over sidecar stdio
    ▼
One PDFium worker child process
    └── one OS thread owns PDFium initialization, one document, pages,
        bitmaps, and all PDFium calls
```

The frontend has no PDFium bindings and cannot create native document handles.
The host owns tab metadata, active-tab selection, request admission, queue
limits, and worker lifetime. The child owns all PDFium objects and native
rendering. There is at most one worker and one open PDFium document in the
initial architecture. Only the active tab may occupy that document slot.

PDFium's upstream documentation does not promise thread safety. `pdfium-render`
documents that it serializes PDFium calls behind a mutex when its default
`thread_safe` feature is enabled, but that is a guard, not a reason to call
PDFium concurrently. Keep every PDFium call on the worker's single owner
thread. The binary process boundary adds recovery from native crashes and
allows the OS to reclaim the worker's address space on termination. It does
not make ordinary document close a guarantee that Windows immediately lowers
the process working set.

## Worker binary and Windows packaging

The repository-root Cargo workspace contains both the host package at
`src-tauri` and worker package at `crates/pdfium-worker`, with
`resolver = "2"`. The worker is a separate binary target, not a thread, Tauri
command, or second WebView. The
host package does not link `pdfium-render`. Build the worker for
`x86_64-pc-windows-msvc`, then stage it as
`src-tauri/binaries/pdfium-worker-x86_64-pc-windows-msvc.exe`. Configure
`src-tauri/tauri.conf.json` with
`bundle.externalBin: ["binaries/pdfium-worker"]`. Tauri requires the
target-triple-suffixed file and bundles it as a sidecar. Launch it from Rust
through the registered `tauri-plugin-shell` `ShellExt::sidecar("pdfium-worker")`
API; `sidecar()` takes the basename, while `externalBin` includes
`binaries/pdfium-worker`. Configure raw output (`set_raw_out(true)`) so stdout
is delivered as bytes rather than line-delimited text. Do not ask the frontend
to launch the process and do not rely on the process working directory. Keep
shell-plugin spawn permission out of the frontend capability unless a future
reviewed design needs it. The plugin's child stdin writes are synchronous, so
perform them on a dedicated I/O task/thread, never a GUI callback. Drain raw
stdout/stderr continuously and parse arbitrary stdout chunks with the frame
decoder; do not use the plugin's whole-output collection method for this
persistent binary stream.

From the repository root, build the worker with
`cargo build --release --target x86_64-pc-windows-msvc -p pdfium-worker`.
The artifact is `target/x86_64-pc-windows-msvc/release/pdfium-worker.exe`;
stage it as
`src-tauri/binaries/pdfium-worker-x86_64-pc-windows-msvc.exe` before the Tauri
package step. This is the only initially supported Windows package target.

Bundle the pinned `pdfium.dll` and its redistribution notices from
`src-tauri/resources/pdfium/` as Tauri resources. The host resolves
`pdfium/pdfium.dll` from Tauri's `BaseDirectory::Resource`, converts it to an
absolute path, and passes that path to the worker at launch. Configure
`bundle.resources` with an explicit source-to-target map, for example
`resources/pdfium/pdfium.dll` → `pdfium/pdfium.dll` and the notices file →
`pdfium/THIRD_PARTY_NOTICES.txt`; do not depend on implicit flattening. In
development, resolve the same source file from a compile-time manifest path,
not the current working directory. Pass the resolved path as a distinct
`--pdfium-path <absolute-path>` argument; do not concatenate or re-quote the
path into a shell command string.
The worker calls `Pdfium::bind_to_library(absolute_path)`; it must not use
`Pdfium::default()`, search the current working directory, or silently fall
back to a system DLL. Missing or mismatched DLLs fail startup with a reported
error. Test the resolved paths in both development and packaged installs.
The canonical mapping is
`src-tauri/resources/pdfium/pdfium.dll` → `pdfium/pdfium.dll` and
`src-tauri/resources/pdfium/THIRD_PARTY_NOTICES.txt` →
`pdfium/THIRD_PARTY_NOTICES.txt`. These are required locations, not evidence
that a compatible DLL has been selected or that packaged loading has passed.

**Scaffold packaging exception:** while no verified PDFium distribution has
been selected, the active `src-tauri/tauri.conf.json` intentionally omits
`bundle.resources`, so development workspace checks do not require or package
missing/unverified native artifacts. The Windows worker sidecar configuration
remains active. This configuration is not release-ready: before any release
package is built, restore the exact source-to-target mappings above and add
the verified DLL and its real redistribution notices. Release acceptance is
blocked until the compatibility, hash, licensing, and clean-machine packaging
gates pass. Do not add placeholder files to satisfy the scaffold build.

## Binary IPC framing

Host/worker transport is a duplex byte stream on the sidecar's stdin/stdout;
stderr is diagnostics only. Use length-prefixed frames, never line-delimited
JSON. The host sends only one command at a time; its bounded queue holds at
most two pending requests without writing them to the pipe. This makes queued
cancellation local and keeps kernel pipe buffers from becoming an unbounded
work queue. Each frame has a 20-byte header: 4-byte ASCII magic `PDFW`, 2-byte
protocol version (unsigned big-endian, initially `1`), 2-byte message kind,
8-byte request ID, and 4-byte payload length (unsigned big-endian), followed by
exactly that many payload bytes. Stream reads may split or combine frames;
the receiver must reassemble by length. Control/request payloads are capped at
64 KiB. A render-result payload has fixed binary metadata followed by encoded
image bytes and may not exceed 32 MiB + 4 KiB. The 32 MiB image-byte cap is
independent of the frame header.

Before allocating payload storage, validate magic, version, kind-specific
length cap, and overflow-safe total length. Require exact fixed-field lengths,
valid enum values, finite zoom, valid dimensions, and no trailing bytes in
fixed-size messages. Reject unsupported versions, malformed/truncated frames,
unknown kinds, duplicate or impossible request IDs, and over-limit payloads;
do not attempt to resynchronize an invalid stream. Return a small protocol
error where possible, then shut down/reap and replace the worker on a framing
violation. The worker must apply the same checks to host requests.

The binary image result from a Tauri command is a raw IPC response:
`tauri::ipc::Response::new(Vec<u8>)`. The raw response contains the versioned
render-result envelope and image bytes; `@tauri-apps/api/core` `invoke()`
resolves it to an `ArrayBuffer`. TypeScript parses the bounded header and
validates tab ID, generation, request ID, dimensions, and payload length. Use
small JSON Tauri events only for status/metadata. Never send image bytes in
JSON events or JSON arrays. If the raw response path fails a WebView2 smoke
test at the payload cap, stop and evaluate another verified binary transport
before feature work.

## Tab lifecycle

Each tab stores only a stable `tab_id`, canonical document path, current page
index, zoom, scroll position, and a monotonically increasing generation. Tab
metadata does not retain PDFium documents, page objects, or rendered pages.

States and transitions:

1. `Closed` → `Queued`: create metadata and request activation.
2. `Queued` → `Opening`: cancel/supersede older pending activation and ask the
   worker to open the selected path.
3. `Opening` → `Active`: receive document metadata and retain the one live
   native document in the worker.
4. `Active` → `Suspending`: increment generation, reject later results for the
   previous generation, cancel queued renders, and request document close.
5. `Suspending` → `Background`: confirm document close; retain only lightweight
   tab metadata. The next selected tab may then open.
6. `Background` → `Queued`: activate it again using the saved path and view
   state, opening a fresh native document.
7. Any state → `Closing` → `Closed`: increment generation, invalidate all
   requests, close the document if active, clear tab-owned images and metadata.

Opening another tab first suspends the current active tab. The host does not
claim the next tab active until the worker acknowledges close and open. If a
close acknowledgement is lost because the worker exits, the supervisor waits
for process termination (which closes OS handles and releases the process
address space) before starting a replacement.

Paths may no longer exist or may refer to changed file contents when a
background tab is reopened. Reopen errors are surfaced to the UI while keeping
the tab's saved path and view state available for retry or close.

## Worker ownership, cleanup, and recovery

The separate worker process runs a synchronous protocol loop on its main OS
thread. That same thread initializes PDFium, opens at most one document, and
owns every PDFium library, document, page, bitmap, and rendering operation.
No PDFium call runs on the Tauri GUI thread, a Tauri async-runtime thread, or a
second worker thread. The host uses asynchronous sidecar I/O and async
channels to await replies; no GUI callback performs blocking reads, joins,
shutdown waits, or child-process waits. The worker drops per-render
bitmaps/pages after encoding each response and drops the document before
library shutdown. RAII and explicit close messages provide orderly cleanup;
Rust memory safety alone cannot prove native PDFium allocations are leak-free.

On normal tab deactivation, the host increments the generation, discards its
pending queue, and stops dispatching new requests before sending close. It
cannot cancel a render already executing inside PDFium: it waits for that one
reply asynchronously, discards it as stale, then sends close. The worker drops
the document and acknowledges close. On application shutdown, stop accepting work, invalidate generations,
send a framed shutdown message, and asynchronously await the worker's shutdown
acknowledgement and process-exit event for the 2-second grace period. If it
does not exit, request termination from the supervisor I/O task, asynchronously
await/reap process exit, and only
then complete app exit. Use Tauri's exit-request prevention to defer exit
while cleanup runs. Never block the GUI thread during shutdown.

On worker crash or protocol failure, the host invalidates all outstanding
request IDs and generations, clears pending image data, marks the active tab
as needing reopen, and starts a fresh worker only after the old child has
exited. It reopens only the currently selected path; background tabs remain
metadata. Retry policy must be bounded to avoid crash loops and must surface a
recoverable error. A hung native call cannot be safely cancelled in place;
the render timeout below causes the supervisor to terminate the child process.

## Render timeout and shutdown grace

The host has a configurable `render_timeout_ms` setting, exposed during
implementation as `PDFIUM_RENDER_TIMEOUT_MS`. Its provisional initial default
is 30,000 ms, with an accepted configuration range of 1,000–120,000 ms. This
deadline covers an admitted render from worker dispatch until a valid response
arrives; it is independent of and must never reuse the 2,000 ms
`worker_shutdown_grace_ms` used only for orderly application shutdown.

On render deadline expiry, invalidate the request and active generation, then
ask the worker supervisor to terminate the child. Process termination and
child-exit observation run on its dedicated I/O/supervision task (or blocking
worker thread), never on the GUI thread. Tauri commands await through async
channels; they do not synchronously wait, join, or poll. The old child must be
confirmed exited/reaped before a replacement starts. Return a structured
timeout error and discard late bytes. The shutdown grace timer applies only
after a framed shutdown request during app exit. Expiry triggers the same
off-GUI-thread termination path followed by asynchronous exit/reap
observation. No timeout or termination wait blocks GUI dispatch.

Tune the render deadline from measured dispatch-to-result latency, reported
separately from open, render, encode, and IPC durations. Use the fixed hashed
fixture corpus across supported PDF sizes/content types and record machine,
OS, crate/API/DLL tuple, sample count, and p50/p95/p99/max. Choose a default
above the observed tail latency plus a recorded margin while staying within
the product's maximum acceptable wait; validate the false-timeout/restart
rate under repeated runs. Keep 30 seconds provisional until those measurements
exist. If supported documents exceed the upper bound, document the limitation
or propose a separately reviewed design change; do not silently raise limits
or claim responsiveness from the configured value alone.

## Responsiveness

Tauri commands enqueue bounded work and await a reply asynchronously; they do
not execute PDFium on a Tauri command/runtime or GUI thread. The UI remains
responsive while open or render work is pending. The UI debounces zoom/scroll changes and
requests only the active viewport/page priority. A full-page render already
inside PDFium may not be preemptible, so latency must be measured and request
size capped. Rendering is initially bounded full-page rendering. Tiling,
multiple live documents, and extra renderer workers require benchmark evidence
and a separately reviewed architecture decision.


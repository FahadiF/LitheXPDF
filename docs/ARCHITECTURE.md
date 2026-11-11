# Architecture

## Milestone 1 implementation status

The current UI supports a tab strip and native multi-file picker. It keeps
lightweight path and view-position state for up to 100 tabs while the host
supervises exactly one active PDFium document. It includes page navigation,
per-tab zoom, rendering-mode settings, recent files, Windows current/all/range
printing, bookmarks, search, and theme controls. The worker protocol codec is shared in
`crates/pdfium-protocol`; only the worker links `pdfium-render`. UI/manual
WebView2 and packaged-install validation status is tracked in `docs/TESTING.md`.

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
The frontend owns tab view metadata and active-tab selection; the Rust host
owns request admission, queue limits, and worker lifetime. The child owns all
PDFium objects and native rendering. There is at most one worker and one open
PDFium document. Only the selected tab may occupy that document slot. Switching
tabs invalidates old frontend requests, acknowledges closure of the current
native document, opens the selected path, and restores that tab's page, zoom,
and scroll position.

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

From the repository root, build and package the worker and installer using the
provided scripts:

- **64-bit (x64):** `pnpm release:msi:x64` (builds worker for `x86_64-pc-windows-msvc`, stages worker and x64 `pdfium.dll`, and produces the x64 MSI).
- **32-bit (x86):** `pnpm release:msi:x86` (builds worker for `i686-pc-windows-msvc`, stages worker and x86 `pdfium.dll`, and produces the x86 MSI).

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

**Selected worker smoke-test runtime:** PDFium `157.0.8086.0` from official
release tag `chromium/8086` is staged at
`src-tauri/resources/pdfium/pdfium.dll`. `pdfium-render` is pinned to `=0.9.4`
in the worker only, with default features disabled and explicit
`pdfium_7881`, `image_025`, and `thread_safe` features. The 8086 release is
newer than the API feature's numbered baseline; a Windows subprocess test
successfully loaded this DLL through that binding, opened the deterministic
fixture, read its page count/dimensions, rendered page one, encoded a PNG, and
exited after dropping page/document objects. This verifies the exact exercised
path, not every PDFium API function or packaged execution.

The release archive SHA-256 reported by GitHub and independently computed
locally is
`1fd8af952832dbb0eb16d9249f68fe09e5f5ebf7c3dd9f6066ea2720cc28487d`; the
extracted DLL SHA-256 is
`1f2aee4286b8cf0413ab4562b7121aa454f9cfd9afd6ca8609bcef80927b3f80`. The
archive's actual `LICENSE` and all 17 files in `licenses/` were included,
verbatim, in `resources/pdfium/THIRD_PARTY_NOTICES.txt`. `dumpbin /DEPENDENTS`
reported `KERNEL32.dll`, `ADVAPI32.dll`, `GDI32.dll`, and `USER32.dll`; no
separate VC runtime DLL appeared in that import list. Clean-machine dependency
and packaged-load verification remain outstanding.

The active `src-tauri/tauri.conf.json` maps
`resources/pdfium/pdfium.dll` → `pdfium/pdfium.dll` and
`resources/pdfium/THIRD_PARTY_NOTICES.txt` →
`pdfium/THIRD_PARTY_NOTICES.txt`. The host resolves the DLL at startup from
`BaseDirectory::Resource` in packaged builds and from the host manifest's
`resources/pdfium/pdfium.dll` in development, canonicalizes the result, and
passes it as an independent sidecar argument. The worker is launched lazily
through `ShellExt::sidecar("pdfium-worker")` with raw stdout/stderr. The
target-triple-named sidecar configuration is unchanged. The mapping and code
compile, but packaged resource lookup and clean-machine execution remain
unverified.

## Windows default-PDF integration

The Windows MSI registers a LitheXPDF PDF ProgID, `RegisteredApplications`
capabilities, and an `Applications\lithexpdf-host.exe\SupportedTypes` entry
so Windows can list LitheXPDF as a user-selectable PDF app. The
installer must not change the user's current default. The first-run prompt and
Options action launch the registered-app Default Apps page through the Windows
Shell URI handler; the user confirms the `.pdf` association there. A PDF path
passed to the app at process startup is
forwarded to the existing single worker after the WebView is ready. The
settings checkbox controls whether the app repeats its reminder at each
startup; it does not claim to report or change Windows' selected default.

Explorer PDF thumbnails are not implemented. A Windows Shell thumbnail
provider runs outside the reader UI and cannot load PDFium directly without
creating a second native-PDF execution path. Do not add a nonfunctional
checkbox or a provider that bypasses the single-worker/single-document
boundary. Revisit this feature only with a separately reviewed design for
serialized thumbnail requests, worker lifetime, Shell process isolation,
cancellation, cache limits, and installation/uninstallation cleanup.

**Dependency selection:** only `crates/pdfium-worker` declares
`pdfium-render =0.9.4`, with `default-features = false` and explicit features
`pdfium_7881`, `image_025`, and `thread_safe`; direct `image =0.25.10` enables
only the PNG encoder feature. `Cargo.lock` records the resolved graph. The
Tauri host and frontend do not link or call PDFium. The worker smoke test
establishes this runtime/API pairing for the exercised open/page-metadata/
render calls. Broader API coverage, host resource lookup in a packaged
installation, and clean packaged execution remain unverified.

## Binary IPC framing

Host/worker transport is a duplex byte stream on sidecar stdin/stdout; stderr
is continuously drained as diagnostics. Use length-prefixed frames, never
line-delimited JSON. The host sends one command at a time; a two-permit pending
admission semaphore allows at most two queued renders plus the command
currently owning the operation lock. Queued cancellation marks the request so
it is rejected before it writes to the pipe. The worker runs synchronously on
its main OS thread. This keeps kernel pipe buffers from becoming an unbounded
work queue. Each frame has a 20-byte header: 4-byte ASCII magic `PDFW`, 2-byte
protocol version (unsigned big-endian, currently `2`), 2-byte message kind,
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

The Milestone 1 UI currently uses one document identity and one page index;
the multi-tab states below remain the design for later milestones and have no
tab-strip implementation yet.

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
bitmaps/pages after encoding each response and drops the active document on
CLOSE. `pdfium-render` is bound once and held for the worker lifetime because
its document API borrows the library; process shutdown unloads the library.
RAII and explicit close messages provide orderly cleanup;
Rust memory safety alone cannot prove native PDFium allocations are leak-free.

On normal tab deactivation, the host increments the generation, discards its
pending queue, and stops dispatching new requests before sending close. It
cannot cancel a render already executing inside PDFium: it waits for that one
reply asynchronously, discards it as stale, then sends close. The worker drops
the document and acknowledges close. On application shutdown, stop accepting
work, invalidate generations, send a framed shutdown message, and asynchronously
await the worker's shutdown acknowledgement and process-exit event for the
2-second grace period. If a native print dialog or another operation still
owns the operation lock after that grace, terminate the worker through the
supervisor's blocking process task and await exit/reap before completing app
exit. If a framed shutdown has already been sent, its 2-second acknowledgement
grace remains separate. Use Tauri's exit-request prevention to defer exit while
cleanup runs. Never block the GUI thread during shutdown.

On worker crash or protocol failure, the host fails all outstanding request
channels, clears the active document state on the next supervisor transition,
and does not reuse the worker. A later user open/retry starts a replacement
only after the old process is confirmed reaped. Restart attempts are capped
at three. The current tab UI does not automatically reopen the selected path after a
worker crash; switch away from and back to the selected tab to reopen it.
Automatic active-tab recovery remains unimplemented. A hung native call cannot be safely cancelled
in place; the render timeout below causes the supervisor to terminate the
child process.

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


## Continuous page view — 2026-11-08

The tabbed reader presents one lightweight DOM slot per page so the full
document retains a scroll extent. It requests a bounded full-page render for
the page nearest the viewport after a short scroll debounce. The default
Recommended mode also pre-renders up to 12 pages ahead, starting 250 ms after
the first image is installed; Light pre-renders 3 pages ahead, Maximum targets
up to 30, and On demand disables look-ahead. Successful renders are installed
as image elements in their real page slots, allowing warmed pages to appear in
the continuous scroll view without another render request. The cache keeps up
to two previous pages and is capped at 30 images, 64 MiB encoded PNG data, and
64 MiB estimated decoded RGBA data. Either byte cap can shorten the selected
window. Prefetch remains serial with a 16 ms scheduling gap; the worker renders
one page at a time.

Navigation cancels queued prefetch work and promotes a matching in-flight
render. A PDFium call already running cannot be preempted, so a visible request
may wait for it to finish. Inactive tabs retain metadata only, with no page
images or object URLs. Selecting On demand clears non-current images;
document replacement and close clear all image sources, element references,
and object URLs. The centered loader is used for initial open, and page
transitions retain the previous image until the next validated image is
available. This remains bounded full-page rendering; it does not pre-render or
retain every page of a long PDF. No speed or memory improvement is claimed
without benchmarks. The five-slot DOM experiment was reverted because it cut
off full-document navigation. Runtime UI verification and memory measurement
remain pending.

## Reader controls and persistent preferences — 2026-11-08

The toolbar accepts a one-based page number between 1 and the active
document's page count. It validates the range before navigating; Previous and
Next remain available and the current page field follows viewport scrolling.

Bookmarks are separate UI metadata, not part of the PDFium document state.
The frontend stores page number and a short label in WebView local storage,
keyed by SHA-256 of the normalized document path. This avoids writing the raw
path into the storage key but is not encryption or a security boundary. A
bookmark does not retain a page object or image.

The dark/light theme preference is stored locally in the WebView. It changes
CSS presentation only and does not alter PDF rendering, worker state, or
document contents.

Text search is implemented in the PDFium worker on its single owner thread.
The host sends a bounded SEARCH frame and validates the correlated
SEARCH_RESULTS frame before returning small JSON metadata to the frontend.
The worker scans pages serially, returns at most 250 results with excerpts no
longer than 128 UTF-8 bytes, and rejects queries above 512 UTF-8 bytes. The
host applies a 30-second search deadline; a timeout follows worker
termination/reap recovery. Search result sequence, document ID, and generation
checks discard late results. Search cannot interrupt an in-progress native
PDFium call. Image-only/scanned pages have no searchable text unless a PDF
already contains an OCR text layer; OCR is not implemented.

Automated tests cover page entry, bookmark save/list/navigation, theme
preference, worker search framing and fixture results, malformed search
metadata, and stale document results. The desktop WebView2 appearance and
manual feature behavior remain to be confirmed. No memory or performance
improvement is claimed.

## Native Windows printing — 2026-11-09

Printing is a Windows-only worker operation. The asynchronous Tauri `print_pdf`
command supplies the current document identity, generation, page index, page
selection, and owner window handle to the host. The host validates the active
generation and selected pages, then sends one bounded `PRINT` frame. LitheXPDF
first displays its branded page-selection dialog, which shows the document's
total page count and validates the maximum page number for a range. Users can
choose the current page, all pages, or one inclusive page range. A job may
contain at most 10,000 pages; the all-pages option is unavailable for larger
documents, which can still be printed in smaller ranges. The worker then opens
the native Windows print property sheet for installed-printer selection and
printer-driver settings. The native dialog's page-selection controls are
disabled so they cannot replace the LitheXPDF selection. Paper size,
orientation, and other options vary by printer and driver.

After confirmation, the worker renders each selected page on its sole PDFium
owner thread and transfers it directly to the selected printer DC through
GDI. It renders one bounded bitmap at a time, using the existing 8,192-pixel
dimension, 8,388,608-pixel, and 32 MiB RGBA limits. A job is limited to 10,000
pages. Page images are not sent through the frontend or returned over IPC;
`PRINT_RESULT` contains only document identity, cancellation status, and the
number of pages sent to the printer. A print request is serialized with other
PDFium operations and does not use the render timeout because its native dialog
waits for user input. If app exit is requested while that operation is still
active, shutdown waits asynchronously for the operation lock for up to the
separate 2-second shutdown grace, then terminates and reaps the worker.

Compilation verifies the host and worker call path, but LitheXPDF page-range
selection, printer selection, paper settings, printer output, and shutdown
during printing still require manual Windows desktop verification. No print
reliability, performance, or memory improvement is claimed before those
checks.

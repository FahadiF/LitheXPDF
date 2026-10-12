# ADR 0002: One active document and lightweight background tabs

- Status: Accepted
- Date: 2026-10-12

## Context

The application targets 30 or more open tabs. Keeping every PDFium document
open would retain native document state and decoded resources for inactive
tabs. Native PDFium allocations are outside Rust's ownership guarantees, and
closing a document is not a promise that Windows immediately reduces working
set.

## Decision

Keep tab metadata in the host and allow only one active PDFium document in the
worker. A background tab stores only document path, page index, zoom, scroll
position, tab ID, and generation. Switching tabs increments the old tab's
generation, invalidates queued and returned renders, closes its document, and
only then opens the newly selected path. Reopening a background tab creates a
new native document and restores the saved view position.

Closing or deactivating a tab increments generation before cleanup, purges the
host's queued work and all encoded/decoded images, and prevents new dispatch.
The one render already executing in PDFium is not cancellable: wait for its
reply asynchronously, reject it as stale, then close the native document and
remove tab metadata only after cleanup completes or the worker process has
been reaped. On app exit, stop admission, invalidate work, close the document,
shut down the worker, and wait asynchronously for at most the separate
2,000 ms worker shutdown grace; then request child termination and
asynchronously await/reap its exit. This grace is not a render timeout.

The worker process is the native-resource recovery boundary. A crash or
render exceeding the configurable 30,000 ms provisional `render_timeout_ms`
(environment override `PDFIUM_RENDER_TIMEOUT_MS`, valid range 1,000–120,000
ms) invalidates all requests, terminates and reaps the child, then starts a
replacement with no document. The render timer starts at worker dispatch. The
host may reopen only the currently selected tab. Background tabs remain
metadata. Retry count is bounded and errors are visible. Tune the default
from measured p50/p95/p99/max latency and false-timeout/restart rates over the
fixed corpus and supported hardware. No timeout or process-exit wait may block
the GUI thread; the supervisor handles termination/reaping off-thread and the
host awaits asynchronously.

## Consequences

- Inactive tabs use metadata rather than live PDFium documents and full-page
  bitmaps or encoded/decoded page images.
- Switching tabs requires reopen work and may add latency; measure it.
- A current native render may finish before an orderly close because PDFium
  calls may not be interruptible.
- Terminating the worker is a hard fallback for reclaiming all of that
  process's address space, but must be tested for handle and restart behavior.
- Binary protocol framing, maximum lengths, queued-versus-active cancellation,
  stale-result rejection, image-reference cleanup, and worker termination and
  restart are explicit test obligations in `docs/TESTING.md`.
- Private bytes and working set are measured separately. A close acknowledgement
  alone does not demonstrate reduced process memory.


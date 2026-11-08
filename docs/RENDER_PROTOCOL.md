# Render protocol

## Request

Every frontend request identifies a tab and a particular activation of that
tab. The host assigns a monotonically increasing document generation and a
unique 64-bit worker request ID. The frontend also supplies a random
cancellation token to `render_page`; it is only a host-side queue cancellation
key and is not reused as the binary protocol request ID. A request contains:

```text
protocol_version
request_id
tab_id
generation
page_index              # zero-based
zoom                     # finite and range-checked
target_width_px
target_height_px
priority                 # active viewport before prefetch
```

Paths are sent only in backend activation/open commands, never in a render
request from the browser. The worker's open state binds the active tab ID and
generation to one document. The host validates every field, active-tab
ownership, page bounds, zoom range, pixel cap, queue depth, and protocol
version before dispatch. It rejects an invalid or over-limit request without
allocating a bitmap.

## Result

Every successful result echoes `request_id`, `tab_id`, and `generation`, and
contains page index, pixel dimensions, content type, and encoded image bytes.
Every failure includes those identifiers plus a stable error code. Never
return a raw pointer, PDFium object, or unbounded allocation to TypeScript.

## Host/worker binary framing

Host and worker exchange frames over the sidecar's stdin/stdout byte streams;
stderr is reserved for diagnostics. Each frame is a 20-byte header followed
by its payload:

| Offset | Size | Field | Encoding |
| ---: | ---: | --- | --- |
| 0 | 4 | Magic `PDFW` | ASCII bytes |
| 4 | 2 | Protocol version (`1`) | unsigned big-endian |
| 6 | 2 | Message kind | unsigned big-endian enum |
| 8 | 8 | Request ID | unsigned big-endian |
| 16 | 4 | Payload length | unsigned big-endian byte count |
| 20 | length | Payload | Kind-specific binary fields |

Message kinds are `OPEN=0x0001`, `RENDER=0x0002`, `CLOSE=0x0003`,
`SHUTDOWN=0x0004`, `SEARCH=0x0005`, `READY=0x8001`, `ACK=0x8002`,
`PAGE=0x8003`, `SEARCH_RESULTS=0x8004`, and `ERROR=0x80ff`. `READY` is the
first worker frame and uses request ID zero;
all other request/reply frames use the originating nonzero request ID.
`OPEN` payload is tab ID (16 bytes), generation (u64), UTF-8 path length
(u32), then exactly that many path bytes. `RENDER` payload is tab ID (16),
generation (u64), page index (u32), zoom as IEEE-754 binary64, width/height
(u32 each), priority (u8), and three reserved zero bytes. `CLOSE` payload is
tab ID (16) and generation (u64); `SHUTDOWN` has an empty payload. All
multi-byte fields use network byte order (big-endian). `READY` has an empty
payload. `ACK` is contextual: OPEN returns tab ID (16), generation (u64), page
count (u32), and first-page width/height in points (IEEE-754 binary64 each),
exactly 44 bytes; CLOSE echoes its 24-byte tab ID and generation payload;
SHUTDOWN returns an empty payload. `ERROR` contains a stable u16 code, UTF-8
diagnostic length as u16, then diagnostic bytes capped at 4 KiB. ERROR request
IDs correlate with the command that failed.

`SEARCH` carries tab ID (16 bytes), generation (u64), flags (u8), query length
(u16), and exactly that many UTF-8 query bytes. Flag bit 0 requests a
case-sensitive match and bit 1 requests a whole-word match; all other bits
must be zero. Queries must contain 1–512 UTF-8 bytes and non-whitespace text.
`SEARCH_RESULTS` carries tab ID (16), generation (u64), result count (u16), a
truncated flag (u8), one reserved zero byte, then `count` entries. Each entry
contains a zero-based page index (u32), excerpt length (u16), and UTF-8 excerpt
of 1–128 bytes. There may be at most 250 results, and the complete response
must fit the 64 KiB control-payload cap. Results are emitted in document page
order and worker search runs serially on the PDFium owner thread. Both message
kinds use the original nonzero request ID for correlation; failures use the
normal bounded `ERROR` shape.

Render/open/control requests and non-image responses have a maximum 64 KiB
payload. A `PAGE` response contains 42 bytes of fixed metadata (tab ID as 16
bytes, generation as u64, page index/width/height as u32, PNG content type as
u16 with value `1`, and encoded image length as u32) followed by encoded image
bytes. Metadata may not
exceed 4 KiB; encoded image bytes may not exceed 32 MiB. Validate the declared
frame length against the kind-specific cap before allocating. Read exactly
the declared payload; pipe chunk boundaries have no protocol meaning. Validate
all fixed-size fields and require the payload length to equal the exact fields
plus `encoded image length`.

Reject bad magic, unsupported version, unknown kind, invalid identifiers,
overflowing/over-limit lengths, invalid dimensions, truncated frames,
malformed fields, and duplicate/unexpected request IDs. Do not parse partial
data as a new frame or allocate from an unchecked length. Fail the request;
for framing corruption terminate/reap and restart the worker rather than
trying to resynchronize the byte stream. Both endpoints enforce the same
limits.

## Rust-to-WebView binary response

Render is an async Tauri command. It returns the bounded binary render-result
frame with `tauri::ipc::Response::new(Vec<u8>)`; Tauri's raw IPC response is
received by `invoke()` as an `ArrayBuffer`. TypeScript parses and validates
the frame before creating a `Blob`/object URL. Small status and lifecycle
metadata may use JSON commands/events. Image payloads must never be returned
as JSON arrays, base64 strings, or JSON events. This path is documented by
Tauri and still requires a WebView2 smoke test at the configured size cap.

Text search uses an async `search_text` Tauri command and returns only the
bounded result metadata as JSON; it does not return image data. The host checks
the active document identity and generation before and after the worker
operation. The frontend additionally limits results to 250, validates page
indexes, and caps each excerpt at 128 UTF-8 bytes before creating result rows.
The provisional search deadline is 30 seconds, separate from the configurable
render deadline and the 2-second shutdown grace. Search results cannot cancel
a native call already in progress; superseded query and document results are
discarded by sequence, identity, and generation checks. Scanned-image pages
without an existing text layer are not searchable; OCR is outside this scope.

The host accepts a result only if its request ID is still registered with the
expected reply kind and the active document still has the same identity and
generation. The frontend repeats the identity, generation, page, dimensions,
PNG signature, frame length, and nonzero request ID checks before displaying
it. Any mismatch is stale: discard bytes and release
references immediately. This double-check makes a delayed Tauri response harmless
after a tab switch or close.

## Scheduling, cancellation, and ordering

The host limits the queue to two pending requests and one in-flight render.
New active viewport requests supersede queued requests for the same tab/page
and lower-priority prefetch. Activation, deactivation, close, and worker
restart increment generation before sending more work. `cancel_render` marks
a queued request token; the command checks it before writing a frame.
Cancellation cannot interrupt a native call already executing inside PDFium;
it awaits that response and discards it against the cancellation token and
generation. The host may terminate a timed-out worker process.

## Render deadline and shutdown deadline

The host configuration has `render_timeout_ms` (environment override
`PDFIUM_RENDER_TIMEOUT_MS`), initially 30,000 ms with a validated range of
1,000–120,000 ms. It measures from dispatch to a validated render response,
not from enqueue. On expiry, invalidate the request and active generation,
return a structured timeout error, and ask the supervisor to terminate the
worker. The termination request and child-exit/reap observation run on the
worker supervisor's I/O task or a dedicated blocking thread. The Tauri command
awaits asynchronously; neither timeout handling nor child-process waiting may
block the GUI thread. Do not start a replacement worker until the old child is
confirmed exited.

This render deadline is separate from `worker_shutdown_grace_ms`, which is
2,000 ms and starts only after the app sends a framed shutdown request. Its
expiry requests termination through the same off-GUI-thread supervisor and
then awaits process exit asynchronously. Do not reuse the shutdown grace as a
render timeout or start it when a tab is merely switched.

Tune the provisional render default from repeated dispatch-to-result latency
measurements (including p50/p95/p99/max, open/render/encode/IPC splits,
false-timeout and restart rates) over the fixed fixture corpus and supported
hardware. Choose a measured tail plus recorded margin that remains below the
product's maximum acceptable wait. Configuration alone is not evidence of
responsiveness or a memory reduction.

Render output ordering is not relied upon. Request IDs correlate responses;
generation checks determine whether output is still usable. A worker restart
invalidates all outstanding IDs. The host rejects duplicate, malformed,
wrong-version, and oversized responses.

## Image lifetime

Render a full page only, with width and height each at most 8,192 px, at most
8,388,608 total pixels, and at most 32 MiB RGBA. Encode through a bounded
writer with a hard 32 MiB output cap. If the cap is exceeded, abort encoding,
discard partial output, and return `IMAGE_TOO_LARGE`; do not retry at a larger
size or stream an unbounded response. Keep at most one result awaiting the
frontend. The frontend may retain at most two validated encoded page responses,
with a 16 MiB total cap, for the active document. A response above that cap is
displayed only when directly requested and is not cached. After one second of
idle time, only the immediately following page may be prefetched. On document
replacement or close, clear all cached bytes and decoded WebView image
references, clear the image source, and revoke its object URL. Inactive
background tabs retain no encoded or decoded page images. Never store image
data in tab metadata or persist it to disk.

The initial renderer is bounded full-page rendering. Do not add tile/partial
rendering, multiple live documents, or additional renderer workers without
benchmark evidence and a separately reviewed architecture change.

## Future protocol evolution

Use explicit versioning and reject unsupported versions. Any future streaming,
partial-tile, or multiple-document protocol requires a new reviewed decision;
it must preserve bounded buffering and the one-document limit until measured
evidence supports changing them.

